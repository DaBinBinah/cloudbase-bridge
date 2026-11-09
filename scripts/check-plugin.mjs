#!/usr/bin/env node
/**
 * check-plugin.mjs — simulates how Magpie loads a plugin (mirroring
 * `bun scripts/check.mjs` from the magpie-community/plugins repo):
 *
 *   1. import the built entry (dist/index.js) the way the plugin host does;
 *   2. assert the module export shape (no stray exported functions);
 *   3. call the plugin function with a minimal OpenCode PluginInput;
 *   4. exercise the `config`, `auth` (methods/loader) and `provider` hooks
 *      end-to-end against an in-process mock of the CloudBase function
 *      gateway (same semantics: 200 body = function return value).
 *
 * Exit code 0 = all checks passed. This is a load/behavior check; it does
 * NOT talk to a real CloudBase environment — run the magpie sandbox
 * commands from the README for that.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as pluginModule from "../dist/index.js";

const { CloudbaseBridge } = pluginModule;
const TEST_KEY = "sandbox-key-never-real";
let failures = 0;

function ok(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${label}\n    ${error?.stack ?? error}`);
  }
}

async function okAsync(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${label}\n    ${error?.stack ?? error}`);
  }
}

/** In-process mock of the CloudBase gateway function-invocation endpoint. */
function startMockGateway() {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!req.url.startsWith("/v1/functions/aiProxy")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "FUNCTIONS_NOT_FOUND", message: "mock: no such function", requestId: "mock-1" }));
        return;
      }
      if ((req.headers.authorization ?? "") !== `Bearer ${TEST_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "PERMISSION_DENIED", message: "mock: bad key", requestId: "mock-2" }));
        return;
      }
      const event = JSON.parse(raw || "{}");
      if (event.action === "ping") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "aiProxy", version: "1.0.0", env: "env-mock", models: ["hy3", "deepseek-v4.1-flash"] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock001",
          object: "chat.completion",
          created: 1_762_700_000,
          model: event.model,
          choices: [{ index: 0, message: { role: "assistant", content: "mock reply: 你好！" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

console.log("check-plugin: loading dist/index.js like the magpie host would");

// 1. Module export shape — every exported function is treated as a plugin.
ok("module exports only the plugin entry (+ _internal, PLUGIN_VERSION)", () => {
  const keys = Object.keys(pluginModule).sort();
  assert.deepEqual(keys, ["CloudbaseBridge", "PLUGIN_VERSION", "_internal"]);
  assert.equal(typeof pluginModule.CloudbaseBridge, "function");
  assert.equal(typeof pluginModule._internal, "object");
});

// Minimal PluginInput with a log sink.
const logs = [];
const input = {
  client: { app: { log: async (args) => void logs.push(args) } },
  project: { id: "magpie", worktree: "." },
  directory: process.cwd(),
};

const hooks = await CloudbaseBridge(input, {});
console.log("check-plugin: hooks created");

ok("config hook declares the cloudbase provider with the model catalog", async () => {
  const cfg = {};
  await hooks.config(cfg);
  const provider = cfg.provider?.cloudbase;
  assert.ok(provider, "provider.cloudbase missing");
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  for (const id of ["hy3", "hy4-preview", "deepseek-v4.1-flash", "hy4", "deepseek-v4.1-flash-1017"]) {
    assert.ok(provider.models[id], `model ${id} missing`);
  }
  assert.equal(provider.models.hy4.disabled, true);
});

ok("auth hook shape: provider id, api method, prompts", () => {
  assert.equal(hooks.auth.provider, "cloudbase");
  const method = hooks.auth.methods[0];
  assert.equal(method.type, "api");
  assert.ok(Array.isArray(method.prompts) && method.prompts.some((p) => p.key === "envId"));
});

// Spin up the mock gateway and run the loader end-to-end through it.
const server = await startMockGateway();
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const hooksLive = await CloudbaseBridge(input, { gatewayBaseUrl: baseUrl });
const auth = { type: "api", key: TEST_KEY, metadata: { envId: "env-mock", region: "cn", functionName: "aiProxy" } };

await okAsync("loader returns baseURL + fetch for a signed-in account", async () => {
  const loaded = await hooksLive.auth.loader(async () => auth);
  assert.equal(loaded.baseURL, baseUrl);
  assert.equal(typeof loaded.fetch, "function");
  const empty = await hooksLive.auth.loader(async () => undefined);
  assert.deepEqual(empty, {});
});

await okAsync("provider.models refines the account model list via ping", async () => {
  const cfg = {};
  await hooksLive.config(cfg);
  const refined = await hooksLive.provider.models({ models: cfg.provider.cloudbase.models }, { auth });
  assert.deepEqual(Object.keys(refined).sort(), ["deepseek-v4.1-flash", "hy3"]);
});

await okAsync("end-to-end non-streaming request returns chat.completion JSON", async () => {
  const loader = await hooksLive.auth.loader(async () => auth);
  const res = await loader.fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "cloudbase/hy3", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.object, "chat.completion");
  assert.equal(payload.model, "cloudbase/hy3");
  assert.equal(payload.choices[0].message.content, "mock reply: 你好！");
});

await okAsync("end-to-end streaming request returns SSE ending with [DONE]", async () => {
  const loader = await hooksLive.auth.loader(async () => auth);
  const res = await loader.fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "hy3", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
  const text = await res.text();
  assert.ok(text.endsWith("data: [DONE]\n\n"), "stream must end with data: [DONE]");
  assert.ok(text.includes('"delta":{"role":"assistant"'), "first chunk must carry the assistant role");
});

await okAsync("gateway FUNCTIONS_NOT_FOUND maps to 404 with deploy hint", async () => {
  const loader = await hooksLive.auth.loader(async () => ({ ...auth, metadata: { ...auth.metadata, functionName: "missingFn" } }));
  const res = await loader.fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "hy3", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(res.status, 404);
  const payload = await res.json();
  assert.equal(payload.error.code, "FUNCTIONS_NOT_FOUND");
  assert.match(payload.error.message, /deploy/i);
});

await okAsync("bad API key maps to 401 authentication error", async () => {
  const loader = await hooksLive.auth.loader(async () => ({ ...auth, key: "wrong-key" }));
  const res = await loader.fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "hy3", messages: [{ role: "user", content: "hi" }], stream: false }),
  });
  assert.equal(res.status, 401);
  const payload = await res.json();
  assert.equal(payload.error.type, "authentication_error");
});

server.close();

console.log(`check-plugin: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(`(plugin logs captured: ${logs.length} entries, none contain the test key: ${!JSON.stringify(logs).includes(TEST_KEY)})`);
process.exit(failures === 0 ? 0 : 1);
