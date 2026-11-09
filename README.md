# CloudBase Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

A **[Magpie](https://usemagpie.ai) / OpenCode provider plugin** that turns Tencent
CloudBase's "小程序成长计划" (mini-program growth plan) AI quota into a normal
OpenAI-compatible provider, by way of **your own** `aiProxy` cloud function.

> **Independence disclaimer.** This is a community project. It is **not**
> reviewed, endorsed, or curated by Magpie, and it is **not** affiliated with
> Tencent Cloud. The model availability notes below are transcriptions of
> Tencent's public documentation with the date they were checked — verify
> against the official pages before relying on them.

---

## Why a cloud function?

The growth-plan gift quota can only be spent from **CloudBase SDK channels**
(the WeChat Mini Program SDK, the CloudBase server SDKs, or the console).
Calling the HTTP AI model endpoints directly fails:

```
POST https://{envId}.api.tcloudbasegateway.com/v1/ai/…/chat/completions
→ 403 AI_CHANNEL_NOT_ALLOWED
```

So this plugin never touches `/v1/ai/*`. Instead it invokes a normal
(Event) cloud function — named **`aiProxy`** — through the official
**function-invocation endpoint**, and that function calls the model with
`@cloudbase/node-sdk`, which is an allowed channel:

```
Agent ──► magpie gateway ──► plugin fetch (this repo)
                               │  POST https://{envId}.api.tcloudbasegateway.com/v1/functions/aiProxy
                               │  Authorization: Bearer <CloudBase API Key>
                               ▼
                          aiProxy (your CloudBase env)
                               │  @cloudbase/node-sdk
                               │  ai.createModel("cloudbase").generateText({ model, messages })
                               ▼
                          hy3 / hy4-preview / deepseek-v4.1-flash
```

The function returns **one-shot** OpenAI Chat Completions JSON. The plugin
adapts it and **synthesizes SSE** (role chunk → content chunks → final chunk
→ `data: [DONE]`) when the agent requested `stream: true`. Magpie converts
between whatever API your agent speaks and Chat Completions, so any agent
works.

## Models

Growth-plan gift quota, per the
[official notice](https://docs.cloudbase.net/ai/ai-inspire-plan-new-models)
(checked **2026-11-09** — re-check before relying on this):

| Model id | Context | Images | Status in this plugin |
| --- | --- | --- | --- |
| `hy3` | 256K | — | enabled |
| `hy4-preview` | 1M | — | enabled |
| `deepseek-v4.1-flash` | 1M | supported by the model, **not forwarded** by this proxy | enabled |
| `hy4` | ? | ? | **disabled** placeholder (not in the current official notice) |
| `deepseek-v4.1-flash-1017` | ? | ? | **disabled** placeholder (not in the current official notice) |

Notes:

- None of the growth-plan models need a console opt-in; token usage is
  deducted from the gift pack automatically.
- The two placeholders are carried over from the predecessor project
  ([opencode-cloudbase-auth](https://github.com/Le0nByte/opencode-cloudbase-auth))
  but are **not** in the current official notice, so they ship disabled. You
  can re-enable them in your Magpie/OpenCode config, and widen the function's
  allowlist via `AI_PROXY_ALLOWED_MODELS` — CloudBase itself decides what
  actually works and answers `AI_MODEL_NOT_SUPPORTED` otherwise.
- Models called outside the gift plan bill against your Token Credits
  resource pack (managed group `cloudbase`).

## What you need

1. A CloudBase environment (growth plan or an active Token Credits pack).
2. The **aiProxy function deployed** to that environment — see
   [`cloudfunctions/aiProxy/README.md`](cloudfunctions/aiProxy/README.md).
3. A **server-side CloudBase API Key**, created in the console at
   [tcb.cloud.tencent.com → Environment settings → API Key](https://tcb.cloud.tencent.com/dev?#/identity/token-management).

> ⚠️ **The API Key is the highest-privilege credential of the environment**
> (administrator permissions; it bypasses per-user data access checks).
> Keep it on your machine only. This plugin sends it exclusively as the
> `Authorization: Bearer` header of the function-invocation request and
> never writes it to source code, default config, logs, or error payloads.
> Magpie stores logins in `~/.config/magpie/plugin-auth.json` with mode 600.

## Install & login (Magpie)

```bash
# from npm (after you publish)
magpie plugin add opencode-cloudbase-bridge

# or straight from this GitHub repo
magpie plugin add DaBinBinah/cloudbase-bridge

# or load a local checkout in place
magpie plugin add ./cloudbase-bridge

magpie plugin login cloudbase
#   1. paste your CloudBase server API Key
#   2. enter your environment ID   (e.g. cloud1-2a3b4c5d6e7f)
#   3. pick the region             (中国大陆 default / 国际站)
#   4. cloud function name         (Enter = aiProxy)
```

Login answers are stored **per account** in Magpie's local auth store
(`metadata`: envId, region, functionName). Nothing is written into the repo
or npm package. Logout removes them:

```bash
magpie plugin logout cloudbase
```

In the Magpie app: open **插件**, add the plugin (npm name / `github:owner/repo` /
folder path), then sign in on the provider row. Model names appear as
`cloudbase/hy3`, `cloudbase/hy4-preview`, `cloudbase/deepseek-v4.1-flash`
(if Magpie already uses the `cloudbase` id, it becomes `cloudbase-plugin/…`
automatically — the plugin accepts both prefixes).

## Sandbox testing (does not touch your real Magpie data)

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./cloudbase-bridge   </dev/null
m plugin --json                   # hook/summary/errors reported by the host
m plugin login cloudbase          # walk every prompt
m provider test cloudbase         # tiny chat round-trip through aiProxy
m provider test cloudbase hy3     # one model only
m quota                           # usage hook (not implemented; see Limitations)
m plugin logout cloudbase
```

No Magpie installed, or want to try the plugin logic without a CloudBase
environment? Point it at the bundled mock gateway:

```bash
node scripts/mock-ai-proxy.mjs --port 8787            # terminal 1
# terminal 2 (sandbox as above), then:
m plugin options <plugin-short-name> '{"gatewayBaseUrl":"http://127.0.0.1:8787"}'
```

> `gatewayBaseUrl` is a **testing-only** option. It redirects every request
> — including your API Key header — to that URL. Remove the option
> (`magpie plugin options <name> off`) for real use, and never point it at
> an endpoint you don't control.

## Configuration reference

| What | Where | Values |
| --- | --- | --- |
| Environment ID / region / function name | login `prompts` (stored per account) | e.g. `cloud1-…`, `cn`/`intl`, `aiProxy` |
| Same values as fallbacks | plugin options (`plugins.json` → options) | `envId`, `region`, `functionName` — useful under plain OpenCode, where prompts may not be rendered |
| Invoke timeout | option `timeoutMs` | default 150000 ms (above the recommended 120 s function timeout) |
| Testing gateway override | option `gatewayBaseUrl` | unset in production |
| Model allowlist | function env var `AI_PROXY_ALLOWED_MODELS` | comma-separated ids; default `hy3,hy4,hy4-preview,deepseek-v4.1-flash,deepseek-v4.1-flash-1017` |
| Function timeout | CloudBase function config | **120 s** recommended |

Per-account values win over plugin options. The `provider.models` hook pings
aiProxy (`{"action":"ping"}`) and shows exactly the models the deployed
function's allowlist accepts; if the ping fails, the static catalog is kept.

## Local development

```bash
npm install
npm run check      # typecheck (tsc) + build + node --test + host-like load check
npm test           # build + unit tests (32 tests, no network needed)
node scripts/check-plugin.mjs   # loads dist/ like Magpie does, end-to-end vs a mock gateway
node scripts/mock-ai-proxy.mjs  # standalone mock of the gateway/function
```

**Verified in this repository** (macOS, Node 24, TypeScript 5.9): `tsc
--noEmit` clean, 32/32 unit tests pass, and the host-like load check passes
9/9 (module shape, config hook, auth prompts, loader, ping-driven model
list, non-streaming + streaming round-trips, `FUNCTIONS_NOT_FOUND` and bad-key
error mapping, no credential leakage in logs).

**NOT verified here — run these yourself against a real environment:** the
Magpie sandbox commands above, a real `aiProxy` deployment + `ping`, a real
chat completion through the growth plan, and quota behavior. This project
makes no claims about those until you run them.

## Limitations (by design, not bugs)

- **No true streaming.** The upstream reply is one JSON document; SSE is
  synthesized locally, so time-to-first-token equals full generation time.
  Short answers feel fine; long ones feel slow (same trade-off as the
  predecessor project).
- **No tool calling.** The documented `generateText` input carries
  `{ model, messages, temperature?, topP? }` only — `tools`/`tool_choice`
  are not forwarded, and the catalog declares `tool_call: false`.
- **No image input.** OpenAI-style image parts are rejected with
  `IMAGE_INPUT_NOT_SUPPORTED` (the SDK channel documents string content).
- **`max_tokens` is ignored** (not part of the documented SDK input).
- **Cloud function timeout truncates long outputs** — raise the function
  timeout to 120 s; the plugin's invoke timeout defaults to 150 s.
- **No usage/quota reporting** (`auth.usage`): CloudBase documents no HTTP
  API for growth-plan gift-pack balances, so the hook is not implemented.
- Growth-plan quota **expires** (6 months per the program terms).

## Differences from opencode-cloudbase-auth

This project replaces the predecessor and follows the current official docs
where the old code lagged:

| Topic | opencode-cloudbase-auth | cloudbase-bridge |
| --- | --- | --- |
| Model group | `createModel(provider)` with default `hunyuan-v3` | `createModel("cloudbase")` per the [official notice](https://docs.cloudbase.net/ai/ai-inspire-plan-new-models) |
| Model catalog | `hy3, hy4, hy4-preview, deepseek-v4.1-flash, deepseek-v4.1-flash-1017` | the 3 models confirmed by the notice enabled; the other 2 kept as disabled placeholders with source + date |
| Env id | collected at login | collected at login; also read by the function from `TCB_ENV` (runtime-injected) |
| Region | domestic gateway only | `cn` / `intl` gateway selection at login |
| Model list | static | refined per account from aiProxy's allowlist via `ping` |
| Language / shape | single `index.mjs` | TypeScript source, built `dist/` committed (required for Magpie's GitHub discovery), tests + load check |

## Repository layout

```
├── package.json              # npm package + magpie metadata + plugin entry
├── src/index.ts              # plugin source (TypeScript, zero runtime deps)
├── dist/index.js             # built entry — committed (GitHub discovery needs it)
├── cloudfunctions/aiProxy/   # the cloud function (Event Function, index.main)
├── cloudbaserc.example.json  # tcb CLI deploy config
├── test/                     # unit tests (node --test)
├── scripts/                  # host-like load check + mock gateway
├── docs/troubleshooting.md   # FUNCTIONS_NOT_FOUND, AI_CHANNEL_NOT_ALLOWED, …
├── docs/publish-checklist.md # GitHub release + Magpie listing steps
└── examples/registry-entry.json  # magpie-community registry.json entry
```

## Publish / list it (maintainers)

See [`docs/publish-checklist.md`](docs/publish-checklist.md) for the two
independent paths: the unofficial **GitHub topic discovery**
(`magpie-plugin`) and the curated **magpie-community registry** (separate PR).
Nothing in this repository has been submitted anywhere yet.

## License

[MIT](LICENSE).
