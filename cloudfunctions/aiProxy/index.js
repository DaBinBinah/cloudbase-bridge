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
 *     model: string,                  // e.g. "hy3"
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
 *   { error: { code, message, requestId? } }
 *   Codes: INVALID_REQUEST, IMAGE_INPUT_NOT_SUPPORTED, MODEL_NOT_ALLOWED,
 *   AI_CHANNEL_NOT_ALLOWED, AI_MODEL_NOT_SUPPORTED, EXCEED_TOKEN_QUOTA_LIMIT,
 *   TCB_ENV_MISSING, UPSTREAM_ERROR — mapped to HTTP statuses by the plugin.
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

/** Allowlist of callable models. Defaults to the superset used by the
 * plugin catalog: the three models confirmed by the official growth-plan
 * notice (checked 2026-11-09, https://docs.cloudbase.net/ai/ai-inspire-plan-new-models)
 * plus the two legacy ids carried over from the predecessor project.
 * Override with the AI_PROXY_ALLOWED_MODELS env var (comma-separated). */
const DEFAULT_ALLOWED_MODELS = [
  "hy3",
  "hy4",
  "hy4-preview",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
];

const MAX_MESSAGES = 128;
const MAX_SINGLE_MESSAGE_CHARS = 200_000;
const MAX_TOTAL_MESSAGE_CHARS = 400_000;
const MAX_MODEL_ID_LENGTH = 64;
const AI_PROXY_VERSION = "1.0.0";

/** Group name for the managed model pool — required by the official
 * growth-plan notice ("createModel 的参数改为 cloudbase"). The concrete
 * model id goes into the `model` field of generateText. */
const AI_MODEL_GROUP = "cloudbase";

/* ------------------------------------------------------------------ *
 * Error envelope.                                                    *
 * ------------------------------------------------------------------ */

function errorEnvelope(code, message, requestId) {
  const error = { code, message };
  if (requestId) error.requestId = requestId;
  return { error };
}

function safeErrorMessage(err) {
  let message = "(no message)";
  if (err && typeof err.message === "string" && err.message.length > 0) {
    message = err.message;
  } else if (typeof err === "string" && err.length > 0) {
    message = err;
  }
  // Never echo secrets (none should be present) and keep it bounded.
  return message.length > 300 ? message.slice(0, 300) + "…" : message;
}

function pickUpstreamCode(err) {
  if (err && typeof err.code === "string" && err.code.length > 0) return err.code;
  if (err && err.err && typeof err.err.code === "string") return err.err.code;
  return null;
}

/* ------------------------------------------------------------------ *
 * Model allowlist.                                                   *
 * ------------------------------------------------------------------ */

function allowedModels() {
  const raw = process.env.AI_PROXY_ALLOWED_MODELS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return DEFAULT_ALLOWED_MODELS.slice();
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_MODELS.slice();
}

/* ------------------------------------------------------------------ *
 * Request validation (pure functions, unit-tested via _internal).    *
 * ------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

/**
 * Normalize one OpenAI-style message to the documented generateText input
 * shape { role, content: string }. Text array parts are concatenated;
 * anything else (images, tool calls, unknown roles) is rejected with a
 * diagnostic error code.
 */
function normalizeMessage(message, index) {
  if (!isPlainObject(message)) {
    return errorEnvelope("INVALID_REQUEST", `messages[${index}] must be an object.`);
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (!ALLOWED_ROLES.has(role)) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}].role "${role.slice(0, 24)}" is not supported. Supported roles: system, user, assistant (tool calls are not supported by this proxy yet).`,
      );
  }
  const content = message.content;
  if (typeof content === "string") {
    if (content.length > MAX_SINGLE_MESSAGE_CHARS) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `messages[${index}] is too large (${content.length} chars; limit ${MAX_SINGLE_MESSAGE_CHARS}).`,
        );
    }
    return { message: { role, content } };
  }
  if (Array.isArray(content)) {
    // OpenAI multimodal array: keep text parts, refuse images/files.
    const textParts = [];
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex];
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
        continue;
      }
      const partType = isPlainObject(part) && typeof part.type === "string" ? part.type : "unknown";
      return errorEnvelope(
          "IMAGE_INPUT_NOT_SUPPORTED",
          `messages[${index}].content[${partIndex}] has type "${partType.slice(0, 24)}". This proxy supports text only (the Node SDK channel used here documents string content; image input is not forwarded).`,
        );
    }
    const joined = textParts.join("\n");
    if (joined.length > MAX_SINGLE_MESSAGE_CHARS) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `messages[${index}] is too large (${joined.length} chars; limit ${MAX_SINGLE_MESSAGE_CHARS}).`,
        );
    }
    return { message: { role, content: joined } };
  }
  return errorEnvelope(
      "INVALID_REQUEST",
      `messages[${index}].content must be a string or an array of text parts.`,
    );
}

/**
 * Validate and normalize the "chat" event. Returns
 * { params } on success or { error } on failure.
 */
function validateChatEvent(event) {
  if (!isPlainObject(event)) {
    return errorEnvelope("INVALID_REQUEST", "Event must be a JSON object.");
  }
  const model = typeof event.model === "string" ? event.model.trim() : "";
  if (model.length === 0 || model.length > MAX_MODEL_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(model)) {
    return errorEnvelope("INVALID_REQUEST", "event.model must be a non-empty model id (letters, digits, . _ -).");
  }
  if (!Array.isArray(event.messages) || event.messages.length === 0) {
    return errorEnvelope("INVALID_REQUEST", "event.messages must be a non-empty array.");
  }
  if (event.messages.length > MAX_MESSAGES) {
    return errorEnvelope("INVALID_REQUEST", `Too many messages (${event.messages.length}; limit ${MAX_MESSAGES}).`);
  }

  const messages = [];
  let totalChars = 0;
  for (let index = 0; index < event.messages.length; index += 1) {
    const result = normalizeMessage(event.messages[index], index);
    if (result.error) return { error: result.error };
    const normalized = result.message;
    totalChars += normalized.content.length;
    if (totalChars > MAX_TOTAL_MESSAGE_CHARS) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `Conversation too large (${totalChars} chars; limit ${MAX_TOTAL_MESSAGE_CHARS}). Trim the history.`,
        );
    }
    messages.push(normalized);
  }

  const params = { model, messages };
  if (typeof event.temperature === "number" && Number.isFinite(event.temperature)) {
    if (event.temperature < 0 || event.temperature > 2) {
      return errorEnvelope("INVALID_REQUEST", "event.temperature must be between 0 and 2.");
    }
    params.temperature = event.temperature;
  }
  if (typeof event.topP === "number" && Number.isFinite(event.topP)) {
    if (event.topP <= 0 || event.topP > 1) {
      return errorEnvelope("INVALID_REQUEST", "event.topP must be in (0, 1].");
    }
    params.topP = event.topP;
  }

  const allowList = allowedModels();
  if (!allowList.includes(model)) {
    return errorEnvelope(
        "MODEL_NOT_ALLOWED",
        `Model "${model}" is not in the aiProxy allowlist (code AI_MODEL_NOT_SUPPORTED). Allowed models: ${allowList.join(", ")}. Adjust AI_PROXY_ALLOWED_MODELS if your environment supports more.`,
      );
  }
  return { params };
}

/* ------------------------------------------------------------------ *
 * Response builders.                                                 *
 * ------------------------------------------------------------------ */

function newCompletionId() {
  return "chatcmpl-" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function normalizeUsage(usage) {
  const toInt = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
  const promptTokens = toInt(usage && usage.prompt_tokens);
  const completionTokens = toInt(usage && usage.completion_tokens);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: toInt(usage && usage.total_tokens) || promptTokens + completionTokens,
  };
}

/**
 * Map the documented @cloudbase/node-sdk generateText result
 * ({ text, messages, usage, rawResponses, error? }) to an OpenAI Chat
 * Completions object. Pure; unit-tested via _internal.
 */
function buildChatCompletion(result, model, requestId) {
  const text = result && typeof result.text === "string" ? result.text : "";
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: normalizeUsage(result && result.usage),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

function pingResult() {
  return {
    ok: true,
    service: "aiProxy",
    version: AI_PROXY_VERSION,
    env: process.env.TCB_ENV || null,
    models: allowedModels(),
    timestamp: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * CloudBase SDK wiring (lazy, so unit tests can inject callModel).   *
 * ------------------------------------------------------------------ */

let sdkModule = null;
let app = null;
let chatModel = null;

function loadSdk() {
  if (sdkModule) return sdkModule;
  try {
    sdkModule = require("@cloudbase/node-sdk");
  } catch (err) {
    throw new Error(
      "The @cloudbase/node-sdk dependency is missing. Deploy with installDependency enabled (cloudbaserc) or upload node_modules with the function code.",
    );
  }
  return sdkModule;
}

function getApp() {
  if (app) return app;
  const tcb = loadSdk();
  const envId = process.env.TCB_ENV;
  if (!envId) {
    const missing = new Error(
      "TCB_ENV is not set. The CloudBase runtime normally injects it; add it to the function environment variables if you run this outside CloudBase.",
    );
    missing.code = "TCB_ENV_MISSING";
    throw missing;
  }
  app = tcb.init({ env: envId });
  return app;
}

function getChatModel() {
  if (chatModel) return chatModel;
  const ai = getApp().ai();
  // Group "cloudbase" per the official growth-plan notice; the concrete id
  // (e.g. "hy3") is passed in the `model` field of generateText below.
  chatModel = ai.createModel(AI_MODEL_GROUP);
  return chatModel;
}

/**
 * Perform the model call with @cloudbase/node-sdk. Tests can inject a fake
 * via `exports._callModelOverride` (never used in production deployments).
 */
async function callModel(params, requestId) {
  if (typeof exports._callModelOverride === "function") {
    return exports._callModelOverride(params, requestId);
  }
  try {
    const result = await getChatModel().generateText({
      model: params.model,
      messages: params.messages,
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.topP === "number" ? { topP: params.topP } : {}),
    });
    if (result && result.error) {
      const code = pickUpstreamCode(result.error) || "UPSTREAM_ERROR";
      return errorEnvelope(code, safeErrorMessage(result.error), requestId);
    }
    return { completion: buildChatCompletion(result, params.model, requestId) };
  } catch (err) {
    const code = pickUpstreamCode(err);
    if (code) {
      return errorEnvelope(code, safeErrorMessage(err), requestId);
    }
    return errorEnvelope("UPSTREAM_ERROR", safeErrorMessage(err), requestId);
  }
}

/* ------------------------------------------------------------------ *
 * Entry point.                                                       *
 * ------------------------------------------------------------------ */

exports.main = async (event, context) => {
  const requestId =
    context && typeof context === "object"
      ? (typeof context.request_id === "string" && context.request_id) ||
        (typeof context.requestId === "string" && context.requestId) ||
        undefined
      : undefined;
  try {
    const action = isPlainObject(event) && event.action === "ping" ? "ping" : "chat";
    if (action === "ping") {
      return pingResult();
    }
    const validated = validateChatEvent(event);
    if (validated.error) {
      return { error: validated.error };
    }
    const outcome = await callModel(validated.params, requestId);
    if (outcome.error) {
      return { error: outcome.error };
    }
    return outcome.completion;
  } catch (err) {
    const code = pickUpstreamCode(err) || (err && err.code) || "UPSTREAM_ERROR";
    return errorEnvelope(code, safeErrorMessage(err), requestId);
  }
};

/**
 * Test surface (pure helpers + injectable callModel). Exported as an
 * object so hosts never treat it as a second plugin/entry.
 */
exports._internal = {
  AI_PROXY_VERSION,
  AI_MODEL_GROUP,
  DEFAULT_ALLOWED_MODELS,
  MAX_MESSAGES,
  MAX_SINGLE_MESSAGE_CHARS,
  MAX_TOTAL_MESSAGE_CHARS,
  allowedModels,
  validateChatEvent,
  normalizeMessage,
  buildChatCompletion,
  normalizeUsage,
  errorEnvelope,
  pingResult,
  safeErrorMessage,
  pickUpstreamCode,
};
