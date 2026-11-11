# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[SemVer](https://semver.org/).

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
