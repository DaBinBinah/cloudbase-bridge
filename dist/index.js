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
export const PLUGIN_VERSION = "0.1.0";
/** Requested provider id. If Magpie already uses it, the host renames the
 * provider to `cloudbase-plugin`; both prefixes are accepted on input. */
const PROVIDER_ID = "cloudbase";
const PROVIDER_ID_FALLBACK_PREFIX = "cloudbase-plugin/";
const DEFAULT_FUNCTION_NAME = "aiProxy";
const DEFAULT_TIMEOUT_MS = 150_000; // gateway invoke waits for the function; keep above the recommended 120 s function timeout
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;
const SSE_CHUNK_CHARS = 200;
const USER_AGENT = `opencode-cloudbase-bridge/${PLUGIN_VERSION}`;
const GATEWAY_SUFFIX_CN = ".api.tcloudbasegateway.com";
const GATEWAY_SUFFIX_INTL = ".api.intl.tcloudbasegateway.com";
const MODEL_CATALOG = {
    "hy4-preview": { name: "Hunyuan 4 Preview", context: 1_000_000, output: 16_384, verified: true },
    "hy3": { name: "Hunyuan 3", context: 262_144, output: 16_384, verified: true },
    "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 1_000_000, output: 16_384, verified: true },
    "hy4": { name: "Hunyuan 4 (unverified)", context: 131_072, output: 16_384, verified: false },
    "deepseek-v4.1-flash-1017": { name: "DeepSeek V4.1 Flash 1017 (unverified)", context: 131_072, output: 16_384, verified: false },
};
/* ------------------------------------------------------------------ *
 * Small utilities.                                                   *
 * ------------------------------------------------------------------ */
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
/**
 * Strip a provider prefix (`cloudbase/`, `cloudbase-plugin/`) from a model
 * id, only at the leading boundary and only for known prefixes, collapsing
 * accidental repeats. Anything else is returned as-is.
 */
function normalizeModel(raw) {
    if (typeof raw !== "string")
        return null;
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
function isValidEnvId(envId) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(envId);
}
function isValidFunctionName(name) {
    // Pattern from the CloudBase functions OpenAPI: ^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$
    return /^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$/.test(name);
}
function gatewayBase(cfg) {
    if (cfg.gatewayBaseUrl)
        return cfg.gatewayBaseUrl.replace(/\/+$/, "");
    const host = cfg.region === "intl"
        ? `${cfg.envId}${GATEWAY_SUFFIX_INTL}`
        : `${cfg.envId}${GATEWAY_SUFFIX_CN}`;
    return `https://${host}`;
}
function invokeUrl(cfg) {
    return `${gatewayBase(cfg)}/v1/functions/${encodeURIComponent(cfg.functionName)}`;
}
/**
 * Combine the agent's AbortSignal with our own timeout. Uses
 * AbortSignal.any when available (Bun and modern Node do), otherwise a
 * manual controller with forwarded listeners.
 */
function combineSignals(agentSignal, timeoutSignal) {
    if (agentSignal && timeoutSignal && typeof AbortSignal.any === "function") {
        return AbortSignal.any([agentSignal, timeoutSignal]);
    }
    if (agentSignal && timeoutSignal) {
        const controller = new AbortController();
        const forward = (source) => () => {
            if (!controller.signal.aborted) {
                controller.abort(source.reason !== undefined ? source.reason : new Error("aborted"));
            }
        };
        agentSignal.addEventListener("abort", forward(agentSignal), { once: true });
        timeoutSignal.addEventListener("abort", forward(timeoutSignal), { once: true });
        return controller.signal;
    }
    return agentSignal ?? timeoutSignal;
}
function chunkText(text, size) {
    const pieces = [];
    let buffer = "";
    for (const ch of text) {
        buffer += ch;
        if (buffer.length >= size) {
            pieces.push(buffer);
            buffer = "";
        }
    }
    if (buffer.length > 0)
        pieces.push(buffer);
    return pieces;
}
function errorTypeFor(status) {
    if (status === 400)
        return "invalid_request_error";
    if (status === 401)
        return "authentication_error";
    if (status === 403)
        return "permission_error";
    if (status === 404)
        return "not_found_error";
    if (status === 413)
        return "request_too_large";
    if (status === 429)
        return "rate_limit_error";
    if (status === 504)
        return "timeout_error";
    return "api_error";
}
function errorResponse(status, message, options = {}) {
    const error = {
        message,
        type: errorTypeFor(status),
        code: options.code ?? String(status),
    };
    if (options.requestId)
        error.requestId = options.requestId;
    const headers = { "content-type": "application/json" };
    if (options.headers)
        Object.assign(headers, options.headers);
    return new Response(JSON.stringify({ error }), { status, headers });
}
function parseGatewayErrorBody(text) {
    try {
        const parsed = JSON.parse(text);
        if (isPlainObject(parsed)) {
            return {
                code: typeof parsed.code === "string" ? parsed.code : undefined,
                message: typeof parsed.message === "string" ? parsed.message : undefined,
                requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
            };
        }
    }
    catch {
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
function mapGatewayError(status, body) {
    const code = body.code ?? `HTTP_${status}`;
    const upstream = truncate(body.message ?? "(no message)", 300);
    const requestId = body.requestId;
    switch (code) {
        case "PERMISSION_DENIED":
        case "ACTION_FORBIDDEN":
        case "INVALID_TOKEN":
        case "TOKEN_EXPIRED":
            return errorResponse(401, `CloudBase rejected the API key (code: ${code}). Re-run \`magpie plugin login cloudbase\` with a valid server-side API Key. Upstream: ${upstream}`, { code, requestId });
        case "EXCEED_AUTHORITY":
            return errorResponse(403, `The cloud function rejected the caller (EXCEED_AUTHORITY). Check the aiProxy cloud function security rules in the CloudBase console. Upstream: ${upstream}`, { code, requestId });
        case "FUNCTIONS_NOT_FOUND":
        case "FUNCTIONS_QUALIFIER_NOT_FOUND":
            return errorResponse(404, `Cloud function not found (code: ${code}). Deploy aiProxy to this environment first — see docs/deploy-aiproxy.md. Upstream: ${upstream}`, { code, requestId });
        case "AI_CHANNEL_NOT_ALLOWED":
            return errorResponse(403, `CloudBase refused the AI channel (AI_CHANNEL_NOT_ALLOWED). Growth-plan quota can only be spent from CloudBase SDK channels; make sure aiProxy calls the model via @cloudbase/node-sdk and is deployed in the same environment. Upstream: ${upstream}`, { code, requestId });
        case "AI_MODEL_NOT_SUPPORTED":
        case "AI_MODEL_DISABLED":
        case "AI_MODEL_NOT_FOUND":
            return errorResponse(404, `Model rejected by CloudBase (code: ${code}). Check that the model id is enabled/available in this environment. Upstream: ${upstream}`, { code, requestId });
        case "EXCEED_TOKEN_QUOTA_LIMIT":
        case "EXCEED_QUOTA":
            return errorResponse(429, `CloudBase AI quota exceeded (code: ${code}). Buy/renew the Token resource pack or switch models. Upstream: ${upstream}`, { code, requestId });
        case "EXCEED_CONCURRENT_REQUEST_LIMIT":
        case "FUNCTIONS_EXCEED_RESOURCE_LIMIT":
        case "EXCEED_RATE_LIMIT":
            return errorResponse(429, `CloudBase concurrency/rate limit reached (code: ${code}). Retry later or lower magpie.maxConcurrency for this provider.`, { code, requestId });
        case "FUNCTIONS_TIME_LIMIT_EXCEEDED":
            return errorResponse(504, `The aiProxy cloud function timed out (FUNCTIONS_TIME_LIMIT_EXCEEDED). Raise its timeout to 120 s in the CloudBase console/CLI. Upstream: ${upstream}`, { code, requestId });
        case "FUNCTIONS_INVOCATION_FAILED":
        case "FUNCTIONS_MEMORY_LIMIT_EXCEEDED":
        case "FUNCTIONS_STATUS_ABNORMAL":
            return errorResponse(502, `The aiProxy cloud function failed (code: ${code}). Check function logs in the CloudBase console. Upstream: ${upstream}`, { code, requestId });
        default:
            return errorResponse(status >= 500 ? 502 : status, `CloudBase request failed (code: ${code}). Upstream: ${upstream}`, { code, requestId });
    }
}
/**
 * Map an error envelope returned by aiProxy itself
 * ({ error: { code, message } } inside a 200 response).
 */
function mapFunctionError(err, requestId) {
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
            return errorResponse(502, message, { code, requestId: innerRequestId, headers: { "x-magpie-sign-in": "kept" } });
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
function buildInvokeEvent(body, model) {
    const event = { action: "chat", model, messages: body.messages };
    if (typeof body.temperature === "number" && Number.isFinite(body.temperature)) {
        event.temperature = body.temperature;
    }
    if (typeof body.top_p === "number" && Number.isFinite(body.top_p)) {
        event.topP = body.top_p;
    }
    // NOTE: `max_tokens` and `tools` are intentionally not forwarded: the
    // documented @cloudbase/node-sdk generateText input carries
    // { model, messages, temperature?, topP? } only (see README limitations).
    return event;
}
/**
 * Validate the aiProxy reply (an OpenAI Chat Completions object) well enough
 * to adapt it. Returns null when the shape is unusable.
 */
function normalizeCompletion(value) {
    if (!isPlainObject(value))
        return null;
    const choices = Array.isArray(value.choices) ? value.choices : null;
    if (!choices || choices.length === 0)
        return null;
    const first = choices[0];
    if (!isPlainObject(first))
        return null;
    const message = isPlainObject(first.message) ? first.message : null;
    const content = message && typeof message.content === "string" ? message.content : "";
    const finishReason = typeof first.finish_reason === "string" ? first.finish_reason : "stop";
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
        finishReason,
        usage,
    };
}
function chunkFrame(base, delta, finishReason, usage) {
    const frame = {
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
    if (usage)
        frame.usage = usage;
    return frame;
}
/**
 * Synthesize an SSE stream from the one-shot completion. Frames follow the
 * OpenAI Chat Completions streaming format: a role chunk, content chunks
 * (split on code-point boundaries), a final chunk carrying finish_reason and
 * usage, then the `data: [DONE]` sentinel.
 */
function sseResponse(completion, echoModel) {
    const base = { id: completion.id, created: completion.created, model: echoModel };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            const send = (frame) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            };
            try {
                send(chunkFrame(base, { role: "assistant", content: "" }, null));
                for (const piece of chunkText(completion.content, SSE_CHUNK_CHARS)) {
                    send(chunkFrame(base, { content: piece }, null));
                }
                send(chunkFrame(base, {}, completion.finishReason || "stop", completion.usage ? { ...completion.usage } : undefined));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            }
            catch (error) {
                // Consumer went away (agent aborted); drain quietly.
                try {
                    controller.close();
                }
                catch {
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
function jsonCompletionResponse(completion, echoModel) {
    const payload = {
        id: completion.id,
        object: "chat.completion",
        created: completion.created,
        model: echoModel,
        choices: [
            {
                index: 0,
                message: { role: "assistant", content: completion.content },
                finish_reason: completion.finishReason || "stop",
            },
        ],
    };
    if (completion.usage)
        payload.usage = completion.usage;
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}
/* ------------------------------------------------------------------ *
 * Account configuration (login metadata > plugin options > defaults). *
 * ------------------------------------------------------------------ */
function readMetadataString(metadata, key) {
    const value = metadata?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function resolveAccountConfig(auth, options, inputMagpieOptions) {
    const apiKey = typeof auth?.key === "string" && auth.key.length > 0 ? auth.key : null;
    if (!apiKey)
        return null;
    const metadata = isPlainObject(auth?.metadata) ? auth.metadata : undefined;
    const mergedOptions = { ...(inputMagpieOptions ?? {}), ...(options ?? {}) };
    const envId = readMetadataString(metadata, "envId") ?? readMetadataString(mergedOptions, "envId");
    if (!envId || !isValidEnvId(envId))
        return null;
    const functionName = readMetadataString(metadata, "functionName")
        ?? readMetadataString(mergedOptions, "functionName")
        ?? DEFAULT_FUNCTION_NAME;
    if (!isValidFunctionName(functionName))
        return null;
    const regionRaw = readMetadataString(metadata, "region") ?? readMetadataString(mergedOptions, "region");
    const region = regionRaw === "intl" ? "intl" : "cn";
    const timeoutRaw = mergedOptions.timeoutMs;
    const timeoutMs = typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw >= 250 && timeoutRaw <= 600_000
        ? timeoutRaw
        : DEFAULT_TIMEOUT_MS;
    const gatewayBaseRaw = readMetadataString(mergedOptions, "gatewayBaseUrl");
    return { apiKey, envId, functionName, region, timeoutMs, gatewayBaseUrl: gatewayBaseRaw };
}
/* ------------------------------------------------------------------ *
 * The bridge fetch (loader.fetch implementation).                    *
 * ------------------------------------------------------------------ */
function decodeBody(body) {
    if (typeof body === "string")
        return body;
    if (body instanceof Uint8Array)
        return new TextDecoder().decode(body);
    if (body instanceof ArrayBuffer)
        return new TextDecoder().decode(new Uint8Array(body));
    return "";
}
async function bridgeFetch(input, init) {
    const { cfg, log } = this;
    const startedAt = Date.now();
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "POST") {
        return errorResponse(405, `CloudBase Bridge only handles POST requests (got ${method}).`, { code: "METHOD_NOT_ALLOWED" });
    }
    // Parse the gateway-converted Chat Completions body.
    let parsedBody;
    const rawBody = decodeBody(init?.body);
    try {
        parsedBody = JSON.parse(rawBody);
    }
    catch {
        return errorResponse(400, "Request body is not valid JSON (expected a Chat Completions object).", { code: "INVALID_REQUEST" });
    }
    if (!isPlainObject(parsedBody) || typeof parsedBody.model === "undefined" || !Array.isArray(parsedBody.messages)) {
        return errorResponse(400, "Request body must be a Chat Completions object with `model` and `messages`.", { code: "INVALID_REQUEST" });
    }
    const body = parsedBody;
    const rawModel = typeof body.model === "string" ? body.model : String(body.model ?? "");
    const model = normalizeModel(rawModel);
    if (!model) {
        return errorResponse(400, "Missing model id after removing the provider prefix.", { code: "INVALID_REQUEST" });
    }
    if (!(model in MODEL_CATALOG)) {
        const known = Object.keys(MODEL_CATALOG).join(", ");
        return errorResponse(404, `Model "${truncate(model, 64)}" is not in the CloudBase Bridge catalog. Known models: ${known}.`, { code: "MODEL_NOT_ALLOWED" });
    }
    const stream = body.stream === true;
    const event = buildInvokeEvent(body, model);
    const payload = JSON.stringify(event);
    if (payload.length > DEFAULT_MAX_EVENT_BYTES) {
        return errorResponse(413, `Conversation payload too large (${payload.length} bytes; limit ${DEFAULT_MAX_EVENT_BYTES}). Trim the history and retry.`, { code: "PAYLOAD_TOO_LARGE" });
    }
    log("debug", `invoke ${cfg.functionName} model=${model} stream=${stream} bytes=${payload.length}`);
    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
    const signal = combineSignals(init?.signal, timeoutSignal);
    let upstream;
    try {
        upstream = await fetch(invokeUrl(cfg), {
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
    }
    catch (error) {
        if (init?.signal?.aborted) {
            // The agent cancelled; propagate the abort so the gateway cleans up.
            throw error;
        }
        if (timeoutSignal.aborted) {
            log("warn", `invoke timeout after ${cfg.timeoutMs} ms (model=${model})`);
            return errorResponse(504, `CloudBase function invocation timed out after ${Math.round(cfg.timeoutMs / 1000)} s. Raise the aiProxy timeout (recommended 120 s) or options.timeoutMs.`, { code: "INVOKE_TIMEOUT" });
        }
        const reason = error instanceof Error ? truncate(error.message, 200) : "unknown network error";
        log("error", `invoke network failure: ${reason}`);
        return errorResponse(502, `Could not reach the CloudBase gateway: ${reason}`, { code: "NETWORK_ERROR" });
    }
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        const mapped = mapGatewayError(upstream.status, parseGatewayErrorBody(text));
        log("warn", `invoke failed status=${upstream.status} code=${upstream.headers.get("x-request-id") ?? "-"}`);
        return mapped;
    }
    const responseText = await upstream.text();
    let functionResult;
    try {
        functionResult = JSON.parse(responseText);
    }
    catch {
        log("error", "aiProxy returned non-JSON body");
        return errorResponse(502, `aiProxy returned a non-JSON body (first bytes: ${truncate(responseText.slice(0, 24), 60)}). Redeploy the function from this repository.`, { code: "INVALID_FUNCTION_JSON" });
    }
    // aiProxy error envelope (it always reports failures inside HTTP 200).
    if (isPlainObject(functionResult) && isPlainObject(functionResult.error)) {
        const mapped = mapFunctionError(functionResult.error, upstream.headers.get("x-request-id") ?? undefined);
        log("warn", `aiProxy error envelope: ${typeof functionResult.error.code === "string" ? functionResult.error.code : "unknown"}`);
        return mapped;
    }
    const completion = normalizeCompletion(functionResult);
    if (!completion) {
        log("error", "aiProxy reply is not a Chat Completions object");
        return errorResponse(502, "aiProxy reply is missing `choices[0].message`. Make sure the deployed aiProxy matches this plugin version (see docs/deploy-aiproxy.md).", { code: "INVALID_FUNCTION_RESPONSE" });
    }
    const durationMs = Date.now() - startedAt;
    const totalTokens = completion.usage?.total_tokens;
    log("info", `invoke ok model=${model} stream=${stream} ${durationMs} ms tokens=${typeof totalTokens === "number" ? totalTokens : "n/a"}`);
    // Echo the model id exactly as the agent requested it (prefix included)
    // so clients keep seeing the identity they asked for.
    return stream ? sseResponse(completion, rawModel) : jsonCompletionResponse(completion, rawModel);
}
async function invokePing(cfg) {
    const upstream = await fetch(invokeUrl(cfg), {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": USER_AGENT,
            authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ action: "ping" }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
        throw new Error(`ping failed with HTTP ${upstream.status}`);
    }
    const parsed = await upstream.json();
    if (!isPlainObject(parsed) || parsed.ok !== true) {
        throw new Error("ping returned an unexpected body");
    }
    return parsed;
}
/* ------------------------------------------------------------------ *
 * Plugin entry.                                                      *
 * ------------------------------------------------------------------ */
function makeLogger(input) {
    const appLog = input?.client?.app?.log;
    return (level, message) => {
        if (typeof appLog !== "function")
            return;
        void Promise.resolve(appLog({ level, message, service: "cloudbase-bridge" })).catch(() => {
            /* logging must never break requests */
        });
    };
}
/**
 * Magpie/OpenCode plugin entry. Only this function and the `_internal`
 * object are exported from the module (every exported *function* is loaded
 * as a plugin by the host).
 */
export const CloudbaseBridge = async (input = {}, options = {}) => {
    const log = makeLogger(input);
    const magpieOptions = input?.magpie?.options;
    const hooks = {
        config: async (cfg) => {
            cfg.provider ??= {};
            cfg.provider[PROVIDER_ID] ??= {
                name: "CloudBase Bridge",
                // Chat Completions is the API the gateway speaks to our fetch.
                npm: "@ai-sdk/openai-compatible",
                // loader.baseURL always overrides this; keep a harmless placeholder.
                api: `https://placeholder${GATEWAY_SUFFIX_CN}/v1`,
                models: Object.fromEntries(Object.entries(MODEL_CATALOG).map(([id, spec]) => [
                    id,
                    {
                        name: spec.name,
                        limit: { context: spec.context, output: spec.output },
                        tool_call: false,
                        ...(spec.verified ? {} : { disabled: true }),
                    },
                ])),
            };
        },
        auth: {
            provider: PROVIDER_ID,
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
                            validate: (value) => {
                                const v = typeof value === "string" ? value.trim() : "";
                                if (!isValidEnvId(v))
                                    return "Environment ID must be 3-64 characters: letters, digits, - or _";
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
                            validate: (value) => {
                                const v = typeof value === "string" ? value.trim() : "";
                                if (v.length === 0)
                                    return undefined; // empty -> default
                                if (!isValidFunctionName(v))
                                    return "Function names must match ^[a-zA-Z][a-zA-Z0-9_-]{0,58}[a-zA-Z0-9]$";
                                return undefined;
                            },
                        },
                    ],
                },
            ],
            async loader(getAuth) {
                const auth = await getAuth().catch(() => undefined);
                const cfg = resolveAccountConfig(auth, options, magpieOptions);
                if (!cfg)
                    return {};
                if (cfg.gatewayBaseUrl) {
                    log("debug", "gatewayBaseUrl override active (testing only)");
                }
                const context = { cfg, log };
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
            async models(provider, ctx) {
                const base = provider.models ?? {};
                const cfg = resolveAccountConfig(ctx?.auth, options, magpieOptions);
                if (!cfg)
                    return base;
                try {
                    const ping = await invokePing(cfg);
                    const pingModels = Array.isArray(ping.models) ? ping.models.filter((m) => typeof m === "string") : [];
                    if (pingModels.length === 0)
                        return base;
                    const out = {};
                    for (const id of pingModels) {
                        const known = MODEL_CATALOG[id];
                        if (base[id]) {
                            out[id] = { ...base[id] };
                        }
                        else {
                            out[id] = {
                                name: known?.name ?? id,
                                limit: { context: known?.context ?? 131_072, output: known?.output ?? 16_384 },
                                tool_call: false,
                                ...(known && !known.verified ? { disabled: true } : {}),
                            };
                        }
                    }
                    log("info", `account model list refreshed from aiProxy: ${pingModels.length} model(s)`);
                    return out;
                }
                catch (error) {
                    const reason = error instanceof Error ? truncate(error.message, 160) : "unknown";
                    log("warn", `aiProxy ping failed, keeping static model list: ${reason}`);
                    return base;
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
