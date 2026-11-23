/**
 * aiProxy — CloudBase Event Function (普通云函数, entry: index.main).
 *
 * Bridges the CloudBase "小程序成长计划" AI models (which can only be spent
 * from CloudBase SDK channels; direct `/v1/ai/*` HTTP calls are rejected with
 * AI_CHANNEL_NOT_ALLOWED) into an OpenAI Chat Completions compatible JSON
 * reply that the CloudBase Bridge plugin can consume.
 *
 * Event contract (sent by the plugin as the invocation body):
 *   { action?: "chat" | "ping",       // default "chat"
 *     model?: string,                 // e.g. "hy3"; defaults to deepseek-v4.1-flash
 *     messages: [{ role, content }],  // roles: system | user | assistant
 *     temperature?: number,           // 0..2
 *     topP?: number }                 // 0..1
 *
 * Reply on success (HTTP 200 body = this return value, per the functions
 * OpenAPI — there is no wrapper envelope):
 *   { id, object: "chat.completion", created, model,
 *     choices: [{ index, message: { role, content }, finish_reason }],
 *     usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * Reply on failure:
 *   { error: { code, message, type: "cloudbase_function_error" } }
 *   Codes: INVALID_REQUEST, MODEL_NOT_ALLOWED, CONFIG_ERROR,
 *   AI_CHANNEL_NOT_ALLOWED, AI_MODEL_NOT_SUPPORTED, EXCEED_TOKEN_QUOTA_LIMIT,
 *   UPSTREAM_ERROR — mapped to HTTP statuses by the plugin.
 *
 * Deployment notes:
 * - Runtime: Node.js (Nodejs18.15 or newer). Dependencies are installed by
 *   the platform from package.json (`installDependency: true`) or shipped in
 *   the upload zip.
 * - The environment id is read from TCB_ENV, which the CloudBase function
 *   runtime injects automatically. No personal environment id is hard-coded.
 * - Set the function timeout to 120 s (AI text generation is slow).
 * - Never put an API Key in this function: the model channel is
 *   authenticated by the environment itself.
 */

"use strict";

const tcb = require("@cloudbase/node-sdk");

// ==================== 配置 ====================

const VERSION = "1.2.2";

const DEFAULT_MODEL = "deepseek-v4.1-flash";

/** Allowlist of callable models. Defaults to the superset used by the
 * plugin catalog: the three models confirmed by the official growth-plan
 * notice (checked 2026-11-09, https://docs.cloudbase.net/ai/ai-inspire-plan-new-models),
 * plus `deepseek-v4.1-flash-1017` (verified through this proxy in my own
 * environment, 2026-11; not in the official notice) and the unverified
 * `hy4`. CloudBase itself rejects unsupported ids with
 * AI_MODEL_NOT_SUPPORTED. Override with the AI_PROXY_ALLOWED_MODELS env var
 * (comma-separated). */
const DEFAULT_ALLOWED_MODELS = [
  "hy4-flash",
  "hy4",
  "hy4-preview",
  "hy3",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

// 模型参数范围
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;
const TOP_P_MIN = 0;
const TOP_P_MAX = 1;

// ==================== CloudBase 初始化 ====================

let app;

function getApp() {
  if (!app) {
    const env = process.env.TCB_ENV;

    if (!env) {
      throw createError("CONFIG_ERROR", "请先在云函数环境变量中设置 TCB_ENV");
    }

    app = tcb.init({
      env,
      timeout: 120000,
    });
  }

  return app;
}

// ==================== 错误处理 ====================

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorResponse(error) {
  const code = error?.code || "UPSTREAM_ERROR";

  // 对外隐藏内部异常详情
  const isClientError = ["INVALID_REQUEST", "MODEL_NOT_ALLOWED", "CONFIG_ERROR"].includes(code);

  return {
    error: {
      code,
      message: isClientError ? error.message : "AI 模型调用失败，请稍后重试",
      type: "cloudbase_function_error",
    },
  };
}

// ==================== 模型白名单 ====================

function getAllowedModels() {
  const raw = process.env.AI_PROXY_ALLOWED_MODELS;

  if (typeof raw === "string" && raw.trim()) {
    const models = [
      ...new Set(
        raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];

    if (models.length > 0) {
      return models;
    }
  }

  return [...DEFAULT_ALLOWED_MODELS];
}

function getModelId(model) {
  return model.replace(/^(cloudbase-plugin|cloudbase)\//, "");
}

// ==================== 参数校验 ====================

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw createError("INVALID_REQUEST", "请求参数必须是对象");
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw createError("INVALID_REQUEST", "messages 必须是非空数组");
  }

  for (const item of messages) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.role !== "string" ||
      !item.role.trim()
    ) {
      throw createError("INVALID_REQUEST", "messages 中存在无效消息");
    }

    const validContent = typeof item.content === "string" || Array.isArray(item.content);

    if (!validContent) {
      throw createError("INVALID_REQUEST", "message.content 必须是字符串或数组");
    }
  }
}

function validateNumber(value, name, min, max) {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw createError("INVALID_REQUEST", `${name} 必须是 ${min} 到 ${max} 之间的有效数字`);
  }
}

// ==================== OpenAI 响应格式 ====================

function createCompletionResponse(modelId, result) {
  const now = Date.now();
  const usage = result?.usage || {};

  function getTokenCount(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  const promptTokens = getTokenCount(usage.prompt_tokens);
  const completionTokens = getTokenCount(usage.completion_tokens);

  return {
    id: `chatcmpl-${now}`,
    object: "chat.completion",
    created: Math.floor(now / 1000),
    model: modelId,

    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: typeof result?.text === "string" ? result.text : "",
        },
        finish_reason: "stop",
      },
    ],

    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: getTokenCount(usage.total_tokens) || promptTokens + completionTokens,
    },
  };
}

// ==================== 云函数入口 ====================

exports.main = async (event = {}) => {
  try {
    // 1. 请求参数检查
    validateEvent(event);

    // 2. 部署探测
    if (event.action === "ping") {
      return {
        ok: true,
        service: "aiProxy",
        version: VERSION,
        models: getAllowedModels(),
        timestamp: new Date().toISOString(),
      };
    }

    // 3. 模型检查
    if (event.model !== undefined && typeof event.model !== "string") {
      throw createError("INVALID_REQUEST", "model 必须是字符串");
    }

    const requestedModel = event.model?.trim() || DEFAULT_MODEL;

    const modelId = getModelId(requestedModel);

    const allowedModels = new Set(getAllowedModels());

    if (!allowedModels.has(modelId)) {
      throw createError(
        "MODEL_NOT_ALLOWED",
        `不支持的模型：${requestedModel}，可用模型：${[...allowedModels].join(", ")}`,
      );
    }

    // 4. 消息检查（不限制数量和大小）
    const messages = event.messages;

    validateMessages(messages);

    // 5. 模型参数检查
    validateNumber(event.temperature, "temperature", TEMPERATURE_MIN, TEMPERATURE_MAX);

    validateNumber(event.topP, "topP", TOP_P_MIN, TOP_P_MAX);

    // 6. 构建请求参数
    const params = {
      model: modelId,
      messages,
    };

    if (event.temperature !== undefined) {
      params.temperature = event.temperature;
    }

    if (event.topP !== undefined) {
      params.topP = event.topP;
    }

    // 7. 调用 CloudBase AI
    const result = await getApp().ai().createModel("cloudbase").generateText(params);

    // 8. 返回 OpenAI 兼容格式
    return createCompletionResponse(modelId, result);
  } catch (error) {
    console.error("[AI Proxy Error]", {
      code: error?.code || "UPSTREAM_ERROR",
    });

    return errorResponse(error);
  }
};

/**
 * Test surface (pure helpers + injectable SDK call). Exported as an object
 * so hosts never treat it as a second plugin/entry.
 */
exports._internal = {
  VERSION,
  AI_MODEL_GROUP: "cloudbase",
  DEFAULT_MODEL,
  DEFAULT_ALLOWED_MODELS,
  TEMPERATURE_MIN,
  TEMPERATURE_MAX,
  TOP_P_MIN,
  TOP_P_MAX,
  getAllowedModels,
  getModelId,
  validateEvent,
  validateMessages,
  validateNumber,
  createCompletionResponse,
  createError,
  errorResponse,
};
