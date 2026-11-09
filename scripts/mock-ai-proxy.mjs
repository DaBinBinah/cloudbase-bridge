#!/usr/bin/env node
/**
 * mock-ai-proxy.mjs — a local mock of the CloudBase gateway function
 * invocation endpoint (same semantics: POST /v1/functions/{name}, 200 body
 * = the function's return value) for offline sandbox testing of the
 * CloudBase Bridge plugin.
 *
 * Usage:
 *   node scripts/mock-ai-proxy.mjs [--port 8787] [--error FUNCTIONS_NOT_FOUND]
 *
 * Then run the plugin against it with a gatewayBaseUrl override, e.g.:
 *   magpie plugin options <plugin> '{"gatewayBaseUrl":"http://127.0.0.1:8787"}'
 *
 * (Testing only — never point the option at an untrusted endpoint; all
 * traffic, including your API key in the Authorization header, goes there.)
 */
import { createServer } from "node:http";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const port = Number(argValue("--port", "8787"));
const forcedError = argValue("--error", "");

const COMPLETION = (model) => ({
  id: "chatcmpl-mock001",
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "mock aiProxy reply：你好，这里是本地 mock。" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 10, total_tokens: 14 },
});

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    if (forcedError) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: forcedError, message: `mock forced error: ${forcedError}`, requestId: "mock-forced" }));
      return;
    }
    if (!req.url.startsWith("/v1/functions/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "FUNCTIONS_NOT_FOUND", message: "mock: unknown function path", requestId: "mock-1" }));
      return;
    }
    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!key) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "PERMISSION_DENIED", message: "mock: missing bearer key", requestId: "mock-2" }));
      return;
    }
    let event = {};
    try {
      event = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "FUNCTIONS_PARAM_INVALID", message: "mock: body is not JSON", requestId: "mock-3" }));
      return;
    }
    if (event.action === "ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "aiProxy",
          version: "1.0.0",
          env: "mock-env",
          models: ["hy3", "hy4", "hy4-preview", "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017"],
        }),
      );
      return;
    }
    if (!event.model || !Array.isArray(event.messages)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "INVALID_REQUEST", message: "mock: event must carry model + messages" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(COMPLETION(event.model)));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock aiProxy gateway listening on http://127.0.0.1:${port}`);
  console.log("Try:");
  console.log(`  curl -s http://127.0.0.1:${port}/v1/functions/aiProxy -H 'authorization: Bearer test' -H 'content-type: application/json' -d '{"action":"ping"}'`);
  console.log(`  curl -s http://127.0.0.1:${port}/v1/functions/aiProxy -H 'authorization: Bearer test' -H 'content-type: application/json' -d '{"model":"hy3","messages":[{"role":"user","content":"hi"}]}'`);
});
