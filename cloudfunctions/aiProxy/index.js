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
 *     messages: [{ role, content }],  // roles: system | user | assistant | tool
 *                                     // (assistant may carry tool_calls,
 *                                     //  tool carries tool_call_id; user
 *                                     //  content may be an array with
 *                                     //  text and image_url parts)
 *     temperature?: number,           // 0..2
 *     topP?: number,                  // 0..1
 *     maxTokens?: number,             // positive integer
 *     tools?: [{ type: "function", function: { name, description?, parameters? } }],
 *     toolChoice?: "auto" | "none" | "required" | { type: "function", function: { name } } }
 *
 * Reply on success (HTTP 200 body = this return value, per the functions
 * OpenAPI — there is no wrapper envelope):
 *   { id, object: "chat.completion", created, model,
 *     choices: [{ index, message: { role, content, reasoning_content?, tool_calls? }, finish_reason }],
 *     usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * Reply on failure:
 *   { error: { code, message, requestId? } }
 *   Codes: INVALID_REQUEST, IMAGE_INPUT_NOT_SUPPORTED, MODEL_NOT_ALLOWED,
 *   AI_CHANNEL_NOT_ALLOWED, AI_MODEL_NOT_SUPPORTED, EXCEED_TOKEN_QUOTA_LIMIT,
 *   TCB_ENV_MISSING, UPSTREAM_ERROR — mapped to HTTP statuses by the plugin.
 *   Failures from the SDK or the model keep their code; their message is
 *   replaced by a generic one and the original is written to the log.
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

// The platform caps a synchronous event at 6 MB, so these sit at that
// ceiling: a 1M-token agent history has to fit.
const MAX_MESSAGES = 10_000;
const MAX_SINGLE_MESSAGE_CHARS = 6 * 1024 * 1024;
const MAX_TOTAL_MESSAGE_CHARS = 6 * 1024 * 1024;
/** Models the official list marks as text-only
 * (https://docs.cloudbase.net/ai/available-models, checked 2026-11-24).
 * CloudBase ignores or rejects an image sent to them, so the proxy answers
 * with a clear error instead. Every other model gets the image as is. */
const TEXT_ONLY_MODELS = new Set(["hy3"]);
const IMAGE_MODEL_HINT = "hy4, hy4-flash, deepseek-v4.1-flash";

const MAX_MODEL_ID_LENGTH = 64;
const MAX_TOOLS = 128;
const MAX_TOOL_CALLS_PER_MESSAGE = 64;
const MAX_TOOL_NAME_LENGTH = 128;
const AI_PROXY_VERSION = "1.3.0";

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

/**
 * Error envelope for a failed model call. Errors raised by this function
 * itself (`expose`) keep their actionable text. Anything from the SDK or
 * the model keeps its code but not its message, which can name endpoints,
 * account ids or quota internals; the full text goes to the function log.
 */
function failureEnvelope(err, requestId) {
  const code = pickUpstreamCode(err) || "UPSTREAM_ERROR";
  if (err && err.expose === true) {
    return errorEnvelope(code, safeErrorMessage(err), requestId);
  }
  console.error("[aiProxy] model call failed", { code, requestId, message: safeErrorMessage(err) });
  return errorEnvelope(code, `The model call failed (${code}). See the aiProxy function logs for details.`, requestId);
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

const ALLOWED_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Validate one `image_url` part and keep the documented fields. The model
 * service fetches http(s) links itself; anything else has to be an inline
 * `data:image/...;base64,` URL. Returns { part, chars } or { error }.
 */
function normalizeImagePart(part, index, partIndex) {
  const image = isPlainObject(part.image_url) ? part.image_url : null;
  const url = image && typeof image.url === "string" ? image.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url) && !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(url)) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}].content[${partIndex}].image_url.url must be an http(s) link or a data:image/...;base64 URL.`,
      );
  }
  const out = { type: "image_url", image_url: { url } };
  if (image.detail === "low" || image.detail === "high" || image.detail === "auto") {
    out.image_url.detail = image.detail;
  }
  return { part: out, chars: url.length };
}

/**
 * Normalize OpenAI message content. Text-only content becomes a string
 * (text array parts are concatenated). A user message with `image_url`
 * parts keeps the array form the CloudBase multimodal API takes
 * (https://docs.cloudbase.net/ai/model/multimodal); other part types
 * (video, file, audio) are rejected. `allowEmpty` accepts null/undefined
 * (assistant messages that only carry tool_calls).
 * Returns { content, chars, imagePartIndex? } or { error }.
 */
function normalizeContent(content, index, allowEmpty, role) {
  if (typeof content === "string") return { content, chars: content.length };
  if ((content === null || content === undefined) && allowEmpty) return { content: "", chars: 0 };
  if (Array.isArray(content)) {
    const parts = [];
    let chars = 0;
    let imagePartIndex = -1;
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex];
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
        chars += part.text.length;
        continue;
      }
      if (isPlainObject(part) && part.type === "image_url") {
        if (role !== "user") {
          return errorEnvelope(
              "IMAGE_INPUT_NOT_SUPPORTED",
              `messages[${index}].content[${partIndex}] is an image on a "${role}" message. CloudBase models take images on user messages only.`,
            );
        }
        const image = normalizeImagePart(part, index, partIndex);
        if (image.error) return { error: image.error };
        parts.push(image.part);
        chars += image.chars;
        if (imagePartIndex < 0) imagePartIndex = partIndex;
        continue;
      }
      const partType = isPlainObject(part) && typeof part.type === "string" ? part.type : "unknown";
      return errorEnvelope(
          "INVALID_REQUEST",
          `messages[${index}].content[${partIndex}] has type "${partType.slice(0, 24)}". This proxy forwards text and image_url parts only.`,
        );
    }
    if (imagePartIndex < 0) {
      const text = parts.map((part) => part.text).join("\n");
      return { content: text, chars: text.length };
    }
    return { content: parts, chars, imagePartIndex };
  }
  return errorEnvelope(
      "INVALID_REQUEST",
      `messages[${index}].content must be a string or an array of text / image_url parts.`,
    );
}

/**
 * Validate the `tool_calls` of an assistant message and keep only the
 * OpenAI fields ({ id, type: "function", function: { name, arguments } }).
 * Returns { toolCalls, chars } or { error }.
 */
function normalizeToolCalls(toolCalls, index) {
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}].tool_calls must be an array of at most ${MAX_TOOL_CALLS_PER_MESSAGE} items.`,
      );
  }
  const out = [];
  let chars = 0;
  for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
    const call = toolCalls[callIndex];
    const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
    if (
      !fn ||
      typeof call.id !== "string" || call.id.length === 0 ||
      typeof fn.name !== "string" || fn.name.length === 0 || fn.name.length > MAX_TOOL_NAME_LENGTH
    ) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `messages[${index}].tool_calls[${callIndex}] must look like { id, type: "function", function: { name, arguments } }.`,
        );
    }
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    chars += fn.name.length + args.length;
    out.push({ id: call.id, type: "function", function: { name: fn.name, arguments: args } });
  }
  return { toolCalls: out, chars };
}

/**
 * Normalize one OpenAI-style message to the generateText input shape:
 * { role, content } plus `tool_calls` and `reasoning_content` on
 * assistant messages and `tool_call_id` on tool messages. `content` is a
 * string, or an array of text / image_url parts on a user message that
 * carries images. Unknown roles are rejected with a diagnostic error code.
 * Returns { message, chars, imagePartIndex? } or { error }.
 */
function normalizeMessage(message, index) {
  if (!isPlainObject(message)) {
    return errorEnvelope("INVALID_REQUEST", `messages[${index}] must be an object.`);
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (!ALLOWED_ROLES.has(role)) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}].role "${role.slice(0, 24)}" is not supported. Supported roles: system, user, assistant, tool.`,
      );
  }
  const hasToolCalls = role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const normalizedContent = normalizeContent(message.content, index, hasToolCalls, role);
  if (normalizedContent.error) return { error: normalizedContent.error };
  const normalized = { role, content: normalizedContent.content };
  let chars = normalizedContent.chars;

  if (hasToolCalls) {
    const calls = normalizeToolCalls(message.tool_calls, index);
    if (calls.error) return { error: calls.error };
    normalized.tool_calls = calls.toolCalls;
    chars += calls.chars;
  }
  // Thinking-mode models reject a tool-enabled request whose earlier
  // assistant turns come back without their reasoning.
  if (role === "assistant" && typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    normalized.reasoning_content = message.reasoning_content;
    chars += message.reasoning_content.length;
  }
  if (role === "tool") {
    if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0) {
      return errorEnvelope("INVALID_REQUEST", `messages[${index}] (role "tool") needs a tool_call_id.`);
    }
    normalized.tool_call_id = message.tool_call_id;
  }
  if (chars > MAX_SINGLE_MESSAGE_CHARS) {
    return errorEnvelope(
        "INVALID_REQUEST",
        `messages[${index}] is too large (${chars} chars; limit ${MAX_SINGLE_MESSAGE_CHARS}).`,
      );
  }
  return { message: normalized, chars, imagePartIndex: normalizedContent.imagePartIndex };
}

/**
 * Validate OpenAI `tools` (function tools only) and keep the documented
 * fields. Returns { tools } or { error }.
 */
function normalizeTools(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    return errorEnvelope("INVALID_REQUEST", `event.tools must be an array of at most ${MAX_TOOLS} function tools.`);
  }
  const out = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    const fn = isPlainObject(tool) && tool.type === "function" && isPlainObject(tool.function) ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0 || fn.name.length > MAX_TOOL_NAME_LENGTH) {
      return errorEnvelope(
          "INVALID_REQUEST",
          `event.tools[${index}] must look like { type: "function", function: { name, description?, parameters? } }.`,
        );
    }
    out.push({
      type: "function",
      function: {
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : "",
        parameters: isPlainObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      },
    });
  }
  return { tools: out };
}

/** Returns { toolChoice } or { error }. */
function normalizeToolChoice(toolChoice) {
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return { toolChoice };
  if (
    isPlainObject(toolChoice) && toolChoice.type === "function" &&
    isPlainObject(toolChoice.function) && typeof toolChoice.function.name === "string" && toolChoice.function.name.length > 0
  ) {
    return { toolChoice: { type: "function", function: { name: toolChoice.function.name } } };
  }
  return errorEnvelope(
      "INVALID_REQUEST",
      'event.toolChoice must be "auto", "none", "required" or { type: "function", function: { name } }.',
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
    if (typeof result.imagePartIndex === "number" && TEXT_ONLY_MODELS.has(model)) {
      return errorEnvelope(
          "IMAGE_INPUT_NOT_SUPPORTED",
          `messages[${index}].content[${result.imagePartIndex}] is an image, and model "${model}" takes text only. Use an image-capable model (${IMAGE_MODEL_HINT}), or remove the image from the conversation.`,
        );
    }
    const normalized = result.message;
    totalChars += result.chars;
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
    if (event.topP < 0 || event.topP > 1) {
      return errorEnvelope("INVALID_REQUEST", "event.topP must be between 0 and 1.");
    }
    params.topP = event.topP;
  }
  if (event.maxTokens !== undefined && event.maxTokens !== null) {
    if (!Number.isInteger(event.maxTokens) || event.maxTokens < 1) {
      return errorEnvelope("INVALID_REQUEST", "event.maxTokens must be a positive integer.");
    }
    params.maxTokens = event.maxTokens;
  }
  if (Array.isArray(event.tools) && event.tools.length > 0) {
    const tools = normalizeTools(event.tools);
    if (tools.error) return { error: tools.error };
    params.tools = tools.tools;
    if (event.toolChoice !== undefined && event.toolChoice !== null) {
      const choice = normalizeToolChoice(event.toolChoice);
      if (choice.error) return { error: choice.error };
      params.toolChoice = choice.toolChoice;
    }
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
 * The assistant message of the model's last reply. generateText keeps the
 * upstream Chat Completions object in `rawResponses`; older SDKs only
 * expose it as the message appended to `messages`.
 */
function pickLastChoice(result, inputMessageCount) {
  const raw = result && Array.isArray(result.rawResponses) ? result.rawResponses[result.rawResponses.length - 1] : null;
  const choice = isPlainObject(raw) && Array.isArray(raw.choices) ? raw.choices[0] : null;
  if (isPlainObject(choice) && isPlainObject(choice.message)) {
    return { message: choice.message, finishReason: choice.finish_reason };
  }
  const messages = result && Array.isArray(result.messages) ? result.messages : [];
  const last = messages[messages.length - 1];
  if (typeof inputMessageCount === "number" && messages.length > inputMessageCount && isPlainObject(last) && last.role === "assistant") {
    return { message: last, finishReason: undefined };
  }
  return { message: null, finishReason: undefined };
}

function pickToolCalls(message) {
  if (!isPlainObject(message) || !Array.isArray(message.tool_calls)) return [];
  const out = [];
  for (const call of message.tool_calls) {
    const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
    out.push({
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : "call_" + Math.random().toString(36).slice(2, 14),
      type: "function",
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return out;
}

/**
 * Map the @cloudbase/node-sdk generateText result
 * ({ text, messages, usage, rawResponses, error? }) to an OpenAI Chat
 * Completions object, including the model's tool calls. Pure; unit-tested
 * via _internal.
 */
function buildChatCompletion(result, model, requestId, inputMessageCount) {
  const text = result && typeof result.text === "string" ? result.text : "";
  const { message: lastMessage, finishReason } = pickLastChoice(result, inputMessageCount);
  const toolCalls = pickToolCalls(lastMessage);
  const message = { role: "assistant", content: toolCalls.length > 0 && text.length === 0 ? null : text };
  if (isPlainObject(lastMessage) && typeof lastMessage.reasoning_content === "string" && lastMessage.reasoning_content.length > 0) {
    message.reasoning_content = lastMessage.reasoning_content;
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        // "length" wins over tool calls: a reply cut off at the token limit
        // can carry incomplete tool arguments.
        finish_reason:
          finishReason === "length"
            ? "length"
            : toolCalls.length > 0
              ? "tool_calls"
              : typeof finishReason === "string" && finishReason.length > 0 && finishReason !== "tool_calls"
                ? finishReason
                : "stop",
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
/**
 * Map validated params to the generateText input. The SDK posts every
 * field it does not consume itself to the model's chat/completions
 * endpoint (topP -> top_p, toolChoice -> tool_choice). Pure; unit-tested.
 */
function buildGenerateInput(params) {
  return {
    model: params.model,
    messages: params.messages,
    ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
    ...(typeof params.topP === "number" ? { topP: params.topP } : {}),
    ...(typeof params.maxTokens === "number" ? { max_tokens: params.maxTokens } : {}),
    ...(params.tools
      ? {
          tools: params.tools,
          ...(params.toolChoice ? { toolChoice: params.toolChoice } : {}),
          // The SDK would otherwise try to run the tools itself; one step
          // hands the model's tool calls back to the agent, which owns them.
          maxSteps: 1,
        }
      : {}),
  };
}

let chatModel = null;

function loadSdk() {
  if (sdkModule) return sdkModule;
  try {
    sdkModule = require("@cloudbase/node-sdk");
  } catch (err) {
    const missing = new Error(
      "The @cloudbase/node-sdk dependency is missing. Deploy with installDependency enabled (cloudbaserc) or upload node_modules with the function code.",
    );
    missing.expose = true;
    throw missing;
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
    missing.expose = true;
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
    const result = await getChatModel().generateText(buildGenerateInput(params));
    if (result && result.error) {
      return failureEnvelope(result.error, requestId);
    }
    return { completion: buildChatCompletion(result, params.model, requestId, params.messages.length) };
  } catch (err) {
    return failureEnvelope(err, requestId);
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
    return failureEnvelope(err, requestId);
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
  normalizeTools,
  normalizeToolChoice,
  buildGenerateInput,
  buildChatCompletion,
  normalizeUsage,
  errorEnvelope,
  pingResult,
  safeErrorMessage,
  pickUpstreamCode,
  failureEnvelope,
};
