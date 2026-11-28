# aiProxy — CloudBase Event Function

A normal (Event) CloudBase cloud function that calls CloudBase AI models via
`@cloudbase/node-sdk` and returns an OpenAI Chat Completions compatible JSON
reply. The **CloudBase Bridge** Magpie plugin invokes this function through
the official function-invocation HTTP endpoint, so **the function must be
deployed in the same CloudBase environment as the API Key you configure in
the plugin**, under the name **`aiProxy`** (or a custom name you also set
during plugin login).

This directory is the **chat-only source deployment** (including image input).
For chat and image generation on one function use the [unified release ZIP](https://github.com/DaBinBinah/cloudbase-bridge/releases/download/v0.2.12/aiProxy-unified-with-deps.zip) instead. See the [deployment settings](../../README.md#models).
Calling the SDK from a cloud function does not change the original caller's eligibility for [CloudBase gift quota](https://docs.cloudbase.net/ai/ai-inspire-plan-usage-governance).

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
  "topP": 0.9,                 // optional, [0, 1]
  "maxTokens": 1024,           // optional, positive integer
  "reasoning_effort": "high",  // optional; ping.reasoningLevels[model] lists supported levels
  "tools": [                   // optional, OpenAI function tools
    { "type": "function", "function": { "name": "read_file", "description": "...", "parameters": { "type": "object" } } }
  ],
  "toolChoice": "auto"         // optional: "auto" | "none" | "required" | { type: "function", function: { name } }
}
```

Messages may also use the `tool` role (with `tool_call_id`) and assistant
messages may carry `tool_calls`, so an agent can send tool results back.
The function never runs a tool itself: it asks the model for one step and
returns the model's `tool_calls` (with `finish_reason: "tool_calls"`) to
the caller. A reply cut off at the token limit keeps `finish_reason:
"length"` even when it carries tool calls, because their arguments can be
incomplete.

Thinking-mode models: `message.reasoning_content` is returned when the model
sends it, and is forwarded back to the model on every assistant message
that carries it (such models reject a tool-enabled request whose earlier
turns lack their reasoning).

The function in the v0.2.12 release accepts `reasoning_effort` and/or `thinking: {type: "enabled" | "disabled"}`.
`none` switches thinking off; omitted controls preserve the model default. Conflicting or unsupported settings fail before `generateText`.

Image input: a `user` message may carry OpenAI `image_url` parts next to
its text parts. The url is an `http(s)` link the model service can reach,
or a `data:image/...;base64,…` URL; `detail` (`low` / `high` / `auto`) is
kept. The parts are passed to `generateText` in the array form the
[CloudBase multimodal API](https://docs.cloudbase.net/ai/model/multimodal)
takes, and an inline image counts toward the 6 MiB of message text.
`IMAGE_INPUT_NOT_SUPPORTED` is returned for an image on a non-user message
and for an image sent to `hy3`, which the
[official model list](https://docs.cloudbase.net/ai/available-models) marks
as text-only. Other part types (video, file) get `INVALID_REQUEST`.

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

Errors raised by the function itself (`INVALID_REQUEST`,
`IMAGE_INPUT_NOT_SUPPORTED`, `MODEL_NOT_ALLOWED`, `TCB_ENV_MISSING`, a
missing SDK) keep their full message. Failures from the SDK or the model
keep their `code`, but the message is replaced by a generic one so
endpoints, account ids and quota details do not reach the client. The
original message is written to the function log (`[aiProxy] model call
failed`) together with the `requestId`.

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
   `hy4-flash,hy4,hy4-preview,hy3,deepseek-v4.1-flash,deepseek-v4.1-flash-1017`
   (`deepseek-v4.1-flash-1017` I verified in my own environment, though it
   is not in the official growth-plan notice; `hy4` is an unverified
   placeholder. CloudBase itself rejects ids it does not support with
   `AI_MODEL_NOT_SUPPORTED`).
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
- Size limits: ≤10 000 messages and ≤6 MiB of message text (6 291 456
  chars), matching the 6 MB synchronous event CloudBase accepts. aiProxy
  1.2.0 and older stop at 128 messages / 400 000 chars.
