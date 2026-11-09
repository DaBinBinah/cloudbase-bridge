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
export declare const PLUGIN_VERSION: "0.2.1";
/**
 * Model catalog.
 *
 * Sources (checked 2026-11-09):
 * - https://docs.cloudbase.net/ai/ai-inspire-plan-new-models — official
 *   growth-plan notice: `hy4-preview` (1M ctx), `hy3` (256K ctx) and
 *   `deepseek-v4.1-flash` (1M ctx) are the three text models that can spend
 *   the gift quota. They need no console opt-in.
 * - `deepseek-v4.1-flash-1017` is NOT in the official notice, but I verified
 *   it works through aiProxy in my own CloudBase environment (2026-11). It
 *   is enabled by default; support may differ per environment — CloudBase
 *   answers `AI_MODEL_NOT_SUPPORTED` where it is not available, and the
 *   per-account model list follows the deployed function's allowlist (see
 *   the `provider.models` hook).
 * - `hy4` remains an unverified placeholder; it stays disabled until
 *   verified the same way.
 *
 * `verified` here means "enabled by default", not "officially documented" —
 * see the per-model notes above. Context/output numbers for entries without
 * official specs are conservative placeholders.
 */
interface ModelSpec {
    name: string;
    context: number;
    output: number;
    verified: boolean;
}
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
    gatewayBaseUrl?: string;
}
interface PluginInput {
    client?: {
        app?: {
            log?: (args: {
                level: string;
                message: string;
                service?: string;
            }) => Promise<unknown>;
        };
    };
    project?: unknown;
    directory?: string;
    magpie?: {
        options?: Json;
    };
}
interface PluginOptions {
    envId?: string;
    functionName?: string;
    region?: "cn" | "intl";
    timeoutMs?: number;
    gatewayBaseUrl?: string;
}
interface ChatCompletionsBody {
    model: unknown;
    messages: unknown;
    stream?: unknown;
    temperature?: unknown;
    top_p?: unknown;
}
/**
 * Strip a provider prefix (`cloudbase/`, `cloudbase-plugin/`) from a model
 * id, only at the leading boundary and only for known prefixes, collapsing
 * accidental repeats. Anything else is returned as-is.
 */
declare function normalizeModel(raw: unknown): string | null;
declare function isValidEnvId(envId: string): boolean;
declare function isValidFunctionName(name: string): boolean;
declare function gatewayBase(cfg: AccountConfig): string;
declare function invokeUrl(cfg: AccountConfig): string;
/**
 * Combine the agent's AbortSignal with our own timeout. Uses
 * AbortSignal.any when available (Bun and modern Node do), otherwise a
 * manual controller with forwarded listeners.
 */
declare function combineSignals(agentSignal: AbortSignal | undefined, timeoutSignal: AbortSignal | undefined): AbortSignal | undefined;
declare function chunkText(text: string, size: number): string[];
interface ErrorOptions {
    code?: string;
    requestId?: string;
    headers?: Record<string, string>;
}
declare function errorResponse(status: number, message: string, options?: ErrorOptions): Response;
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
declare function mapGatewayError(status: number, body: {
    code?: string;
    message?: string;
    requestId?: string;
}): Response;
/**
 * Map an error envelope returned by aiProxy itself
 * ({ error: { code, message } } inside a 200 response).
 */
declare function mapFunctionError(err: Json, requestId?: string): Response;
declare function buildInvokeEvent(body: ChatCompletionsBody, model: string): Json;
interface NormalizedCompletion {
    id: string;
    created: number;
    model: string;
    content: string;
    finishReason: string;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    } | null;
}
/**
 * Validate the aiProxy reply (an OpenAI Chat Completions object) well enough
 * to adapt it. Returns null when the shape is unusable.
 */
declare function normalizeCompletion(value: unknown): NormalizedCompletion | null;
/**
 * Synthesize an SSE stream from the one-shot completion. Frames follow the
 * OpenAI Chat Completions streaming format: a role chunk, content chunks
 * (split on code-point boundaries), a final chunk carrying finish_reason and
 * usage, then the `data: [DONE]` sentinel.
 */
declare function sseResponse(completion: NormalizedCompletion, echoModel: string): Response;
declare function jsonCompletionResponse(completion: NormalizedCompletion, echoModel: string): Response;
declare function resolveAccountConfig(auth: AuthData | undefined | null, options: PluginOptions | undefined, inputMagpieOptions: Json | undefined): AccountConfig | null;
/**
 * Magpie/OpenCode plugin entry. Only this function and the `_internal`
 * object are exported from the module (every exported *function* is loaded
 * as a plugin by the host).
 */
export declare const CloudbaseBridge: (input?: PluginInput, options?: PluginOptions) => Promise<{
    config: (cfg: {
        provider?: Record<string, Json>;
    } & Json) => Promise<void>;
    auth: {
        provider: string;
        methods: {
            type: string;
            label: string;
            placeholder: string;
            prompts: Array<Record<string, unknown>>;
        }[];
        loader(getAuth: () => Promise<AuthData | undefined>): Promise<{
            baseURL?: undefined;
            fetch?: undefined;
        } | {
            baseURL: string;
            fetch: (input: unknown, init?: {
                method?: string;
                headers?: unknown;
                body?: unknown;
                signal?: AbortSignal;
            } | undefined) => Promise<Response>;
        }>;
    };
    provider: {
        id: string;
        /**
         * Refine the per-account model list from aiProxy's allowlist
         * (`{ action: "ping" }`). On any failure keep provider.models so
         * Magpie falls back gracefully, per the plugin docs.
         */
        models(provider: {
            models?: Record<string, Json>;
        }, ctx?: {
            auth?: AuthData;
        }): Promise<Record<string, Json>>;
    };
}>;
export declare const _internal: {
    PLUGIN_VERSION: "0.2.1";
    PROVIDER_ID: string;
    DEFAULT_FUNCTION_NAME: string;
    DEFAULT_TIMEOUT_MS: number;
    DEFAULT_MAX_EVENT_BYTES: number;
    MODEL_CATALOG: Readonly<Record<string, ModelSpec>>;
    isValidEnvId: typeof isValidEnvId;
    isValidFunctionName: typeof isValidFunctionName;
    gatewayBase: typeof gatewayBase;
    invokeUrl: typeof invokeUrl;
    normalizeModel: typeof normalizeModel;
    resolveAccountConfig: typeof resolveAccountConfig;
    buildInvokeEvent: typeof buildInvokeEvent;
    normalizeCompletion: typeof normalizeCompletion;
    chunkText: typeof chunkText;
    sseResponse: typeof sseResponse;
    jsonCompletionResponse: typeof jsonCompletionResponse;
    errorResponse: typeof errorResponse;
    mapGatewayError: typeof mapGatewayError;
    mapFunctionError: typeof mapFunctionError;
    combineSignals: typeof combineSignals;
};
export {};
