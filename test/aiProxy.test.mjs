/**
 * Unit tests for the aiProxy cloud function.
 *
 * `@cloudbase/node-sdk` is replaced with an in-process stub (see the
 * Module._load hook below) so the suite runs without the real SDK and
 * without network access: the function calls `getApp().ai().createModel()`
 * exactly as it would in CloudBase, but the stub records the arguments and
 * returns a canned generateText result.
 *
 * Run: npm test  (node --test)
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ---------------- @cloudbase/node-sdk stub ---------------- */

const sdk = {
  /** generateText result (or `error` when set). */
  result: {
    text: "hello world",
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    messages: [],
    rawResponses: [],
  },
  resultError: null,
  throwError: null,
  initOptions: null,
  group: null,
  lastParams: null,
};

const originalLoad = Module._load;
Module._load = function loadWithSdkStub(request, ...rest) {
  if (request === "@cloudbase/node-sdk") {
    return {
      init(options) {
        sdk.initOptions = options;
        return {
          ai() {
            return {
              createModel(group) {
                sdk.group = group;
                return {
                  async generateText(params) {
                    sdk.lastParams = params;
                    if (sdk.throwError) throw sdk.throwError;
                    if (sdk.resultError) return { error: sdk.resultError };
                    return sdk.result;
                  },
                };
              },
            };
          },
        };
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

function resetSdk() {
  sdk.result = {
    text: "hello world",
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    messages: [],
    rawResponses: [],
  };
  sdk.resultError = null;
  sdk.throwError = null;
  sdk.initOptions = null;
  sdk.group = null;
  sdk.lastParams = null;
}

/** Load a fresh module instance so the cached CloudBase app and env reads
 * start clean. */
function loadFresh(tcbEnv) {
  if (tcbEnv === undefined) delete process.env.TCB_ENV;
  else process.env.TCB_ENV = tcbEnv;
  const path = require.resolve("../cloudfunctions/aiProxy/index.js");
  delete require.cache[path];
  resetSdk();
  return require(path);
}

const aiProxy = loadFresh("env-test-1");
const { _internal } = aiProxy;

// Every test starts from a clean stub so failures can't leak into the next one.
beforeEach(() => {
  resetSdk();
});

const chatEvent = (overrides = {}) => ({
  model: "hy3",
  messages: [{ role: "user", content: "hi" }],
  ...overrides,
});

/* ---------------- ping ---------------- */

test("main ping returns ok + models + version and leaks nothing sensitive", async () => {
  const reply = await aiProxy.main({ action: "ping" });
  assert.equal(reply.ok, true);
  assert.equal(reply.service, "aiProxy");
  assert.equal(reply.version, _internal.VERSION);
  assert.equal(reply.version, "1.2.2");
  assert.deepEqual(reply.models, _internal.DEFAULT_ALLOWED_MODELS);
  assert.deepEqual(reply.models, [
    "hy4-flash",
    "hy4",
    "hy4-preview",
    "hy3",
    "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-1017",
  ]);
  assert.ok(!JSON.stringify(reply).includes("apikey"));
});

test("getAllowedModels honours AI_PROXY_ALLOWED_MODELS and falls back when empty", () => {
  const previous = process.env.AI_PROXY_ALLOWED_MODELS;
  try {
    process.env.AI_PROXY_ALLOWED_MODELS = " hy3 , hy4 ,, hy3 ";
    assert.deepEqual(_internal.getAllowedModels(), ["hy3", "hy4"]);

    process.env.AI_PROXY_ALLOWED_MODELS = "  ,  ";
    assert.deepEqual(_internal.getAllowedModels(), _internal.DEFAULT_ALLOWED_MODELS);
  } finally {
    if (previous === undefined) delete process.env.AI_PROXY_ALLOWED_MODELS;
    else process.env.AI_PROXY_ALLOWED_MODELS = previous;
  }
});

/* ---------------- chat happy path ---------------- */

test("main chat forwards model, messages and sampling params to generateText", async () => {
  const reply = await aiProxy.main(chatEvent({ temperature: 0.5, topP: 0.9 }));

  assert.equal(reply.object, "chat.completion");
  assert.equal(reply.model, "hy3");
  assert.match(reply.id, /^chatcmpl-\d+$/);
  assert.deepEqual(reply.choices[0].message, { role: "assistant", content: "hello world" });
  assert.equal(reply.choices[0].finish_reason, "stop");
  assert.deepEqual(reply.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });

  assert.deepEqual(sdk.lastParams, {
    model: "hy3",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.5,
    topP: 0.9,
  });
  assert.equal(sdk.group, "cloudbase");
  assert.deepEqual(sdk.initOptions, { env: "env-test-1", timeout: 120000 });
});

test("main chat omits sampling params that were not provided", async () => {
  await aiProxy.main(chatEvent());
  assert.deepEqual(Object.keys(sdk.lastParams).sort(), ["messages", "model"]);
});

test("main chat defaults to deepseek-v4.1-flash when model is omitted or blank", async () => {
  for (const model of [undefined, "", "   "]) {
    await aiProxy.main(chatEvent({ model }));
    assert.equal(sdk.lastParams.model, "deepseek-v4.1-flash");
  }
});

test("main chat strips the cloudbase/cloudbase-plugin provider prefix", async () => {
  for (const model of ["cloudbase/hy3", "cloudbase-plugin/hy4"]) {
    const reply = await aiProxy.main(chatEvent({ model }));
    assert.ok(!reply.error, JSON.stringify(reply));
    assert.equal(sdk.lastParams.model, reply.model);
  }
  assert.equal(sdk.lastParams.model, "hy4");
});

test("main chat normalises missing/odd usage to zeroes", async () => {
  sdk.result = { text: undefined, usage: undefined };
  const reply = await aiProxy.main(chatEvent());
  assert.deepEqual(reply.choices[0].message.content, "");
  assert.deepEqual(reply.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

/* ---------------- request validation ---------------- */

test("main rejects non-object events and empty/malformed messages", async () => {
  for (const event of [null, [], "x", 42]) {
    const reply = await aiProxy.main(event);
    assert.equal(reply.error.code, "INVALID_REQUEST");
    assert.equal(reply.error.message, "请求参数必须是对象");
  }

  const cases = [
    { model: "hy3" },
    { model: "hy3", messages: [] },
    { model: "hy3", messages: [{ content: "no role" }] },
    { model: "hy3", messages: [{ role: "user" }] },
    { model: "hy3", messages: [{ role: "user", content: 1 }] },
    { model: "hy3", messages: [null] },
  ];
  for (const event of cases) {
    const reply = await aiProxy.main(event);
    assert.equal(reply.error.code, "INVALID_REQUEST", JSON.stringify(event));
    assert.equal(reply.error.type, "cloudbase_function_error");
  }
});

test("main rejects out-of-range and non-numeric sampling params", async () => {
  for (const event of [
    chatEvent({ temperature: 3 }),
    chatEvent({ temperature: -1 }),
    chatEvent({ temperature: "0.5" }),
    chatEvent({ topP: 1.5 }),
    chatEvent({ topP: -0.1 }),
  ]) {
    const reply = await aiProxy.main(event);
    assert.equal(reply.error.code, "INVALID_REQUEST", JSON.stringify(event));
  }
  // Boundaries stay valid, including topP = 0 (greedy decoding).
  for (const event of [chatEvent({ temperature: 0 }), chatEvent({ temperature: 2 }), chatEvent({ topP: 0 })]) {
    const reply = await aiProxy.main(event);
    assert.ok(!reply.error, JSON.stringify(reply));
  }
});

test("main rejects non-string model values", async () => {
  const reply = await aiProxy.main(chatEvent({ model: 42 }));
  assert.equal(reply.error.code, "INVALID_REQUEST");
  assert.equal(reply.error.message, "model 必须是字符串");
});

test("main enforces the model allowlist", async () => {
  const reply = await aiProxy.main(chatEvent({ model: "gpt-4" }));
  assert.equal(reply.error.code, "MODEL_NOT_ALLOWED");
  assert.match(reply.error.message, /不支持的模型：gpt-4/);
  assert.match(reply.error.message, /deepseek-v4\.1-flash/);
});

test("main does not cap message count or size (documented behaviour)", async () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({ role: "user", content: "x".repeat(5_000) }));
  const reply = await aiProxy.main({ model: "hy3", messages });
  assert.ok(!reply.error, JSON.stringify(reply).slice(0, 200));
  assert.equal(sdk.lastParams.messages.length, 200);
});

/* ---------------- CloudBase configuration ---------------- */

test("main returns CONFIG_ERROR when TCB_ENV is missing", async () => {
  const fresh = loadFresh(undefined);
  const reply = await fresh.main(chatEvent());
  assert.equal(reply.error.code, "CONFIG_ERROR");
  assert.equal(reply.error.message, "请先在云函数环境变量中设置 TCB_ENV");
  assert.equal(reply.error.type, "cloudbase_function_error");
});

test("CONFIG_ERROR is treated as a client error (message kept)", () => {
  const reply = _internal.errorResponse(_internal.createError("CONFIG_ERROR", "请设置 TCB_ENV"));
  assert.equal(reply.error.code, "CONFIG_ERROR");
  assert.equal(reply.error.message, "请设置 TCB_ENV");
});

/* ---------------- upstream failures ---------------- */

test("main keeps known upstream error codes but masks the upstream message", async () => {
  sdk.throwError = Object.assign(new Error("channel refused: internal detail"), {
    code: "AI_CHANNEL_NOT_ALLOWED",
  });
  const reply = await aiProxy.main(chatEvent());
  assert.equal(reply.error.code, "AI_CHANNEL_NOT_ALLOWED");
  assert.equal(reply.error.message, "AI 模型调用失败，请稍后重试");
  assert.equal(reply.error.type, "cloudbase_function_error");
});

test("main tolerates a generateText reply that carries no text (v1.2.2 contract)", async () => {
  // In v1.2.2 the function does not inspect a `result.error` channel: whatever
  // generateText resolves to is formatted into a chat.completion, so a missing
  // `text` degrades to an empty assistant message instead of throwing.
  sdk.result = { messages: [], rawResponses: [] };
  const reply = await aiProxy.main(chatEvent());
  assert.equal(reply.object, "chat.completion");
  assert.equal(reply.choices[0].message.content, "");
  assert.deepEqual(reply.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("main falls back to UPSTREAM_ERROR when the thrown error has no code", async () => {
  sdk.throwError = new Error("socket hang up");
  const reply = await aiProxy.main(chatEvent());
  assert.equal(reply.error.code, "UPSTREAM_ERROR");
  assert.equal(reply.error.message, "AI 模型调用失败，请稍后重试");
});

test("errorResponse never leaks upstream text for non-client codes", () => {
  for (const code of ["AI_MODEL_NOT_SUPPORTED", "UPSTREAM_ERROR", "SOMETHING_NEW"]) {
    const reply = _internal.errorResponse(Object.assign(new Error("secret upstream payload"), { code }));
    assert.equal(reply.error.code, code);
    assert.equal(reply.error.message, "AI 模型调用失败，请稍后重试");
    assert.doesNotMatch(JSON.stringify(reply), /secret upstream payload/);
  }
});

/* ---------------- pure helpers ---------------- */

test("createCompletionResponse builds an OpenAI chat.completion object", () => {
  const reply = _internal.createCompletionResponse("hy3", {
    text: "ok",
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
  assert.equal(reply.object, "chat.completion");
  assert.equal(reply.model, "hy3");
  assert.equal(reply.choices[0].message.role, "assistant");
  assert.equal(reply.choices[0].message.content, "ok");
  assert.equal(reply.choices[0].index, 0);
  assert.deepEqual(reply.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
});

test("createCompletionResponse derives total_tokens when upstream omits it", () => {
  const reply = _internal.createCompletionResponse("hy3", {
    text: "",
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  });
  assert.equal(reply.usage.total_tokens, 10);
  assert.equal(Math.floor(Date.now() / 1000) - reply.created <= 2, true);
});

test("validateNumber accepts undefined and boundaries only", () => {
  assert.doesNotThrow(() => _internal.validateNumber(undefined, "temperature", 0, 2));
  assert.doesNotThrow(() => _internal.validateNumber(0, "temperature", 0, 2));
  assert.doesNotThrow(() => _internal.validateNumber(2, "temperature", 0, 2));
  for (const value of [2.1, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) {
    assert.throws(() => _internal.validateNumber(value, "temperature", 0, 2), {
      code: "INVALID_REQUEST",
    });
  }
});
