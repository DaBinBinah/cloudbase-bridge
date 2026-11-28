# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[SemVer](https://semver.org/).

## [0.2.12] - 2026-11-28

- Magpie can now offer model-specific thinking levels from `aiProxy`. DSH **Off** explicitly disables thinking; **High** requests it. Disabling the level selector in Magpie instead leaves thinking up to the model.
- To use this feature, update the plugin, deploy the [unified `aiProxy` ZIP](https://github.com/DaBinBinah/cloudbase-bridge/releases/download/v0.2.12/aiProxy-unified-with-deps.zip), and refresh models. With no reasoning fields in a chat request the existing behavior is unchanged, including for 0.2.4 clients. Image generation does not receive reasoning fields.

## [0.2.11] - 2026-11-27

- Deploy a single `aiProxy` ZIP for chat, image input and optional image generation. Existing split deployments keep working. The plugin checks capabilities before sending an image prompt; it never retries a submitted generation against another function.
- Explicit canvas ratios set image dimensions (5:2 → 1600×640); otherwise the bundled function requests 1024×1024. Use `{"action":"checkImage"}` for a model-free self-test.
- Chat-only users, including plugin 0.2.4, do not need to change anything. Keep the separate `generateImage` for older image-enabled clients.

## [0.2.10] - 2026-11-25

- DSH web image replies now show an inline preview and an **打开原图**
  link. Enable **Always show image previews** if the gateway strips DSH
  markers. Other clients still receive a bare URL by default.
- The separate `generateImage` release ZIP supports `IMAGE_FOOTNOTE_MODE`
  (`empty`, `space`, `omit`) and a non-generating `{"action":"check"}`.
  Image generation remains opt-in; chat and `aiProxy` are unchanged.

## [0.2.9] - 2026-11-25

- Optional DSH text-to-image: enable **Image generation**, select
  `cloudbase/hy-image-v3.5-preview`, and open the returned image link.
  Only the current text prompt goes to the separate `generateImage`
  function. DSH title requests and runtime context are not image prompts.
- Image generation is off by default. Chat still uses the configured
  `aiProxy`; its code and deployment package are unchanged from 0.2.8.
  Users on plugin 0.2.4 need neither an upgrade nor a redeploy for chat.

## [0.2.8] - 2026-11-24

- Image input: aiProxy 1.3.0 forwards OpenAI `image_url` parts on user
  messages (an `http(s)` link or a `data:image/...;base64` URL) to the
  model instead of answering `IMAGE_INPUT_NOT_SUPPORTED` (HTTP 400). The
  official model list marks `hy4`, `hy4-flash`, `deepseek-v4.1-flash` and
  `deepseek-v4.1-flash-1017` as image-capable. `hy3` takes text only and
  still gets `IMAGE_INPUT_NOT_SUPPORTED`, now with a message that names
  the image-capable models. **Redeploy the function**
  (`tcb fn deploy aiProxy --force`); plugins 0.2.4 to 0.2.7 already pass
  the parts through, so the function update alone enables images.
  Checked on a live environment with `hy4`, `hy4-flash`,
  `deepseek-v4.1-flash` and `deepseek-v4.1-flash-1017` (data URLs up to
  5.2 MB, `https` links, images kept in history, images with tool calls);
  `hy4-preview` could not be checked.
- The model catalog declares `modalities` per model, so the host stops
  offering image input for `hy3`.

## [0.2.7] - 2026-11-24

- Request size: the plugin forwards requests of up to 6 MiB (was 512 KiB)
  and aiProxy 1.2.1 accepts up to 10 000 messages and 6 MiB of message
  text (was 128 messages / 400 000 chars). 6 MB is the synchronous event
  size CloudBase functions accept. The old limits were far below the 1M
  context the catalog declares, so agents hit `PAYLOAD_TOO_LARGE` (HTTP
  413) long before they would compact their history. **Redeploy the
  function** (`tcb fn deploy aiProxy --force`): with aiProxy 1.2.0 or
  older, a request over the old limits is still rejected by the function.

## [0.2.6] - 2026-11-24

- Thinking-mode tool turns: `reasoning_content` is now returned by aiProxy
  and the plugin (JSON and synthesized SSE), and aiProxy forwards it back
  to the model on assistant messages. It was dropped in both directions
  before.
- A reply that ends at the token limit while carrying tool calls now keeps
  `finish_reason: "length"` instead of being reported as `"tool_calls"`,
  and the plugin drops a tool call whose arguments were cut off.
- aiProxy 1.2.0, from #1 by @ryanuo: `topP: 0` is accepted (the range is
  `[0, 1]`), and failures from the SDK or the model keep their `code` but
  return a generic message; the original message goes to the function log.
  Errors raised by aiProxy itself keep their text. **Redeploy the
  function** (`tcb fn deploy aiProxy --force`) to get these; aiProxy 1.2.0
  still works with plugin 0.2.4 and 0.2.5.

## [0.2.5] - 2026-11-24

- Tool calling: the plugin now forwards `tools`, `tool_choice` and
  `max_tokens` / `max_completion_tokens` to aiProxy instead of dropping
  them, and returns the model's `tool_calls` (JSON and synthesized SSE,
  `finish_reason: "tool_calls"`). The catalog declares `tool_call: true`.
- aiProxy 1.1.0: accepts `tools`, `toolChoice`, `maxTokens`, `tool`
  messages and assistant `tool_calls`; calls `generateText` with
  `maxSteps: 1` so the model's tool calls go back to the agent; keeps the
  upstream `finish_reason` (e.g. `length`). **Redeploy the function**
  (`tcb fn deploy aiProxy --force`) — aiProxy 1.0.0 ignores `tools` and
  rejects tool messages.
- `scripts/check-plugin.mjs`: the config-hook check is awaited and no
  longer expects `hy4` to be disabled.

## [0.2.4] - 2026-11-23

- Model refresh (2026-11-23, from my environment's current list): add
  `hy4-flash` and enable `hy4` — the catalog is now six text models
  (`hy4-flash`, `hy4`, `hy4-preview`, `hy3`, `deepseek-v4.1-flash`,
  `deepseek-v4.1-flash-1017`), all enabled by default. aiProxy's default
  allowlist matches. `hy-image-v3.5-preview` (image generation) is out of
  scope for this text-chat bridge.
- Overall review pass: the model catalog now matches the README table —
  `hy4` and `deepseek-v4.1-flash-1017` context documented as 1M in code
  too (was a conservative 128K placeholder); a unit test locks the
  catalog to the documented table.
- Project logo added to the top of both READMEs and to
  `examples/registry-entry.json` (`icon` field) for the community
  registry listing; local `cloudbaserc.json` is now gitignored.

## [0.2.3] - 2026-11-12

- Replace the shields.io image badge with a plain text link to the
  repository — Magpie's detail page does not reliably render remote
  images, so the GitHub link was invisible there.

## [0.2.2] - 2026-11-12

- Add a GitHub badge to both READMEs (renders as a button in Magpie's plugin
  detail page and on npm, linking to the repository).

## [0.2.1] - 2026-11-10

- Replace the plugin icon with the project logo (sprout + network) in
  `magpie.icon` — used by Magpie's discovery cards and installed list
  (GitHub-topic and npm sources alike).

## [0.2.0] - 2026-11-09

- **Enable `deepseek-v4.1-flash-1017` by default.** I verified it
  end-to-end through aiProxy in my own CloudBase environment (2026-11).
  It is not part of the official growth-plan notice; availability may differ
  per environment — CloudBase answers `AI_MODEL_NOT_SUPPORTED` where it is
  unavailable. `hy4` remains an unverified, disabled placeholder.
- `provider.models` no longer leaks a stale `disabled: true` for models the
  deployed aiProxy allowlist explicitly returns in its `ping` reply (the
  flag is stripped for every ping-allowed id).
- The request payload size limit now measures real UTF-8 bytes
  (`new TextEncoder().encode(payload).byteLength`) instead of JavaScript
  string length, which under-counted CJK content (each CJK char is typically
  3 UTF-8 bytes but 1 UTF-16 code unit). The 413 error message and the
  debug log's `bytes=` field now report accurate byte counts.
- Tests: new cases for the 1017 default-enabled state, disabled-flag
  stripping on ping, UTF-8 byte accounting for CJK payloads, `hy4` staying
  disabled, and the aiProxy allowlist containing `deepseek-v4.1-flash-1017`.

## [0.1.0] - 2026-11-09

Initial release.

- Magpie/OpenCode provider plugin (`cloudbase` provider id) that invokes the
  user-deployed `aiProxy` CloudBase cloud function through the official
  CloudBase HTTP function-invocation endpoint
  (`POST https://{envId}.api.tcloudbasegateway.com/v1/functions/{name}`).
- Adapts the one-shot cloud-function JSON reply into an OpenAI Chat
  Completions response and synthesizes SSE frames (role chunk, content
  chunks, final chunk, `[DONE]`) when the agent requests `stream: true`.
- Login flow collects environment ID, region (domestic/international) and
  cloud-function name; the CloudBase server-side API Key is stored only in
  Magpie's local auth store (`plugin-auth.json`, mode 600).
- Model catalog (official growth-plan notice, verified 2026-11-09):
  `hy3`, `hy4-preview`, `deepseek-v4.1-flash` enabled;
  `hy4`, `deepseek-v4.1-flash-1017` shipped as disabled placeholders.
- Cloud function `aiProxy` (Event Function, `index.main`) using
  `@cloudbase/node-sdk` `ai.createModel("cloudbase")` + `generateText`,
  env ID read from `TCB_ENV`, model allowlist via `AI_PROXY_ALLOWED_MODELS`.
- Unit tests (`node --test`), plugin load check script and a local mock
  aiProxy server for sandbox testing.
