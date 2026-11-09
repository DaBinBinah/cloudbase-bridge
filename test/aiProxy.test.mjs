/**
 * Unit tests for the aiProxy cloud function (pure logic only — the
 * @cloudbase/node-sdk dependency is never loaded here; callModel is
 * injected).
 *
 * Run: npm test  (node --test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const aiProxy = require("../cloudfunctions/aiProxy/index.js");
const { _internal } = aiProxy;

/* ---------------- validateChatEvent ---------------- */

test("validateChatEvent accepts a valid chat event", () => {
  const result = _internal.validateChatEvent({
    model: "hy3",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    temperature: 0.5,
    topP: 0.9,
  });
  assert(!result.error);
  assert.deepEqual(result.params.model, "hy3");
  assert.deepEqual(result.params.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(result.params.temperature, 0.5);
  assert.deepEqual(result.params.topP, 0.9);
});

test("validateChatEvent rejects missing/invalid model", () => {
  for (const model of [undefined, "", "has space", "a".repeat(80), { x: 1 }]) {
    const result = _internal.validateChatEvent({ model, messages: [{ role: "user", content: "hi" }] });
    assert(result.error, `expected rejection for ${JSON.stringify(model)}`);
    assert.deepEqual(result.error.code, "INVALID_REQUEST");
  }
});

test("validateChatEvent rejects unknown roles and tool shapes", () => {
  const result = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "tool", content: "{}" }],
  });
  assert.deepEqual(result.error.code, "INVALID_REQUEST");
  assert.match(result.error.message, /tool calls are not supported/);
});

test("validateChatEvent rejects image parts with IMAGE_INPUT_NOT_SUPPORTED", () => {
  const result = _internal.validateChatEvent({
    model: "deepseek-v4.1-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
    ],
  });
  assert.deepEqual(result.error.code, "IMAGE_INPUT_NOT_SUPPORTED");
});

test("validateChatEvent flattens text array parts", () => {
  const result = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
  });
  assert(!result.error);
  assert.deepEqual(result.params.messages, [{ role: "user", content: "a\nb" }]);
});

test("validateChatEvent enforces model allowlist", () => {
  const result = _internal.validateChatEvent({
    model: "not-a-model",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.error.code, "MODEL_NOT_ALLOWED");
  assert.match(result.error.message, /AI_PROXY_ALLOWED_MODELS/);
});

test("validateChatEvent rejects out-of-range sampling params and oversized input", () => {
  const badTemp = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: "hi" }],
    temperature: 5,
  });
  assert.deepEqual(badTemp.error.code, "INVALID_REQUEST");

  const tooBig = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: "x".repeat(_internal.MAX_SINGLE_MESSAGE_CHARS + 1) }],
  });
  assert.deepEqual(tooBig.error.code, "INVALID_REQUEST");
  assert.match(tooBig.error.message, /too large/);
});

/* ---------------- buildChatCompletion / usage ---------------- */

test("buildChatCompletion maps generateText result to chat.completion", () => {
  const completion = _internal.buildChatCompletion(
    {
      text: "hello world",
      messages: [],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      rawResponses: [],
    },
    "hy3",
    "req-1",
  );
  assert.deepEqual(completion.object, "chat.completion");
  assert.match(completion.id, /^chatcmpl-/);
  assert.deepEqual(completion.model, "hy3");
  assert.deepEqual(completion.choices.length, 1);
  assert.deepEqual(completion.choices[0].message, { role: "assistant", content: "hello world" });
  assert.deepEqual(completion.choices[0].finish_reason, "stop");
  assert.deepEqual(completion.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.deepEqual(completion.request_id, "req-1");
});

test("buildChatCompletion tolerates missing usage and text", () => {
  const completion = _internal.buildChatCompletion({}, "hy3");
  assert.deepEqual(completion.choices[0].message.content, "");
  assert.deepEqual(completion.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

/* ---------------- main entry with injected callModel ---------------- */

function withInjectedCallModel(fake) {
  const original = aiProxy._callModelOverride;
  aiProxy._callModelOverride = fake;
  return () => {
    aiProxy._callModelOverride = original;
  };
}

test("exports.main ping returns ok + models and leaks nothing sensitive", async () => {
  const reply = await aiProxy.main({ action: "ping" }, { request_id: "rid" });
  assert.deepEqual(reply.ok, true);
  assert.deepEqual(reply.service, "aiProxy");
  assert(Array.isArray(reply.models));
  assert(reply.models.includes("hy3"));
  assert(!JSON.stringify(reply).includes("apikey"));
});

test("exports.main chat forwards to callModel and returns completion", async () => {
  const seen = [];
  const restore = withInjectedCallModel(async (params, requestId) => {
    seen.push({ params, requestId });
    return {
      completion: _internal.buildChatCompletion(
        { text: "ok", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
        params.model,
      ),
    };
  });
  try {
    const reply = await aiProxy.main(
      { model: "hy3", messages: [{ role: "user", content: "hi" }] },
      { request_id: "rid-2" },
    );
    assert.deepEqual(reply.choices[0].message.content, "ok");
    assert.deepEqual(seen.length, 1);
    assert.deepEqual(seen[0].params.model, "hy3");
    assert.deepEqual(seen[0].requestId, "rid-2");
  } finally {
    restore();
  }
});

test("exports.main surfaces upstream error codes from callModel", async () => {
  const restore = withInjectedCallModel(async () => ({
    error: { code: "AI_MODEL_NOT_SUPPORTED", message: "model not enabled" },
  }));
  try {
    const reply = await aiProxy.main({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(reply.error.code, "AI_MODEL_NOT_SUPPORTED");
    assert.match(reply.error.message, /model not enabled/);
  } finally {
    restore();
  }
});

test("exports.main returns error envelope for invalid events", async () => {
  const reply = await aiProxy.main({ model: "hy3" }, {});
  assert(reply.error);
  assert.deepEqual(reply.error.code, "INVALID_REQUEST");
});

test("exports.main catches thrown SDK errors as UPSTREAM_ERROR with upstream code kept", async () => {
  const restore = withInjectedCallModel(async () => {
    const err = new Error("channel refused");
    err.code = "AI_CHANNEL_NOT_ALLOWED";
    throw err;
  });
  try {
    const reply = await aiProxy.main({ model: "hy3", messages: [{ role: "user", content: "hi" }] });
    assert.deepEqual(reply.error.code, "AI_CHANNEL_NOT_ALLOWED");
  } finally {
    restore();
  }
});

/* ---------------- safeErrorMessage ---------------- */

test("safeErrorMessage bounds length and handles primitives", () => {
  assert.deepEqual(_internal.safeErrorMessage(new Error("boom")), "boom");
  assert.deepEqual(_internal.safeErrorMessage("plain"), "plain");
  assert.deepEqual(_internal.safeErrorMessage(undefined), "(no message)");
  assert.ok(_internal.safeErrorMessage("x".repeat(500)).length <= 301);
});
