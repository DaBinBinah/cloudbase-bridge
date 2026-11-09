# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[SemVer](https://semver.org/).

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
  `hy4`, `deepseek-v4.1-flash-1017` carried over from the previous project
  as disabled placeholders.
- Cloud function `aiProxy` (Event Function, `index.main`) using
  `@cloudbase/node-sdk` `ai.createModel("cloudbase")` + `generateText`,
  env ID read from `TCB_ENV`, model allowlist via `AI_PROXY_ALLOWED_MODELS`.
- Unit tests (`node --test`), plugin load check script and a local mock
  aiProxy server for sandbox testing.
