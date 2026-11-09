/**
 * Unit tests for the CloudBase Bridge plugin (built output dist/index.js —
 * the artifact Magpie actually loads).
 *
 * Run: npm test  (node --test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as pluginModule from "../dist/index.js";

const { CloudbaseBridge, _internal, PLUGIN_VERSION } = pluginModule;

const TEST_KEY = "test-apikey-not-a-real-secret";

/** Build a plugin instance with mocked logging. */
async function makePlugin() {
  const logs = [];
  const input = {
    client: {
      app: {
        log: async (args) => {
          logs.push(args);
        },
      },
    },
    project: { id: "test" },
    directory: "/tmp",
  };
  const hooks = await CloudbaseBridge(input, {});
  return { hooks, logs };
}

/** Fake auth as stored by Magpie after `magpie plugin login cloudbase`. */
function fakeAuth(overrides = {}) {
  return {
    type: "api",
    key: TEST_KEY,
    metadata: { envId: "env-test-1", region: "cn", functionName: "aiProxy", ...overrides },
  };
}

/** Install a mock CloudBase gateway on globalThis.fetch; returns the calls. */
function mockGateway(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init, calls);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A chat.completion body exactly as aiProxy returns it. */
function aiProxyCompletion(content = "hello from hy3", usage = { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 }) {
  return {
    id: "chatcmpl-test001",
    object: "chat.completion",
    created: 1_762_700_000,
    model: "hy3",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage,
  };
}

function chatBody(overrides = {}) {
  return JSON.stringify({
    model: "hy3",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    ...overrides,
  });
}

async function loaderFetch(hooks, auth = fakeAuth()) {
  const loader = await hooks.auth.loader(async () => auth);
  assert(loader && typeof loader.fetch === "function", "loader must return a fetch");
  return (body, init = {}) => loader.fetch("https://placeholder/v1/chat/completions", { method: "POST", body, ...init });
}

/* ---------------- module shape ---------------- */

test("module exports only the plugin function and the _internal object", () => {
  const exportKeys = Object.keys(pluginModule).sort();
  assert.deepEqual(exportKeys, ["CloudbaseBridge", "PLUGIN_VERSION", "_internal"]);
  assert.equal(typeof CloudbaseBridge, "function");
  assert.equal(typeof _internal, "object");
  assert.ok(!("server" in _internal), "_internal must not look like a { server } export");
  assert.equal(typeof PLUGIN_VERSION, "string");
});

/* ---------------- normalizeModel ---------------- */

test("normalizeModel strips provider prefixes only at the boundary", () => {
  assert.equal(_internal.normalizeModel("cloudbase/hy3"), "hy3");
  assert.equal(_internal.normalizeModel("cloudbase-plugin/hy3"), "hy3");
  assert.equal(_internal.normalizeModel("cloudbase/cloudbase/hy3"), "hy3");
  assert.equal(_internal.normalizeModel("hy3"), "hy3");
  assert.equal(_internal.normalizeModel("cloudbase/hy3 "), "hy3");
  assert.equal(_internal.normalizeModel("other/hy3"), "other/hy3");
  assert.equal(_internal.normalizeModel("cloudbase/"), null);
  assert.equal(_internal.normalizeModel(""), null);
  assert.equal(_internal.normalizeModel(undefined), null);
  assert.equal(_internal.normalizeModel(42), null);
});

/* ---------------- config hook ---------------- */

test("config hook declares provider with catalog; ??= preserves user config", async () => {
  const { hooks } = await makePlugin();

  const cfg = {};
  await hooks.config(cfg);
  const provider = cfg.provider.cloudbase;
  assert.ok(provider);
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  const models = provider.models;
  for (const id of ["hy3", "hy4", "hy4-preview", "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017"]) {
    assert.ok(models[id], `catalog must contain ${id}`);
  }
  assert.ok(models["hy4"].disabled, "unverified hy4 must stay disabled");
  assert.ok(!models["deepseek-v4.1-flash-1017"].disabled, "verified 1017 must be enabled by default");
  assert.ok(!models["hy3"].disabled && !models["hy4-preview"].disabled && !models["deepseek-v4.1-flash"].disabled);
  assert.equal(models["deepseek-v4.1-flash-1017"].name, "DeepSeek V4.1 Flash 1017");
  assert.equal(models["hy3"].tool_call, false);

  // Second run must not overwrite user config.
  const userCfg = { provider: { cloudbase: { name: "Mine", models: { custom: {} } } } };
  await hooks.config(userCfg);
  assert.equal(userCfg.provider.cloudbase.name, "Mine");
  assert.ok(userCfg.provider.cloudbase.models.custom);
});

/* ---------------- loader & auth surface ---------------- */

test("auth hook exposes provider id, api method and login prompts", async () => {
  const { hooks } = await makePlugin();
  assert.equal(hooks.auth.provider, "cloudbase");
  const method = hooks.auth.methods[0];
  assert.equal(method.type, "api");
  const promptKeys = method.prompts.map((p) => p.key);
  assert.deepEqual(promptKeys, ["envId", "region", "functionName"]);
  assert.equal(method.prompts[0].validate("cloud1-abcdefgh"), undefined);
  assert.notEqual(method.prompts[0].validate("bad id!"), undefined);
  assert.equal(method.prompts[2].validate(""), undefined, "empty function name falls back to aiProxy");
  assert.equal(method.prompts[2].validate("my_proxy-1"), undefined);
  assert.notEqual(method.prompts[2].validate("1bad"), undefined);
});

test("loader returns empty config when not signed in", async () => {
  const { hooks } = await makePlugin();
  const loader = await hooks.auth.loader(async () => undefined);
  assert.deepEqual(loader, {});
});

test("loader builds the gateway URL from envId/region", async () => {
  const { hooks } = await makePlugin();
  const cn = await hooks.auth.loader(async () => fakeAuth());
  assert.ok(String(cn.baseURL).startsWith("https://env-test-1.api.tcloudbasegateway.com"));
  const intl = await hooks.auth.loader(async () => fakeAuth({ region: "intl" }));
  assert.ok(String(intl.baseURL).includes(".api.intl.tcloudbasegateway.com"));
});

/* ---------------- bridge: non-streaming ---------------- */

test("bridge non-streaming: adapts aiProxy JSON, echoes requested model id, sends no stream field", async () => {
  const { hooks } = await makePlugin();
  const gw = mockGateway(async () => new Response(JSON.stringify(aiProxyCompletion()), { status: 200 }));
  try {
    const doFetch = await loaderFetch(hooks);
    const res = await doFetch(chatBody({ model: "cloudbase/hy3" }));
    assert.equal(res.status, 200);

    const call = gw.calls[0];
    assert.equal(call.url, "https://env-test-1.api.tcloudbasegateway.com/v1/functions/aiProxy");
    assert.equal(call.init.headers.authorization, `Bearer ${TEST_KEY}`);
    const sentEvent = JSON.parse(call.init.body);
    assert.equal(sentEvent.action, "chat");
    assert.equal(sentEvent.model, "hy3");
    assert.equal("stream" in sentEvent, false);
    assert.equal(sentEvent.messages.length, 1);

    const payload = await res.json();
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.model, "cloudbase/hy3", "response must echo the requested model id");
    assert.equal(payload.choices[0].message.content, "hello from hy3");
    assert.deepEqual(payload.usage.total_tokens, 14);
  } finally {
    gw.restore();
  }
});

/* ---------------- bridge: streaming ---------------- */

test("bridge streaming: synthesizes SSE with role/content/finish chunks and [DONE]", async () => {
  const { hooks } = await makePlugin();
  const gw = mockGateway(async () => new Response(JSON.stringify(aiProxyCompletion("第一段。Second part!")), { status: 200 }));
  try {
    const doFetch = await loaderFetch(hooks);
    const res = await doFetch(chatBody({ stream: true }));
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
    assert.equal(res.headers.get("content-length"), null, "streamed body must not carry content-length");

    const text = await res.text();
    const frames = text
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    assert.equal(frames[frames.length - 1], "[DONE]");
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.model, "hy3");
    }
    const roleChunk = chunks[0];
    assert.deepEqual(roleChunk.choices[0].delta.role, "assistant");
    const content = chunks
      .slice(1, -1)
      .map((c) => c.choices[0].delta.content ?? "")
      .join("");
    assert.equal(content, "第一段。Second part!", "content chunks must reassemble exactly");
    const final = chunks[chunks.length - 1];
    assert.equal(final.choices[0].finish_reason, "stop");
    assert.deepEqual(final.usage, { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 });
  } finally {
    gw.restore();
  }
});

test("bridge streaming: respects agent abort (an already-aborted request rejects like native fetch)", async () => {
  const { hooks } = await makePlugin();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.signal?.aborted) {
      throw new DOMException("This operation was aborted", "AbortError");
    }
    return new Response(JSON.stringify(aiProxyCompletion("x".repeat(500))), { status: 200 });
  };
  try {
    const loader = await hooks.auth.loader(async () => fakeAuth());
    const controller = new AbortController();
    controller.abort(); // abort before the call, like a cancelled agent request
    const resPromise = loader.fetch("https://placeholder/v1/chat/completions", {
      method: "POST",
      body: chatBody({ stream: true }),
      signal: controller.signal,
    });
    await assert.rejects(() => resPromise, undefined, "an aborted request must reject");
  } finally {
    globalThis.fetch = original;
  }
});

/* ---------------- bridge: error mapping ---------------- */

test("gateway error codes map to statuses that keep Magpie failover sane", async () => {
  const { hooks } = await makePlugin();

  const cases = [
    ["FUNCTIONS_NOT_FOUND", 404, /deploy/i],
    ["PERMISSION_DENIED", 401, /API key/],
    ["EXCEED_AUTHORITY", 403, /security rules/i],
    ["AI_CHANNEL_NOT_ALLOWED", 403, /SDK channels/i],
    ["AI_MODEL_NOT_SUPPORTED", 404, /model/i],
    ["EXCEED_TOKEN_QUOTA_LIMIT", 429, /quota/i],
    ["FUNCTIONS_TIME_LIMIT_EXCEEDED", 504, /timeout/i],
    ["FUNCTIONS_INVOCATION_FAILED", 502, /logs/i],
    ["SOMETHING_ELSE", 400, /SOMETHING_ELSE/],
  ];

  for (const [code, expectedStatus, messageMatch] of cases) {
    const gw = mockGateway(async () =>
      new Response(JSON.stringify({ code, message: `upstream says ${code}`, requestId: "req-x" }), { status: 400 }),
    );
    try {
      const doFetch = await loaderFetch(hooks);
      const res = await doFetch(chatBody());
      assert.equal(res.status, expectedStatus, `code ${code} must map to ${expectedStatus}`);
      const payload = await res.json();
      assert.equal(payload.error.code, code);
      assert.match(payload.error.message, messageMatch);
      assert.match(payload.error.message, /upstream says/, "must surface the upstream message for diagnosis");
      assert.equal(payload.error.requestId, "req-x");
      assert.ok(!JSON.stringify(payload).includes(TEST_KEY), "no API key in errors");
    } finally {
      gw.restore();
    }
  }
});

test("aiProxy error envelopes map by code", async () => {
  const { hooks } = await makePlugin();
  const cases = [
    [{ code: "INVALID_REQUEST", message: "bad" }, 400],
    [{ code: "MODEL_NOT_ALLOWED", message: "nope" }, 404],
    [{ code: "AI_MODEL_NOT_SUPPORTED", message: "nope" }, 404],
    [{ code: "AI_CHANNEL_NOT_ALLOWED", message: "nope" }, 403],
    [{ code: "EXCEED_TOKEN_QUOTA_LIMIT", message: "nope" }, 429],
    [{ code: "TCB_ENV_MISSING", message: "no TCB_ENV" }, 502],
    [{ code: "UPSTREAM_ERROR", message: "boom" }, 502],
  ];
  for (const [envelope, expectedStatus] of cases) {
    const gw = mockGateway(async () => new Response(JSON.stringify({ error: envelope }), { status: 200 }));
    try {
      const doFetch = await loaderFetch(hooks);
      const res = await doFetch(chatBody());
      assert.equal(res.status, expectedStatus, `${envelope.code} -> ${expectedStatus}`);
      const payload = await res.json();
      assert.equal(payload.error.code, envelope.code);
    } finally {
      gw.restore();
    }
  }
});

test("non-JSON and shapeless aiProxy replies become 502", async () => {
  const { hooks } = await makePlugin();

  const gw1 = mockGateway(async () => new Response("<html>boom</html>", { status: 200 }));
  try {
    const doFetch = await loaderFetch(hooks);
    const res = await doFetch(chatBody());
    assert.equal(res.status, 502);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_FUNCTION_JSON");
  } finally {
    gw1.restore();
  }

  const gw2 = mockGateway(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  try {
    const doFetch = await loaderFetch(hooks);
    const res = await doFetch(chatBody());
    assert.equal(res.status, 502);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVALID_FUNCTION_RESPONSE");
  } finally {
    gw2.restore();
  }
});

test("unknown model ids are rejected locally with 404 (no cloud call)", async () => {
  const { hooks } = await makePlugin();
  const gw = mockGateway(async () => new Response("{}", { status: 200 }));
  try {
    const doFetch = await loaderFetch(hooks);
    const res = await doFetch(chatBody({ model: "gpt-4o" }));
    assert.equal(res.status, 404);
    const payload = await res.json();
    assert.match(payload.error.message, /Known models:/);
    assert.equal(gw.calls.length, 0, "must not spend a cloud invocation on unknown models");
  } finally {
    gw.restore();
  }
});

test("oversized conversations are rejected with 413", async () => {
  const { hooks } = await makePlugin();
  const doFetch = await loaderFetch(hooks);
  const res = await doFetch(
    chatBody({ messages: [{ role: "user", content: "x".repeat(_internal.DEFAULT_MAX_EVENT_BYTES) }] }),
  );
  assert.equal(res.status, 413);
});

test("payload limit counts UTF-8 bytes, not JavaScript string length (CJK content)", async () => {
  const { hooks } = await makePlugin();
  const gw = mockGateway(async () => new Response(JSON.stringify(aiProxyCompletion()), { status: 200 }));
  try {
    const doFetch = await loaderFetch(hooks);

    // Small CJK request passes normally.
    const okRes = await doFetch(chatBody({ messages: [{ role: "user", content: "你好，世界" }] }));
    assert.equal(okRes.status, 200);

    // 200_000 CJK chars: only 200_000 UTF-16 code units (below the 512 KiB
    // limit, so a naive .length check would forward it), but ~600_000 UTF-8
    // bytes (over the limit).
    const cjk = "好".repeat(200_000);
    assert.ok(cjk.length < _internal.DEFAULT_MAX_EVENT_BYTES, "precondition: string length is under the limit");
    assert.ok(
      new TextEncoder().encode(cjk).byteLength > _internal.DEFAULT_MAX_EVENT_BYTES,
      "precondition: UTF-8 byte count is over the limit",
    );

    const res = await doFetch(chatBody({ messages: [{ role: "user", content: cjk }] }));
    assert.equal(res.status, 413);
    const payload = await res.json();
    assert.equal(payload.error.code, "PAYLOAD_TOO_LARGE");
    const match = payload.error.message.match(/too large \((\d+) bytes; limit (\d+) bytes\)/);
    assert.ok(match, `error message must report byte counts with byte units: ${payload.error.message}`);
    assert.ok(Number(match[1]) > Number(match[2]), "reported size must exceed the limit");
    assert.ok(Number(match[1]) > 600_000, "reported size must be the UTF-8 byte count, not the char count");
  } finally {
    gw.restore();
  }
});

test("client-side timeout maps to 504 and network errors to 502", async () => {
  const { hooks } = await makePlugin();

  // Timeout via options.timeoutMs override on a slow gateway. The mock
  // honors the AbortSignal like native fetch does (rejects when it fires).
  const plugin = await CloudbaseBridge({}, { timeoutMs: 300, envId: "env-test-1", functionName: "aiProxy" });
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 30_000);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(init.signal.reason ?? new DOMException("aborted", "TimeoutError"));
        },
        { once: true },
      );
    });
  try {
    const loader = await plugin.auth.loader(async () => fakeAuth());
    const res = await loader.fetch("https://placeholder/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
    });
    assert.equal(res.status, 504);
    const payload = await res.json();
    assert.equal(payload.error.code, "INVOKE_TIMEOUT");
  } finally {
    globalThis.fetch = original;
  }

  // Network failure.
  const plugin2 = await CloudbaseBridge({}, {});
  const gw2 = mockGateway(async () => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const loader = await plugin2.auth.loader(async () => fakeAuth());
    const res = await loader.fetch("https://placeholder/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
    });
    assert.equal(res.status, 502);
    const payload = await res.json();
    assert.equal(payload.error.code, "NETWORK_ERROR");
    assert.ok(!JSON.stringify(payload).includes(TEST_KEY));
  } finally {
    gw2.restore();
  }
});

/* ---------------- provider.models ---------------- */

test("provider.models refines the list from aiProxy ping; failures keep the static list", async () => {
  const { hooks } = await makePlugin();
  const base = {
    hy3: { name: "Hunyuan 3", limit: { context: 262_144, output: 16_384 }, tool_call: false },
    "hy4-preview": { name: "Hunyuan 4 Preview", limit: { context: 1_000_000, output: 16_384 }, tool_call: false },
    // Simulate stale config-hook entries carrying `disabled: true`.
    hy4: { name: "Hunyuan 4 (unverified)", limit: { context: 131_072, output: 16_384 }, tool_call: false, disabled: true },
    "deepseek-v4.1-flash-1017": { name: "DeepSeek V4.1 Flash 1017", limit: { context: 131_072, output: 16_384 }, tool_call: false, disabled: true },
  };

  const gw = mockGateway(async () =>
    new Response(
      JSON.stringify({
        ok: true,
        service: "aiProxy",
        version: "1.0.0",
        env: "env-test-1",
        models: ["hy3", "deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", "hy4"],
      }),
      { status: 200 },
    ),
  );
  try {
    const refined = await hooks.provider.models({ models: base }, { auth: fakeAuth() });
    assert.deepEqual(
      Object.keys(refined).sort(),
      ["deepseek-v4.1-flash", "deepseek-v4.1-flash-1017", "hy3", "hy4"],
    );
    assert.equal(refined.hy3.name, "Hunyuan 3");
    assert.equal(refined["deepseek-v4.1-flash"].limit.context, 1_000_000);
    // A model the deployed function's allowlist explicitly returns must not
    // keep a stale `disabled: true` from the static catalog.
    assert.equal(refined["deepseek-v4.1-flash-1017"].disabled, undefined, "1017 must lose its disabled flag");
    assert.equal(refined.hy4.disabled, undefined, "ping-allowed hy4 must lose its disabled flag too");
    // Models absent from the ping reply are dropped (hy4-preview not pinged).
    assert.equal(refined["hy4-preview"], undefined);

    const pingBody = JSON.parse(gw.calls[0].init.body);
    assert.deepEqual(pingBody, { action: "ping" });
    assert.equal(gw.calls[0].url, "https://env-test-1.api.tcloudbasegateway.com/v1/functions/aiProxy");
  } finally {
    gw.restore();
  }

  const gwFail = mockGateway(async () => new Response(JSON.stringify({ code: "FUNCTIONS_NOT_FOUND", message: "x" }), { status: 404 }));
  try {
    const kept = await hooks.provider.models({ models: base }, { auth: fakeAuth() });
    assert.deepEqual(kept, base);
  } finally {
    gwFail.restore();
  }

  const noAuth = await hooks.provider.models({ models: base }, {});
  assert.deepEqual(noAuth, base);
});

/* ---------------- privacy ---------------- */

test("nothing in logs or error payloads contains the API key or message content", async () => {
  const { hooks, logs } = await makePlugin();
  const gw = mockGateway(async () =>
    new Response(JSON.stringify({ code: "PERMISSION_DENIED", message: "bad key" }), { status: 401 }),
  );
  try {
    const doFetch = await loaderFetch(hooks, fakeAuth({}));
    await doFetch(chatBody({ messages: [{ role: "user", content: "SECRET-CONVERSATION-CONTENT" }] }));
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes(TEST_KEY), "logs must not contain the API key");
    assert.ok(!logged.includes("SECRET-CONVERSATION-CONTENT"), "logs must not contain conversation content");
  } finally {
    gw.restore();
  }
});
