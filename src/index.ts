/**
 * CloudBase Bridge — Magpie/OpenCode provider plugin.
 *
 * Bridges Tencent CloudBase (Tencent CloudBase, "Mini Program Growth Plan")
 * models into an OpenCode-compatible provider by invoking a user-deployed
 * cloud function (default name: `aiProxy`) through the official CloudBase
 * HTTP function-invocation endpoint:
 *
 *   POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{name}
 *   Authorization: Bearer <CloudBase API Key>
 *
 * The growth-plan quota is only spendable from CloudBase SDK channels; direct
 * calls to the HTTP AI model endpoints (`/v1/ai/...`) are rejected with
 * `AI_CHANNEL_NOT_ALLOWED`. The cloud function therefore calls the model with
 * `@cloudbase/node-sdk` (`ai.createModel("cloudbase")` + `generateText`) and
 * returns a one-shot OpenAI-compatible JSON. This plugin adapts that JSON
 * into OpenAI Chat Completions responses and synthesizes SSE frames when the
 * agent requested `stream: true`.
 *
 * Magpie plugin contract (verified against https://usemagpie.ai/docs/zh/plugins
 * on 2026-11-09):
 * - The module must only export the plugin entry function(s); every exported
 *   function is treated as a plugin by the host. Test helpers live on the
 *   exported `_internal` object (recommended by the official docs).
 * - `loader(getAuth, provider)` may return a custom `fetch(input, init)`; the
 *   gateway already converts agent requests into Chat Completions and hands
 *   them to that fetch. We never need a local HTTP server.
 * - Model-availability errors must be answered with 403/404 (never 401) so
 *   the gateway treats them as model rejections instead of a dead login.
 * - `dist/` must be committed so the GitHub-topic discovery path can load
 *   the plugin straight from the repository.
 */

/* ------------------------------------------------------------------ *
 * Version & constants (single source of truth; no imports allowed —  *
 * this file is bundled standalone into dist/index.js).               *
 * ------------------------------------------------------------------ */

export const PLUGIN_VERSION = "0.2.12-reasoning.1" as const;

/** Requested provider id. If Magpie already uses it, the host renames the
 * provider to `cloudbase-plugin`; both prefixes are accepted on input. */
const PROVIDER_ID = "cloudbase";
const PROVIDER_ID_FALLBACK_PREFIX = "cloudbase-plugin/";

const DEFAULT_FUNCTION_NAME = "aiProxy";
const IMAGE_MODEL = "hy-image-v3.5-preview";
const IMAGE_FUNCTION = "generateImage";
const IMAGE_OPTION = "image_generation";
const INLINE_OPTION = "image_inline_preview";
const IMAGE_ENTRY = {
  name: "Hunyuan Image 3.5 Preview (prompt → URL)",
  tool_call: false,
  modalities: { input: ["text"], output: ["text"] },
};
const DEFAULT_TIMEOUT_MS = 150_000; // gateway invoke waits for the function; keep above the recommended 120 s function timeout
// A CloudBase event function takes a synchronous event of up to 6 MB.
const DEFAULT_MAX_EVENT_BYTES = 6 * 1024 * 1024;
const SSE_CHUNK_CHARS = 200;
const USER_AGENT = `opencode-cloudbase-bridge/${PLUGIN_VERSION}`;

const GATEWAY_SUFFIX_CN = ".api.tcloudbasegateway.com";
const GATEWAY_SUFFIX_INTL = ".api.intl.tcloudbasegateway.com";

/**
 * Model catalog (text chat models).
 *
 * Sources:
 * - https://docs.cloudbase.net/ai/ai-inspire-plan-new-models (checked
 *   2026-11-09): `hy4-preview` (1M ctx), `hy3` (256K ctx) and
 *   `deepseek-v4.1-flash` (1M ctx) are the growth-plan gift-quota text
 *   models; no console opt-in needed.
 * - 2026-11-23 model refresh: my environment now also offers `hy4` and
 *   `hy4-flash` (both enabled here), alongside `deepseek-v4.1-flash-1017`
 *   which I verified through aiProxy earlier (2026-11). Availability may
 *   differ per environment — CloudBase answers `AI_MODEL_NOT_SUPPORTED`
 *   where a model is not available, and the per-account model list follows
 *   the deployed function's allowlist (see the `provider.models` hook).
 *   Official docs do not list `hy4-flash` yet; its 1M context follows the
 *   hy4 family — adjust if your console says otherwise.
 * - `hy-image-v3.5-preview` is an image-generation model and is NOT in this
 *   chat catalog: the optional prompt-to-URL adapter routes separately.
 *
 * `verified` means "enabled by default", not "officially documented".
 * `image` follows the 图片 column of
 * https://docs.cloudbase.net/ai/available-models (checked 2026-11-24);
 * `hy4-preview` is not in that table and is served as `hy4` from
 * 2026-12-07.
 */
interface ModelSpec {
  name: string;
  context: number;
  output: number;
  verified: boolean;
  image: boolean;
}

const MODEL_CATALOG: Readonly<Record<string, ModelSpec>> = {
  "hy4-flash": { name: "Hunyuan 4 Flash", context: 1_000_000, output: 16_384, verified: true, image: true },
  "hy4": { name: "Hunyuan 4", context: 1_000_000, output: 16_384, verified: true, image: true },
  "hy4-preview": { name: "Hunyuan 4 Preview", context: 1_000_000, output: 16_384, verified: true, image: true },
  "hy3": { name: "Hunyuan 3", context: 262_144, output: 16_384, verified: true, image: false },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 16_384, verified: true, image: true },
  "deepseek-v4.1-flash-1017": { name: "DeepSeek V4.1 Flash 1017", context: 1_000_000, output: 16_384, verified: true, image: true },
};

/** Host-facing model entry. `modalities` tells the gateway and its agents
 * which models can be sent images. */
function modelEntry(spec: ModelSpec): Json {
  return {
    name: spec.name,
    limit: { context: spec.context, output: spec.output },
    tool_call: true,
    modalities: { input: spec.image ? ["text", "image"] : ["text"], output: ["text"] },
  };
}

/** The same structure with every number set to 0. */
function zeroNumbers(value: unknown): unknown {
  if (typeof value === "number") return 0;
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, zeroNumbers(item)]));
}

/**
 * Entry for a model the function's allowlist returned but the host's list
 * (`provider.models`) lacks. Per the Magpie plugin docs that list is in the
 * host's model shape (`capabilities.input.image`), not the config-hook shape
 * (`modalities`), so the entry takes its structure from a sibling already in
 * the list. The sibling's own settings (prices, options, headers, variants)
 * are not carried over.
 */
function accountModelEntry(id: string, base: Record<string, Json>): Json {
  const spec = MODEL_CATALOG[id];
  const name = spec ? spec.name : id;
  const limit = { context: spec ? spec.context : 131_072, output: spec ? spec.output : 16_384 };
  const template = Object.values(base).find((model) => isPlainObject(model) && isPlainObject(model.capabilities));
  if (!template) {
    return spec ? modelEntry(spec) : { name, limit, tool_call: true };
  }
  const capabilities = template.capabilities as Json;
  const entry: Json = {
    ...template,
    id,
    name,
    limit,
    capabilities: {
      ...capabilities,
      reasoning: false,
      toolcall: true,
      input: { ...(isPlainObject(capabilities.input) ? capabilities.input : {}), text: true, image: spec ? spec.image : true },
    },
  };
  if (isPlainObject(template.api)) entry.api = { ...template.api, id };
  if (isPlainObject(template.cost)) entry.cost = zeroNumbers(template.cost);
  for (const key of ["options", "headers", "variants"]) {
    if (isPlainObject(template[key])) entry[key] = {};
  }
  return entry;
}

function withImageModel(models: Record<string, Json>, enabled: boolean, base: Record<string, Json>): Record<string, Json> {
  if (enabled === Object.hasOwn(models, IMAGE_MODEL)) return models;
  if (!enabled) {
    const { [IMAGE_MODEL]: _, ...chat } = models;
    return chat;
  }
  const entry = base[IMAGE_MODEL] ?? accountModelEntry(IMAGE_MODEL, base);
  const image = base[IMAGE_MODEL] ?? (isPlainObject(entry.capabilities)
    ? { ...entry, name: IMAGE_ENTRY.name, capabilities: { ...entry.capabilities, toolcall: false,
      input: { text: true, image: false }, output: { text: true, image: false } } }
    : IMAGE_ENTRY);
  return { ...models, [IMAGE_MODEL]: image };
}

/* ------------------------------------------------------------------ *
 * Minimal structural types (no runtime dependencies).                *
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

interface AuthData {
  type?: string;
  key?: string;
  metadata?: Record<string, unknown>;
}

interface AccountConfig {
  apiKey: string;
  envId: string;
  functionName: string;
  region: "cn" | "intl";
  timeoutMs: number;
  gatewayBaseUrl?: string; // advanced/testing override
}

interface Logger {
  (level: "debug" | "info" | "warn" | "error", message: string): void;
}

interface PluginInput {
  client?: {
    app?: { log?: (args: { level: string; message: string; service?: string }) => Promise<unknown> };
  };
  project?: unknown;
  directory?: string;
  magpie?: { options?: Json | ((provider: string) => Json); option?: (provider: string, key: string) => boolean };
}

interface PluginOptions {
  envId?: string;
  functionName?: string;
  image_generation?: boolean;
  image_inline_preview?: boolean;
  region?: "cn" | "intl";
  timeoutMs?: number;
  gatewayBaseUrl?: string;
}

interface ChatCompletionMessage {
  role: string;
  content: unknown;
}

interface ChatCompletionsBody {
  model: unknown;
  messages: unknown[];
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  reasoning_effort?: unknown;
  thinking?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/* ------------------------------------------------------------------ *
 * Small utilities.                                                   *
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Strip a provider prefix (`cloudbase/`, `cloudbase-plugin/`) from a model
 * id, only at the leading boundary and only for known prefixes, collapsing
 * accidental repeats. Anything else is returned as-is.
 */
function normalizeModel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let model = raw.trim();
  const prefixes = [`${PROVIDER_ID}/`, PROVIDER_ID_FALLBACK_PREFIX];
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard += 1;
    for (const prefix of prefixes) {
      if (model.startsWith(prefix)) {
        model = model.slice(prefix.length);
        changed = true;
      }
    }
  }
  return model.length > 0 ? model : null;
}

function isValidEnvId(envId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(envId);
}

function isValidFunctionName(name: string): boolean {
  // Pattern from the CloudBase functions OpenAPI: ^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$/.test(name);
}

function gatewayBase(cfg: AccountConfig): string {
  if (cfg.gatewayBaseUrl) return cfg.gatewayBaseUrl.replace(/\/+$/, "");
  const host = cfg.region === "intl"
    ? `${cfg.envId}${GATEWAY_SUFFIX_INTL}`
    : `${cfg.envId}${GATEWAY_SUFFIX_CN}`;
  return `https://${host}`;
}

function invokeUrl(cfg: AccountConfig, name = cfg.functionName): string {
  return `${gatewayBase(cfg)}/v1/functions/${encodeURIComponent(name)}`;
}

/**
 * Combine the agent's AbortSignal with our own timeout. Uses
 * AbortSignal.any when available (Bun and modern Node do), otherwise a
 * manual controller with forwarded listeners.
 */
function combineSignals(
  agentSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (agentSignal && timeoutSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([agentSignal, timeoutSignal]);
  }
  if (agentSignal && timeoutSignal) {
    const controller = new AbortController();
    const forward = (source: AbortSignal) => () => {
      if (!controller.signal.aborted) {
        controller.abort(
          source.reason !== undefined ? source.reason : new Error("aborted"),
        );
      }
    };
    agentSignal.addEventListener("abort", forward(agentSignal), { once: true });
    timeoutSignal.addEventListener("abort", forward(timeoutSignal), { once: true });
    return controller.signal;
  }
  return agentSignal ?? timeoutSignal;
}

function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let buffer = "";
  for (const ch of text) {
    buffer += ch;
    if (buffer.length >= size) {
      pieces.push(buffer);
      buffer = "";
    }
  }
  if (buffer.length > 0) pieces.push(buffer);
  return pieces;
}

/* ------------------------------------------------------------------ *
 * OpenAI-style error responses.                                      *
 * ------------------------------------------------------------------ */

interface ErrorOptions {
  code?: string;
  requestId?: string;
  headers?: Record<string, string>;
}

function errorTypeFor(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 504) return "timeout_error";
  return "api_error";
}

function errorResponse(status: number, message: string, options: ErrorOptions = {}): Response {
  const error: Json = {
    message,
    type: errorTypeFor(status),
    code: options.code ?? String(status),
  };
  if (options.requestId) error.requestId = options.requestId;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.headers) Object.assign(headers, options.headers);
  return new Response(JSON.stringify({ error }), { status, headers });
}

function parseGatewayErrorBody(text: string): { code?: string; message?: string; requestId?: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPlainObject(parsed)) {
      return {
        code: typeof parsed.code === "string" ? parsed.code : undefined,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
      };
    }
  } catch {
    // fallthrough
  }
  return {};
}

/**
 * Map a gateway-level error (the CloudBase HTTP API answered non-2xx with
 * {code, message, requestId}) to an OpenAI-style response with the right
 * status semantics for Magpie failover:
 * - 401 only for genuinely bad credentials (marks the account for re-login);
 * - 403/404 for model/channel problems (gateway treats them as model
 *   rejections, per the Magpie plugin docs);
 * - 429 for quota/concurrency so failover can try another model/account;
 * - 504 for timeouts, 502 for function failures.
 */
function mapGatewayError(
  status: number,
  body: { code?: string; message?: string; requestId?: string },
  functionName = DEFAULT_FUNCTION_NAME,
): Response {
  const code = body.code ?? `HTTP_${status}`;
  const upstream = truncate(body.message ?? "(no message)", 300);
  const requestId = body.requestId;
  switch (code) {
    case "PERMISSION_DENIED":
    case "ACTION_FORBIDDEN":
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
      return errorResponse(
        401,
        `CloudBase rejected the API key (code: ${code}). Re-run \`magpie plugin login cloudbase\` with a valid server-side API Key. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "EXCEED_AUTHORITY":
      return errorResponse(
        403,
        `The cloud function rejected the caller (EXCEED_AUTHORITY). Check the ${functionName} cloud function security rules in the CloudBase console. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "FUNCTIONS_NOT_FOUND":
    case "FUNCTIONS_QUALIFIER_NOT_FOUND":
      return errorResponse(
        404,
        `Cloud function not found (code: ${code}). Deploy ${functionName} to this environment first. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "AI_CHANNEL_NOT_ALLOWED":
      return errorResponse(
        403,
        `CloudBase refused the AI channel (AI_CHANNEL_NOT_ALLOWED). Check that ${functionName} uses @cloudbase/node-sdk in the same environment and that this invocation source is eligible. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "AI_MODEL_NOT_SUPPORTED":
    case "AI_MODEL_DISABLED":
    case "AI_MODEL_NOT_FOUND":
      return errorResponse(
        404,
        `Model rejected by CloudBase (code: ${code}). Check that the model id is enabled/available in this environment. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "EXCEED_TOKEN_QUOTA_LIMIT":
    case "EXCEED_QUOTA":
      return errorResponse(
        429,
        `CloudBase AI quota exceeded (code: ${code}). Buy/renew the Token resource pack or switch models. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "EXCEED_CONCURRENT_REQUEST_LIMIT":
    case "FUNCTIONS_EXCEED_RESOURCE_LIMIT":
    case "EXCEED_RATE_LIMIT":
      return errorResponse(
        429,
        `CloudBase concurrency/rate limit reached (code: ${code}). Retry later or lower magpie.maxConcurrency for this provider.`,
        { code, requestId },
      );
    case "FUNCTIONS_TIME_LIMIT_EXCEEDED":
      return errorResponse(
        504,
        `The ${functionName} cloud function timed out (FUNCTIONS_TIME_LIMIT_EXCEEDED). Check its timeout in the CloudBase console/CLI. Upstream: ${upstream}`,
        { code, requestId },
      );
    case "FUNCTIONS_INVOCATION_FAILED":
    case "FUNCTIONS_MEMORY_LIMIT_EXCEEDED":
    case "FUNCTIONS_STATUS_ABNORMAL":
      return errorResponse(
        502,
        `The ${functionName} cloud function failed (code: ${code}). Check function logs in the CloudBase console. Upstream: ${upstream}`,
        { code, requestId },
      );
    default:
      return errorResponse(
        status >= 500 ? 502 : status,
        `CloudBase request failed (code: ${code}). Upstream: ${upstream}`,
        { code, requestId },
      );
  }
}

/**
 * Map an error envelope returned by aiProxy itself
 * ({ error: { code, message } } inside a 200 response).
 */
function mapFunctionError(
  err: Json,
  requestId?: string,
): Response {
  const code = typeof err.code === "string" ? err.code : "UPSTREAM_ERROR";
  const message = typeof err.message === "string" ? truncate(err.message, 400) : "aiProxy returned an error without a message.";
  const innerRequestId = typeof err.requestId === "string" ? err.requestId : requestId;
  switch (code) {
    case "INVALID_REQUEST":
    case "IMAGE_INPUT_NOT_SUPPORTED":
    case "AI_MODEL_PARAM_INVALID":
      return errorResponse(400, message, { code, requestId: innerRequestId });
    case "MODEL_NOT_ALLOWED":
    case "AI_MODEL_NOT_SUPPORTED":
    case "AI_MODEL_DISABLED":
    case "AI_MODEL_NOT_FOUND":
      return errorResponse(404, message, { code, requestId: innerRequestId });
    case "AI_CHANNEL_NOT_ALLOWED":
      return errorResponse(403, message, { code, requestId: innerRequestId });
    case "EXCEED_TOKEN_QUOTA_LIMIT":
      return errorResponse(429, message, { code, requestId: innerRequestId });
    case "TCB_ENV_MISSING":
      return errorResponse(
        502,
        message,
        { code, requestId: innerRequestId, headers: { "x-magpie-sign-in": "kept" } },
      );
    case "UPSTREAM_ERROR":
    case "FUNCTIONS_TIME_LIMIT_EXCEEDED":
      return errorResponse(502, message, { code, requestId: innerRequestId });
    default:
      return errorResponse(502, message, { code, requestId: innerRequestId });
  }
}

/* ------------------------------------------------------------------ *
 * Chat Completions <-> aiProxy adapters.                             *
 * ------------------------------------------------------------------ */

function buildInvokeEvent(body: ChatCompletionsBody, model: string): Json {
  const event: Json = { action: "chat", model, messages: body.messages };
  if (body.reasoning_effort != null) event.reasoning_effort = body.reasoning_effort;
  if (body.thinking != null) event.thinking = body.thinking;
  if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
    event.temperature = body.temperature;
  }
  if (typeof body.top_p === "number" && Number.isFinite(body.top_p)) {
    event.topP = body.top_p;
  }
  const maxTokens = typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : body.max_tokens;
  if (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens > 0) {
    event.maxTokens = maxTokens;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    event.tools = body.tools;
    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      event.toolChoice = body.tool_choice;
    }
  }
  return event;
}

function textContent(content: unknown): string {
  return typeof content === "string" ? content.trim()
    : Array.isArray(content) && content.every(part => isPlainObject(part) && part.type === "text" && typeof part.text === "string")
      ? content.map(part => part.text).join("\n").trim() : "";
}

function isDshTitleRequest(messages: unknown[]): boolean {
  const last = messages.at(-1);
  return isPlainObject(last) && last.role === "user" &&
    /^(?:Generate the session title from this JSON array of human messages:|Update the session title from this JSON object:)/.test(textContent(last.content)) &&
    messages.some(m => isPlainObject(m) && (m.role === "system" || m.role === "developer") && textContent(m.content)
      .includes("Create a concise title for an AI coding-assistant session from the supplied human messages."));
}

function isDshClock(prompt: string): boolean {
  return /^Time sampled while preparing turn \d+, step \d+: .+\r?\nBrowser time zone for this request: .+\r?\nElapsed since the preceding (?:model-visible message|step context): .+\.$/.test(prompt);
}

function isReminder(prompt: string): boolean {
  return prompt.startsWith("<system-reminder>") && prompt.endsWith("</system-reminder>");
}

function isDshConversation(messages: unknown[]): boolean {
  return messages.some(m => {
    if (!isPlainObject(m)) return false;
    if (m.role === "system" || m.role === "developer")
      return textContent(m.content).includes("You are an AI agent powered by DeepSeek Harness.");
    // The Web preset can omit harness identity but append a tagged session snapshot or clock.
    if (m.role !== "user") return false;
    const text = textContent(m.content);
    return isDshClock(text) || (isReminder(text) &&
      text.startsWith("<system-reminder>\nThe following information describes your current session") &&
      text.includes("\nCurrent DSH file policy"));
  });
}

function imageEvent(messages: unknown[], dsh: boolean): Json | null {
  let candidate = "";
  for (let i = messages.length - 1; i >= 0; --i) {
    const m = messages[i];
    if (!isPlainObject(m) || m.role !== "user") break;
    const prompt = textContent(m.content);
    if (dsh && (isReminder(prompt) || isDshClock(prompt))) continue;
    // Unknown additional user-role context: don't guess which text should incur a charge.
    if (!prompt || candidate) return null;
    candidate = prompt;
    if (!dsh) break;
  }
  return candidate ? { prompt: candidate } : null;
}

function imageCompletion(result: unknown, inline: boolean): NormalizedCompletion | null {
  if (!isPlainObject(result) || typeof result.url !== "string" || !/^https:\/\/[^\s]+$/i.test(result.url)) return null;
  try {
    const url = new URL(result.url);
    if (url.username || url.password) return null;
  } catch { return null; }
  let content = result.url;
  if (inline) {
    // Keep the signed URL intact after Markdown decodes the angle-bracket destination.
    if (/[<>\\\u0000-\u001f\u007f]/u.test(content)) return null;
    const destination = `<${content.replaceAll("&", "&amp;")}>`;
    content = `![生成的图片](${destination})\n\n[打开原图](${destination})`;
  }
  return normalizeCompletion({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

interface NormalizedCompletion {
  id: string;
  created: number;
  model: string; // canonical model id used upstream
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

function isJsonObjectText(text: string): boolean {
  try {
    return isPlainObject(JSON.parse(text));
  } catch {
    return false;
  }
}

/**
 * Validate the aiProxy reply (an OpenAI Chat Completions object) well enough
 * to adapt it. Returns null when the shape is unusable.
 */
function normalizeCompletion(value: unknown): NormalizedCompletion | null {
  if (!isPlainObject(value)) return null;
  const choices = Array.isArray(value.choices) ? value.choices : null;
  if (!choices || choices.length === 0) return null;
  const first = choices[0];
  if (!isPlainObject(first)) return null;
  const message = isPlainObject(first.message) ? first.message : null;
  const content = message && typeof message.content === "string" ? message.content : "";
  const truncated = first.finish_reason === "length";
  const toolCalls: ToolCall[] = [];
  if (message && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
      if (!isPlainObject(call) || !fn || typeof fn.name !== "string" || fn.name.length === 0) continue;
      // A reply cut off at the token limit can end inside a tool call's
      // arguments; a call the agent cannot parse must not be dispatched.
      if (truncated && typeof fn.arguments === "string" && !isJsonObjectText(fn.arguments)) continue;
      toolCalls.push({
        id: typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${Date.now().toString(36)}${toolCalls.length}`,
        type: "function",
        function: {
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        },
      });
    }
  }
  const reasoningContent = message && typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  const finishReason =
    truncated
      ? "length"
      : toolCalls.length > 0
        ? "tool_calls"
        : typeof first.finish_reason === "string"
          ? first.finish_reason
          : "stop";
  const usage = isPlainObject(value.usage)
    ? {
        prompt_tokens: typeof value.usage.prompt_tokens === "number" ? value.usage.prompt_tokens : 0,
        completion_tokens: typeof value.usage.completion_tokens === "number" ? value.usage.completion_tokens : 0,
        total_tokens: typeof value.usage.total_tokens === "number" ? value.usage.total_tokens : 0,
      }
    : null;
  return {
    id: typeof value.id === "string" ? value.id : `chatcmpl-${Date.now().toString(36)}`,
    created: typeof value.created === "number" ? value.created : Math.floor(Date.now() / 1000),
    model: typeof value.model === "string" ? value.model : "",
    content,
    reasoningContent,
    toolCalls,
    finishReason,
    usage,
  };
}

function chunkFrame(base: { id: string; created: number; model: string }, delta: Json, finishReason: string | null, usage?: Json): Json {
  const frame: Json = {
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) frame.usage = usage;
  return frame;
}

/**
 * Synthesize an SSE stream from the one-shot completion. Frames follow the
 * OpenAI Chat Completions streaming format: a role chunk, reasoning and
 * content chunks (split on code-point boundaries), tool-call chunks, a final chunk carrying finish_reason and
 * usage, then the `data: [DONE]` sentinel.
 */
function sseResponse(completion: NormalizedCompletion, echoModel: string): Response {
  const base = { id: completion.id, created: completion.created, model: echoModel };
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: Json) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      };
      try {
        send(chunkFrame(base, { role: "assistant", content: "" }, null));
        for (const piece of chunkText(completion.reasoningContent, SSE_CHUNK_CHARS)) {
          send(chunkFrame(base, { reasoning_content: piece }, null));
        }
        for (const piece of chunkText(completion.content, SSE_CHUNK_CHARS)) {
          send(chunkFrame(base, { content: piece }, null));
        }
        completion.toolCalls.forEach((call, index) => {
          send(chunkFrame(base, { tool_calls: [{ index, ...call }] }, null));
        });
        send(
          chunkFrame(
            base,
            {},
            completion.finishReason || "stop",
            completion.usage ? { ...completion.usage } : undefined,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        // Consumer went away (agent aborted); drain quietly.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        void error;
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

function jsonCompletionResponse(completion: NormalizedCompletion, echoModel: string): Response {
  const message: Json =
    completion.toolCalls.length > 0
      ? { role: "assistant", content: completion.content || null, tool_calls: completion.toolCalls }
      : { role: "assistant", content: completion.content };
  if (completion.reasoningContent) message.reasoning_content = completion.reasoningContent;
  const payload: Json = {
    id: completion.id,
    object: "chat.completion",
    created: completion.created,
    model: echoModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: completion.finishReason || "stop",
      },
    ],
  };
  if (completion.usage) payload.usage = completion.usage;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* ------------------------------------------------------------------ *
 * Account configuration (login metadata > plugin options > defaults). *
 * ------------------------------------------------------------------ */

function readMetadataString(metadata: Json | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveAccountConfig(
  auth: AuthData | undefined | null,
  options: PluginOptions | undefined,
  inputMagpieOptions: Json | undefined,
): AccountConfig | null {
  const apiKey = typeof auth?.key === "string" && auth.key.length > 0 ? auth.key : null;
  if (!apiKey) return null;

  const metadata = isPlainObject(auth?.metadata) ? auth.metadata : undefined;
  const mergedOptions: Json = { ...(inputMagpieOptions ?? {}), ...(options ?? {}) };

  const envId = readMetadataString(metadata, "envId") ?? readMetadataString(mergedOptions, "envId");
  if (!envId || !isValidEnvId(envId)) return null;

  const functionName = readMetadataString(metadata, "functionName")
    ?? readMetadataString(mergedOptions, "functionName")
    ?? DEFAULT_FUNCTION_NAME;
  if (!isValidFunctionName(functionName)) return null;

  const regionRaw = readMetadataString(metadata, "region") ?? readMetadataString(mergedOptions, "region");
  const region: "cn" | "intl" = regionRaw === "intl" ? "intl" : "cn";

  const timeoutRaw = mergedOptions.timeoutMs;
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw >= 250 && timeoutRaw <= 600_000
      ? timeoutRaw
      : DEFAULT_TIMEOUT_MS;

  const gatewayBaseRaw = readMetadataString(mergedOptions, "gatewayBaseUrl");

  return { apiKey, envId, functionName, region, timeoutMs, gatewayBaseUrl: gatewayBaseRaw };
}

/* ------------------------------------------------------------------ *
 * The bridge fetch (loader.fetch implementation).                    *
 * ------------------------------------------------------------------ */

function decodeBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return "";
}

interface BridgeContext {
  cfg: AccountConfig;
  log: Logger;
  imageEnabled: () => boolean;
  inlineImageEnabled: () => boolean;
}

async function bridgeFetch(this: BridgeContext, input: unknown, init?: { method?: string; headers?: unknown; body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const { cfg, log } = this;
  const startedAt = Date.now();

  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "POST") {
    return errorResponse(405, `CloudBase Bridge only handles POST requests (got ${method}).`, { code: "METHOD_NOT_ALLOWED" });
  }

  // Parse the gateway-converted Chat Completions body.
  let parsedBody: unknown;
  const rawBody = decodeBody(init?.body);
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, "Request body is not valid JSON (expected a Chat Completions object).", { code: "INVALID_REQUEST" });
  }
  if (!isPlainObject(parsedBody) || typeof parsedBody.model === "undefined" || !Array.isArray(parsedBody.messages)) {
    return errorResponse(400, "Request body must be a Chat Completions object with `model` and `messages`.", { code: "INVALID_REQUEST" });
  }
  const body = parsedBody as unknown as ChatCompletionsBody;

  const rawModel = typeof body.model === "string" ? body.model : String(body.model ?? "");
  const model = normalizeModel(rawModel);
  if (!model) {
    return errorResponse(400, "Missing model id after removing the provider prefix.", { code: "INVALID_REQUEST" });
  }
  const isImage = model === IMAGE_MODEL && this.imageEnabled();
  if (!isImage && !Object.hasOwn(MODEL_CATALOG, model)) {
    const known = Object.keys(MODEL_CATALOG).join(", ");
    return errorResponse(
      404,
      `Model "${truncate(model, 64)}" is not in the CloudBase Bridge catalog. Known models: ${known}.`,
      { code: "MODEL_NOT_ALLOWED" },
    );
  }

  const stream = body.stream === true;
  if (isImage && isDshTitleRequest(body.messages)) {
    // A DSH session-title request must never invoke a billable image model.
    const title = normalizeCompletion({ choices: [{ message: { content: "图片生成" } }] })!;
    return stream ? sseResponse(title, rawModel) : jsonCompletionResponse(title, rawModel);
  }
  const dshImage = isImage && isDshConversation(body.messages);
  const event = isImage ? imageEvent(body.messages, dshImage) : buildInvokeEvent(body, model);
  if (!event) return errorResponse(400, "Image generation expects one unambiguous, non-empty text-only user prompt in the current turn.", { code: "INVALID_IMAGE_PROMPT" });
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const signal = combineSignals(init?.signal, timeoutSignal);
  let functionName = cfg.functionName;
  if (!isImage && (event.reasoning_effort != null || event.thinking != null)) {
    try {
      const ping = await invokePing(cfg, signal);
      if (!reasoningLevels(ping, model).length) {
        return errorResponse(400, `The deployed ${functionName} does not advertise reasoning controls for ${model}. Update the function or omit the reasoning option.`, { code: "REASONING_UNAVAILABLE" });
      }
    } catch {
      if (init?.signal?.aborted) throw init.signal.reason;
      return errorResponse(502, "Could not check reasoning support; no chat request was sent.", { code: "REASONING_PROBE_FAILED" });
    }
  }
  if (isImage) {
    try {
      const ping = await invokePing(cfg, signal);
      if (isPlainObject(ping.capabilities) && ping.capabilities.generateImage === true) {
        event.action = "generateImage";
      } else {
        functionName = IMAGE_FUNCTION;
      }
    } catch {
      if (init?.signal?.aborted) throw init.signal.reason;
      return errorResponse(502, `Image capability check failed for ${cfg.functionName}; no image request was sent.`, { code: "IMAGE_ROUTE_UNAVAILABLE" });
    }
  }
  const payload = JSON.stringify(event);
  // Measure real UTF-8 bytes: string .length counts UTF-16 code units and
  // under-reports CJK content (each CJK char is typically 3 bytes but 1-2 units).
  const payloadBytes = new TextEncoder().encode(payload).byteLength;
  if (payloadBytes > DEFAULT_MAX_EVENT_BYTES) {
    return errorResponse(
      413,
      `Conversation payload too large (${payloadBytes} bytes; limit ${DEFAULT_MAX_EVENT_BYTES} bytes). Trim the history and retry.`,
      { code: "PAYLOAD_TOO_LARGE" },
    );
  }

  log("debug", `invoke ${functionName} model=${model} stream=${stream} bytes=${payloadBytes}`);

  let upstream: Response;
  try {
    upstream = await fetch(invokeUrl(cfg, functionName), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
        // The CloudBase API Key travels only in this request header, which is
        // built here and never logged. Incoming gateway headers (which may
        // carry it as well) are ignored, not echoed.
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: payload,
      signal,
    });
  } catch (error) {
    if (init?.signal?.aborted) {
      // The agent cancelled; propagate the abort so the gateway cleans up.
      throw error;
    }
    if (timeoutSignal.aborted) {
      log("warn", `invoke timeout after ${cfg.timeoutMs} ms (model=${model})`);
      return errorResponse(
        504,
        `CloudBase function invocation timed out after ${Math.round(cfg.timeoutMs / 1000)} s. Check the ${functionName} timeout and options.timeoutMs.`,
        { code: "INVOKE_TIMEOUT" },
      );
    }
    const reason = error instanceof Error ? truncate(error.message, 200) : "unknown network error";
    log("error", `invoke network failure: ${reason}`);
    return errorResponse(502, `Could not reach the CloudBase gateway: ${reason}`, { code: "NETWORK_ERROR" });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const mapped = mapGatewayError(upstream.status, parseGatewayErrorBody(text), functionName);
    log("warn", `invoke failed status=${upstream.status} code=${upstream.headers.get("x-request-id") ?? "-"}`);
    return mapped;
  }

  const responseText = await upstream.text();
  let functionResult: unknown;
  try {
    functionResult = JSON.parse(responseText);
  } catch {
    log("error", `${functionName} returned non-JSON body`);
    return errorResponse(
      502,
      `${functionName} returned a non-JSON body. Check the deployed function.`,
      { code: "INVALID_FUNCTION_JSON" },
    );
  }

  // aiProxy error envelope (it always reports failures inside HTTP 200).
  if (isPlainObject(functionResult) && isPlainObject(functionResult.error)) {
    const mapped = mapFunctionError(functionResult.error as Json, upstream.headers.get("x-request-id") ?? undefined);
    log("warn", `aiProxy error envelope: ${typeof (functionResult.error as Json).code === "string" ? (functionResult.error as Json).code : "unknown"}`);
    return mapped;
  }

  if (isImage && isPlainObject(functionResult) && functionResult.ok === false) {
    return mapFunctionError(functionResult, upstream.headers.get("x-request-id") ?? undefined);
  }
  const completion = isImage ? imageCompletion(functionResult, dshImage || this.inlineImageEnabled()) : normalizeCompletion(functionResult);
  if (!completion) {
    log("error", `${functionName} returned an unexpected response`);
    return errorResponse(
      502,
      isImage ? `${functionName} did not return an HTTPS image URL.` : "aiProxy reply is missing `choices[0].message`. Make sure the deployed aiProxy matches this plugin version (see docs/deploy-aiproxy.md).",
      { code: "INVALID_FUNCTION_RESPONSE" },
    );
  }

  const durationMs = Date.now() - startedAt;
  const totalTokens = completion.usage?.total_tokens;
  log(
    "info",
    `invoke ok model=${model} stream=${stream} ${durationMs} ms tokens=${typeof totalTokens === "number" ? totalTokens : "n/a"}`,
  );

  // Echo the model id exactly as the agent requested it (prefix included)
  // so clients keep seeing the identity they asked for.
  return stream ? sseResponse(completion, rawModel) : jsonCompletionResponse(completion, rawModel);
}

/* ------------------------------------------------------------------ *
 * Ping (used by provider.models to refine the per-account list).     *
 * ------------------------------------------------------------------ */

interface PingResult {
  ok?: boolean;
  service?: string;
  version?: string;
  env?: string | null;
  models?: unknown;
  capabilities?: unknown;
  reasoningLevels?: unknown;
}

function reasoningLevels(ping: PingResult, model: string): string[] {
  const levels = isPlainObject(ping.reasoningLevels) ? ping.reasoningLevels[model] : undefined;
  return Array.isArray(levels) ? levels.filter((l): l is string => ["none", "low", "high", "max"].includes(l)) : [];
}

async function invokePing(cfg: AccountConfig, signal?: AbortSignal): Promise<PingResult> {
  const upstream = await fetch(invokeUrl(cfg), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": USER_AGENT,
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ action: "ping" }),
    signal: combineSignals(signal, AbortSignal.timeout(15_000)),
  });
  if (!upstream.ok) {
    throw new Error(`ping failed with HTTP ${upstream.status}`);
  }
  const parsed: unknown = await upstream.json();
  if (!isPlainObject(parsed) || parsed.ok !== true) {
    throw new Error("ping returned an unexpected body");
  }
  return parsed as PingResult;
}

/* ------------------------------------------------------------------ *
 * Plugin entry.                                                      *
 * ------------------------------------------------------------------ */

function makeLogger(input: PluginInput | undefined): Logger {
  const appLog = input?.client?.app?.log;
  return (level, message) => {
    if (typeof appLog !== "function") return;
    void Promise.resolve(
      appLog({ level, message, service: "cloudbase-bridge" }),
    ).catch(() => {
      /* logging must never break requests */
    });
  };
}

/**
 * Magpie/OpenCode plugin entry. Only this function and the `_internal`
 * object are exported from the module (every exported *function* is loaded
 * as a plugin by the host).
 */
export const CloudbaseBridge = async (
  input: PluginInput = {},
  options: PluginOptions = {},
) => {
  const log = makeLogger(input);
  const magpieOptions = isPlainObject(input?.magpie?.options) ? input.magpie.options : undefined;
  const optionEnabled = (key: typeof IMAGE_OPTION | typeof INLINE_OPTION) => input.magpie?.option?.(PROVIDER_ID, key)
    ?? (options[key] ?? magpieOptions?.[key]) === true;
  const imageEnabled = () => optionEnabled(IMAGE_OPTION);

  const hooks = {
    config: async (cfg: { provider?: Record<string, Json> } & Json) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER_ID] ??= {
        name: "CloudBase Bridge",
        // Chat Completions is the API the gateway speaks to our fetch.
        npm: "@ai-sdk/openai-compatible",
        // loader.baseURL always overrides this; keep a harmless placeholder.
        api: `https://placeholder${GATEWAY_SUFFIX_CN}/v1`,
        models: { ...Object.fromEntries(
          Object.entries(MODEL_CATALOG).map(([id, spec]) => [
            id,
            { ...modelEntry(spec), ...(spec.verified ? {} : { disabled: true }) },
          ]),
        ), ...(imageEnabled() ? { [IMAGE_MODEL]: IMAGE_ENTRY } : {}) },
      };
    },

    auth: {
      provider: PROVIDER_ID,
      options: [{
        key: IMAGE_OPTION,
        label: "启用 DSH 生图 / Image generation",
        description: "Generate images through the configured function or the legacy generateImage function. Each generation can incur charges.",
        default: false,
        filtersModels: true,
      }, {
        key: INLINE_OPTION,
        label: "始终显示图片预览 / Always show image previews",
        description: "Use Markdown for all image replies, even if the gateway removes DSH identifiers. Does not enable image generation.",
        default: false,
      }],
      methods: [
        {
          type: "api",
          label: "CloudBase API Key (server-side)",
          placeholder: "Paste your CloudBase server API Key",
          prompts: [
            {
              type: "text",
              key: "envId",
              message: "CloudBase 环境 ID / Environment ID (e.g. cloud1-2a3b4c5d6e7f)",
              validate: (value: unknown) => {
                const v = typeof value === "string" ? value.trim() : "";
                if (!isValidEnvId(v)) return "Environment ID must be 3-64 characters: letters, digits, - or _";
                return undefined;
              },
            },
            {
              type: "select",
              key: "region",
              message: "环境区域 / Environment region",
              options: [
                { label: "中国大陆 (default)", value: "cn" },
                { label: "国际站 (Singapore etc.)", value: "intl" },
              ],
            },
            {
              type: "text",
              key: "functionName",
              message: `云函数名 / Cloud function name (press Enter for "${DEFAULT_FUNCTION_NAME}")`,
              validate: (value: unknown) => {
                const v = typeof value === "string" ? value.trim() : "";
                if (v.length === 0) return undefined; // empty -> default
                if (!isValidFunctionName(v)) return "Function names must match ^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$";
                return undefined;
              },
            },
          ] as unknown as Array<Record<string, unknown>>,
        },
      ],

      async loader(getAuth: () => Promise<AuthData | undefined>) {
        const auth = await getAuth().catch(() => undefined);
        const cfg = resolveAccountConfig(auth, options, magpieOptions);
        if (!cfg) return {};
        if (cfg.gatewayBaseUrl) {
          log("debug", "gatewayBaseUrl override active (testing only)");
        }
        const context: BridgeContext = { cfg, log, imageEnabled, inlineImageEnabled: () => optionEnabled(INLINE_OPTION) };
        return {
          baseURL: gatewayBase(cfg),
          fetch: bridgeFetch.bind(context),
        };
      },
    },

    provider: {
      id: PROVIDER_ID,

      /**
       * Refine the per-account model list from aiProxy's allowlist
       * (`{ action: "ping" }`). On any failure keep provider.models so
       * Magpie falls back gracefully, per the plugin docs.
       */
      async models(provider: { models?: Record<string, Json> }, ctx?: { auth?: AuthData }) {
        const base = provider.models ?? {};
        const fallback = () => withImageModel(base, imageEnabled(), base);
        const cfg = resolveAccountConfig(ctx?.auth, options, magpieOptions);
        if (!cfg) return fallback();
        try {
          const ping = await invokePing(cfg);
          const pingModels = Array.isArray(ping.models) ? ping.models.filter((m): m is string => typeof m === "string") : [];
          if (pingModels.length === 0) return fallback();
          const out: Record<string, Json> = {};
          for (const id of pingModels) {
            if (id === IMAGE_MODEL) continue;
            const entry: Json = base[id] ? { ...base[id] } : accountModelEntry(id, base);
            const levels = reasoningLevels(ping, id);
            if (levels.length) {
              if (isPlainObject(entry.capabilities)) entry.capabilities = { ...entry.capabilities, reasoning: true };
              else entry.reasoning = true;
              const variants = isPlainObject(entry.variants) ? entry.variants : {};
              entry.variants = Object.fromEntries(levels.map(level => [level, {
                ...(isPlainObject(variants[level]) ? variants[level] : {}), reasoningEffort: level,
              }]));
            }
            // The deployed function's allowlist explicitly accepts this id
            // (it just said so in the ping), so a static placeholder
            // `disabled` flag from the config-hook catalog must not survive.
            delete entry.disabled;
            out[id] = entry;
          }
          log("info", `account model list refreshed from aiProxy: ${pingModels.length} model(s)`);
          return withImageModel(out, imageEnabled(), base);
        } catch (error) {
          const reason = error instanceof Error ? truncate(error.message, 160) : "unknown";
          log("warn", `aiProxy ping failed, keeping static model list: ${reason}`);
          const kept = fallback();
          // The host recognizes a fallback by identity or, for a changed map, by this symbol.
          if (kept !== base) Object.defineProperty(kept, Symbol.for("magpie.fellBack"), { value: true });
          return kept;
        }
      },
    },
  };

  return hooks;
};

/* ------------------------------------------------------------------ *
 * Test surface. An object (never a function), so the host will not   *
 * treat it as a plugin; this is the pattern recommended by the       *
 * official Magpie plugin docs.                                       *
 * ------------------------------------------------------------------ */

export const _internal = {
  PLUGIN_VERSION,
  PROVIDER_ID,
  DEFAULT_FUNCTION_NAME,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_EVENT_BYTES,
  MODEL_CATALOG,
  isValidEnvId,
  isValidFunctionName,
  gatewayBase,
  invokeUrl,
  normalizeModel,
  resolveAccountConfig,
  buildInvokeEvent,
  normalizeCompletion,
  chunkText,
  sseResponse,
  jsonCompletionResponse,
  errorResponse,
  mapGatewayError,
  mapFunctionError,
  combineSignals,
};
