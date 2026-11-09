# aiProxy — CloudBase Event Function

A normal (Event) CloudBase cloud function that calls CloudBase AI models via
`@cloudbase/node-sdk` and returns an OpenAI Chat Completions compatible JSON
reply. The **CloudBase Bridge** Magpie plugin invokes this function through
the official function-invocation HTTP endpoint, so **the function must be
deployed in the same CloudBase environment as the API Key you configure in
the plugin**, under the name **`aiProxy`** (or a custom name you also set
during plugin login).

Why a cloud function? The "小程序成长计划" (mini-program growth plan) AI
quota is only spendable from CloudBase SDK channels — direct calls to
`/v1/ai/*` model endpoints fail with `AI_CHANNEL_NOT_ALLOWED`. Inside a cloud
function the Node SDK channel is allowed and the gift quota is deducted
automatically.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Function entry: `exports.main(event, context)` |
| `package.json` | Declares `@cloudbase/node-sdk` (^3.16.0, required for AI features) |

## What it accepts

```jsonc
// event (the plugin builds this from the Chat Completions request)
{
  "action": "chat",            // or "ping" (returns ok/env/model list)
  "model": "hy3",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "temperature": 0.7,          // optional, 0..2
  "topP": 0.9                  // optional, (0, 1]
}
```

Text-only: image parts and tool-call messages are rejected with a diagnostic
error (`IMAGE_INPUT_NOT_SUPPORTED` / `INVALID_REQUEST`) because the
documented `generateText` input carries plain string content.

## What it returns

Success — OpenAI Chat Completions JSON (this is the raw HTTP body; the
function-invocation API has no wrapper envelope):

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1762700000,
  "model": "hy3",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 42, "total_tokens": 52 }
}
```

Failure — `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`
with codes such as `INVALID_REQUEST`, `MODEL_NOT_ALLOWED`,
`AI_CHANNEL_NOT_ALLOWED`, `AI_MODEL_NOT_SUPPORTED`,
`EXCEED_TOKEN_QUOTA_LIMIT`, `TCB_ENV_MISSING`, `UPSTREAM_ERROR`.

## Deploy — Option A: console (控制台上传)

1. Open <https://tcb.cloud.tencent.com>, select your environment.
2. **云函数 / Cloud Functions → 新建函数**:
   - Name: `aiProxy`
   - Runtime: **Nodejs18.15**（或更新；创建后运行时不可更改）
   - Function type: **事件函数 (Event Function)**
   - Memory: 256 MB, **Timeout: 120 s**（文本生成较慢，默认 20 s 不够）
3. Paste `index.js` as the entry (execution method `index.main`), and
   `package.json` alongside it. Enable **云端安装依赖 (installDependency)**
   so `@cloudbase/node-sdk` is installed by the platform, or zip the folder
   with `node_modules` included.
4. Environment variables: none required — **`TCB_ENV` is injected by the
   CloudBase runtime automatically**. Optionally set
   `AI_PROXY_ALLOWED_MODELS` (comma-separated model ids) to restrict or
   extend the allowlist; the default is
   `hy3,hy4,hy4-preview,deepseek-v4.1-flash,deepseek-v4.1-flash-1017`.
5. Deploy, then verify with the console's inline test: invoke with
   `{"action":"ping"}` — expect `{"ok":true,"service":"aiProxy",...}`.

## Deploy — Option B: CLI (`tcb fn deploy`)

```bash
npm install -g @cloudbase/cli   # or: npm install -g @cloudbase/cli@latest
tcb login

# from the repository root
cp cloudbaserc.example.json cloudbaserc.json
# edit cloudbaserc.json: set envId to your environment id

tcb fn deploy aiProxy --force   # Event Function (no --httpFn)
tcb fn list                     # verify
tcb fn invoke aiProxy --params '{"action":"ping"}'
```

`installDependency: true` in the example config makes the platform install
`@cloudbase/node-sdk` from `package.json` (do **not** also upload
`node_modules`, they conflict).

## Security notes

- The function contains **no API Key and no environment id**. It trusts the
  CloudBase runtime (`TCB_ENV`) and authenticates to the model channel by
  the environment itself.
- Function invocation permissions are governed by **cloud function security
  rules + identity auth**. Admin identities (your server-side API Key)
  normally pass the default rule; if you see `EXCEED_AUTHORITY`, review the
  function security rules in the console
  (see `docs/troubleshooting.md`).
- Size limits: ≤128 messages, ≤200 000 chars per message, ≤400 000 chars
  total — keep agents from burning quota with runaway histories.
