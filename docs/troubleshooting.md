# Troubleshooting

Every error below is what the agent actually sees (an OpenAI-style
`{ error: { message, type, code, requestId } }` payload). The plugin maps
CloudBase gateway/function errors to HTTP statuses following the Magpie
plugin conventions: **401 only for genuinely bad credentials** (it marks the
account for re-login), **403/404 for model/channel problems** (treated as
model rejections, no account marking), **429 for quota/concurrency**, 502/504
for failures. Error messages never contain your API Key, conversation
content, or full headers; `requestId` is preserved for support tickets.

---

## 1. `FUNCTIONS_NOT_FOUND` (HTTP 404)

**Meaning.** The CloudBase function-invocation endpoint found no function
with that name in that environment (from the
[functions OpenAPI](https://docs.cloudbase.net/openapi/functions.v1.openapi.yaml):
“未找到指定函数”). `FUNCTIONS_QUALIFIER_NOT_FOUND` maps the same way.

**Fix.**
- Deploy aiProxy first: [`cloudfunctions/aiProxy/README.md`](../cloudfunctions/aiProxy/README.md).
- Check the environment ID you entered at `magpie plugin login cloudbase`
  matches the environment the function lives in — the plugin and the
  function **must be in the same environment**.
- Check the function name (default `aiProxy`); re-login to change it, or set
  the `functionName` plugin option.
- Verify remotely: `tcb fn list` and `tcb fn invoke aiProxy --params '{"action":"ping"}'`.

## 2. `AI_CHANNEL_NOT_ALLOWED` (HTTP 403)

**Meaning.** CloudBase refused the AI channel. Growth-plan gift quota is only
spendable from CloudBase SDK channels; the
[official notice](https://docs.cloudbase.net/ai/ai-inspire-plan-new-models)
requires `createModel("cloudbase")` + the listed model ids. If aiProxy was
copied from older sample code that calls `/v1/ai/*` over HTTP or uses the
legacy default group (`hunyuan-v3`), the channel check rejects it.

**Fix.**
- Redeploy the aiProxy from this repository — it uses
  `ai.createModel("cloudbase").generateText(...)` via `@cloudbase/node-sdk`
  (an allowed channel).
- Make sure the function runs **inside CloudBase** (an Event Function in the
  same environment), not from a random external host.
- Direct HTTP calls to `/v1/ai/*` will keep failing with this code — that is
  the channel restriction this whole project routes around.

## 3. `AI_MODEL_NOT_SUPPORTED` / `MODEL_NOT_ALLOWED` (HTTP 404)

**Meaning.** The requested model is not callable in this environment. Three
possible layers:
1. The **plugin's static catalog** rejected it (message says
   “not in the CloudBase Bridge catalog” — typo or truly unknown id);
2. **aiProxy's allowlist** rejected it (message mentions
   `AI_PROXY_ALLOWED_MODELS`);
3. **CloudBase itself** rejected it (upstream code `AI_MODEL_NOT_SUPPORTED`
   / `AI_MODEL_DISABLED` / `AI_MODEL_NOT_FOUND` — e.g. the disabled
   placeholders `hy4` / `deepseek-v4.1-flash-1017`, or a model your
   environment hasn't enabled).

**Fix.**
- Use a confirmed growth-plan id: `hy3`, `hy4-preview`, `deepseek-v4.1-flash`
  (checked 2026-11-09; re-check the official notice).
- If you intentionally enabled an extra model in your environment, add it to
  the function env var `AI_PROXY_ALLOWED_MODELS` (comma-separated) and
  enable it in your Magpie/OpenCode provider config.
- `m provider test cloudbase <model>` is the quickest way to isolate one model.

## 4. Authentication failures (HTTP 401: `PERMISSION_DENIED`, `ACTION_FORBIDDEN`)

**Meaning.** The gateway rejected the identity — usually an invalid/expired/
wrong-type API Key (`PERMISSION_DENIED`), or an intercepted call
(`ACTION_FORBIDDEN`). A 401 marks the Magpie account as needing re-login.

**Fix.**
- Make sure you created a **server-side API Key** (not a publishable key):
  [console → Environment settings → API Key](https://tcb.cloud.tencent.com/dev?#/identity/token-management).
  Server API Keys carry administrator permissions, which is what the
  function-invocation endpoint requires.
- Re-login: `magpie plugin logout cloudbase && magpie plugin login cloudbase`.
- If the key is correct but you still see `EXCEED_AUTHORITY` (HTTP 403), that
  is the **cloud function security rule** rejecting the caller — review the
  aiProxy function security rules in the console (云函数 → aiProxy → 安全规则).
- The key is high-privilege; if you suspect leakage, rotate it in the console
  and re-login.

## 5. Timeouts

**Which timeout fired?**
- Error code `INVOKE_TIMEOUT` (HTTP 504) — the **plugin** gave up waiting for
  the gateway (default 150 s). Raise the option `timeoutMs` — but first fix
  the function timeout, which is usually the real bottleneck.
- `FUNCTIONS_TIME_LIMIT_EXCEEDED` (HTTP 504) — **CloudBase killed the
  function**. The default function timeout (20 s) is far too short for AI
  text generation; set it to **120 s** (console or
  `cloudbaserc.json` → `"timeout": 120` → `tcb fn config update aiProxy`).
- Agent-side aborts (user pressed escape) simply cancel the request — no
  error payload, nothing to fix.

**Also remember:** this bridge is one-shot upstream — long generations run to
completion inside one function invocation. Very long outputs may still hit
the 120 s ceiling; use a faster model (`deepseek-v4.1-flash`) or trim
context.

## 6. Quota / concurrency (HTTP 429: `EXCEED_TOKEN_QUOTA_LIMIT`, `EXCEED_CONCURRENT_REQUEST_LIMIT`, `FUNCTIONS_EXCEED_RESOURCE_LIMIT`)

**Meaning.**
- `EXCEED_TOKEN_QUOTA_LIMIT` — the AI quota is exhausted (gift pack used up
  or expired — the growth-plan grant lasts 6 months — or you're now billing
  an empty Token Credits pack).
- The concurrency codes — too many simultaneous function/model calls.

**Fix.**
- Buy/renew the Token resource pack (or re-check the growth-plan activity
  terms), or switch to a model you still have quota for.
- Lower `magpie.maxConcurrency` for the provider (the plugin suggests 4) in
  its Magpie settings, or throttle your agents.
- 429 tells Magpie's failover to try your next account/model automatically.

## 7. `INVALID_FUNCTION_JSON` / `INVALID_FUNCTION_RESPONSE` (HTTP 502)

**Meaning.** aiProxy answered with something this plugin can't parse — the
deployed function is not the one from this repository, or an older version.

**Fix.** Redeploy `cloudfunctions/aiProxy/` and confirm with
`tcb fn invoke aiProxy --params '{"action":"ping"}'` — the reply must be
`{"ok":true,"service":"aiProxy",...}`.

## 8. `TCB_ENV_MISSING` (HTTP 502)

**Meaning.** The function ran without `TCB_ENV`. Inside CloudBase the runtime
injects it automatically; outside (e.g. a mis-configured web function or
local `tcb fn run` quirk) it's absent.

**Fix.** Deploy as a normal **Event Function** in CloudBase, or add
`TCB_ENV` to the function's environment variables manually.

## 9. Other gateway errors

| Code | Status | What to do |
| --- | --- | --- |
| `FUNCTIONS_PARAM_INVALID` | 400 | Upgrade the plugin (request contract changed) |
| `FUNCTIONS_INVOCATION_FAILED` | 502 | Read the function logs: console → 云函数 → 日志, or `tcb fn log aiProxy` |
| `FUNCTIONS_MEMORY_LIMIT_EXCEEDED` | 502 | Raise function memory (256 MB is plenty for this code; check for runaway input) |
| `FUNCTIONS_STATUS_ABNORMAL` | 502 | Function is paused/frozen — check console |
| `FUNCTIONS_EXCEED_RESOURCE_LIMIT` | 429 | Concurrency headroom exhausted — retry later |
| anything else | passthrough | The upstream `message` is included; search it in the [CloudBase error-code list](https://docs.cloudbase.net/error-code/service) |

## Quick diagnosis recipe

```bash
# 1. Does the function exist and answer?
tcb fn invoke aiProxy --params '{"action":"ping"}'

# 2. Does the gateway accept your key? (use a throwaway copy, then delete it)
curl -s "https://YOUR-ENV-ID.api.tcloudbasegateway.com/v1/functions/aiProxy" \
  -H "Authorization: Bearer YOUR-API-KEY" -H "content-type: application/json" \
  -d '{"action":"ping"}'

# 3. What does Magpie think of the plugin?
magpie plugin --json
m provider test cloudbase hy3   # inside the sandbox recipe from the README
```
