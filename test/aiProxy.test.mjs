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

test("each advertised effort reaches generateText; omitted controls leave the SDK defaults intact", () => {
  const { reasoningLevels } = _internal.pingResult();
  function sdkInput(model, options) {
    const result = _internal.validateChatEvent({ model, messages: [{ role: "user", content: "hi" }], ...options });
    assert.ifError(result.error);
    return _internal.buildGenerateInput(result.params);
  }
  for (const [model, levels] of Object.entries(reasoningLevels)) {
    const plain = sdkInput(model, {});
    assert.ok(!("thinking" in plain) && !("reasoning_effort" in plain));
    for (const effort of levels) {
      const data = sdkInput(model, { reasoning_effort: effort });
      assert.deepEqual(data.thinking, { type: effort === "none" ? "disabled" : "enabled" });
      assert.equal(data.reasoning_effort, effort === "none" ? undefined : effort);
    }
    assert.deepEqual(sdkInput(model, { thinking: { type: "enabled" } }), { ...plain, thinking: { type: "enabled" } });
  }
  assert.deepEqual(reasoningLevels["hy4-flash"], ["none", "high"]);
  assert.deepEqual(reasoningLevels.hy3, ["none", "low", "high"]);
  assert.deepEqual(reasoningLevels["deepseek-v4.1-flash-1017"], ["none", "low", "high", "max"]);
  assert.equal(reasoningLevels["hy-image-v3.5-preview"], undefined);
  for (const [alias, canonical] of [["minimal", "low"], ["medium", "high"], ["xhigh", "high"], ["ultra", "max"]]) {
    assert.equal(sdkInput("deepseek-v4.1-flash", { reasoning_effort: alias }).reasoning_effort, canonical);
  }
  assert.deepEqual(sdkInput("hy4", { reasoning_effort: "no_think" }).thinking, { type: "disabled" });
});

test("reject unsupported or contradictory settings before calling the model", async t => {
  const send = t.mock.fn();
  aiProxy._callModelOverride = send;
  try {
    for (const options of [{ reasoning_effort: "low" }, { reasoning_effort: {} }, { reasoning_effort: 1 },
      { thinking: { type: "adaptive" } }, { thinking: "false" },
      { thinking: { type: "disabled" }, reasoning_effort: "high" },
      { thinking: { type: "enabled" }, reasoning_effort: "none" }]) {
      const r = await aiProxy.main({ model: "hy4", messages: [{ role: "user", content: "hi" }], ...options });
      assert.equal(r.error.code, "INVALID_REQUEST");
    }
    assert.equal(send.mock.callCount(), 0);
  } finally { delete aiProxy._callModelOverride; }
});

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

test("validateChatEvent rejects unknown roles and malformed tool messages", () => {
  const unknownRole = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "function", content: "{}" }],
  });
  assert.deepEqual(unknownRole.error.code, "INVALID_REQUEST");
  assert.match(unknownRole.error.message, /is not supported/);

  const noCallId = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "tool", content: "{}" }],
  });
  assert.deepEqual(noCallId.error.code, "INVALID_REQUEST");
  assert.match(noCallId.error.message, /tool_call_id/);

  const badCall = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call_1", function: {} }] }],
  });
  assert.deepEqual(badCall.error.code, "INVALID_REQUEST");
});

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

test("validateChatEvent keeps tools, toolChoice, maxTokens and a tool-call round trip", () => {
  const result = _internal.validateChatEvent({
    model: "hy4",
    messages: [
      { role: "user", content: "read note.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' }, extra: 1 }],
      },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "hello" }] },
    ],
    tools: [READ_FILE_TOOL],
    toolChoice: "required",
    maxTokens: 64,
  });
  assert(!result.error, JSON.stringify(result.error));
  assert.deepEqual(result.params.messages, [
    { role: "user", content: "read note.txt" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' } }],
    },
    { role: "tool", content: "hello", tool_call_id: "call_1" },
  ]);
  assert.deepEqual(result.params.tools, [READ_FILE_TOOL]);
  assert.deepEqual(result.params.toolChoice, "required");
  assert.deepEqual(result.params.maxTokens, 64);
});

test("validateChatEvent rejects malformed tools, toolChoice and maxTokens", () => {
  const base = { model: "hy3", messages: [{ role: "user", content: "hi" }] };
  for (const extra of [
    { tools: [{ type: "function" }] },
    { tools: [{ type: "web_search", function: { name: "x" } }] },
    { tools: [READ_FILE_TOOL], toolChoice: "sometimes" },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { maxTokens: "64" },
  ]) {
    const result = _internal.validateChatEvent({ ...base, ...extra });
    assert(result.error, `expected rejection for ${JSON.stringify(extra)}`);
    assert.deepEqual(result.error.code, "INVALID_REQUEST");
  }
  // toolChoice without tools is dropped rather than sent upstream.
  const noTools = _internal.validateChatEvent({ ...base, toolChoice: "auto" });
  assert(!noTools.error);
  assert.equal("toolChoice" in noTools.params, false);
});

test("buildGenerateInput forwards max_tokens and tools in a single model step", () => {
  const plain = _internal.buildGenerateInput({ model: "hy3", messages: [{ role: "user", content: "hi" }], topP: 0.9 });
  assert.deepEqual(plain, { model: "hy3", messages: [{ role: "user", content: "hi" }], topP: 0.9 });

  const withTools = _internal.buildGenerateInput({
    model: "hy4",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 64,
    tools: [READ_FILE_TOOL],
    toolChoice: "auto",
  });
  assert.deepEqual(withTools.max_tokens, 64);
  assert.deepEqual(withTools.tools, [READ_FILE_TOOL]);
  assert.deepEqual(withTools.toolChoice, "auto");
  assert.deepEqual(withTools.maxSteps, 1, "the SDK must not execute the agent's tools itself");
});

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("validateChatEvent keeps image_url parts on user messages for image-capable models", () => {
  const result = _internal.validateChatEvent({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "low", extra: "dropped" } },
          { type: "image_url", image_url: { url: PNG_DATA_URL } },
        ],
      },
      { role: "assistant", content: "a cat" },
      { role: "user", content: "and its colour?" },
    ],
  });
  assert(!result.error);
  assert.deepEqual(result.params.messages, [
    { role: "system", content: "sys" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "low" } },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
      ],
    },
    { role: "assistant", content: "a cat" },
    { role: "user", content: "and its colour?" },
  ]);
  assert.deepEqual(_internal.buildGenerateInput(result.params).messages, result.params.messages);
});

test("validateChatEvent answers IMAGE_INPUT_NOT_SUPPORTED for an image sent to a text-only model", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: PNG_DATA_URL } }] },
  ];
  const result = _internal.validateChatEvent({ model: "hy3", messages });
  assert.deepEqual(result.error.code, "IMAGE_INPUT_NOT_SUPPORTED");
  assert.match(result.error.message, /messages\[1\]\.content\[1\].*"hy3" takes text only.*hy4/);
  assert.equal(result.error.message.includes("base64"), false, "the image itself must not be echoed");
});

test("validateChatEvent rejects images outside user messages, bad image urls and other part types", () => {
  const image = { type: "image_url", image_url: { url: PNG_DATA_URL } };
  const onTool = _internal.validateChatEvent({
    model: "hy4",
    messages: [{ role: "tool", tool_call_id: "c1", content: [image] }],
  });
  assert.deepEqual(onTool.error.code, "IMAGE_INPUT_NOT_SUPPORTED");
  assert.match(onTool.error.message, /user messages only/);

  for (const url of [undefined, "", "file:///etc/passwd", "data:text/html;base64,PGI+", "data:image/png;base64,<svg>", "ftp://example.com/a.png"]) {
    const bad = _internal.validateChatEvent({
      model: "hy4",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    });
    assert.deepEqual(bad.error.code, "INVALID_REQUEST", `url ${url}`);
  }

  for (const part of [{ type: "video_url", video_url: { url: "https://example.com/a.mp4" } }, { type: "file", file: { file_url: "https://example.com/a.pdf" } }, "text"]) {
    const other = _internal.validateChatEvent({ model: "hy4", messages: [{ role: "user", content: [part] }] });
    assert.deepEqual(other.error.code, "INVALID_REQUEST");
  }
});

test("an inline image counts toward the conversation size limit", () => {
  const big = "data:image/png;base64," + "A".repeat(_internal.MAX_TOTAL_MESSAGE_CHARS);
  const result = _internal.validateChatEvent({
    model: "hy4",
    messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: big } }] }],
  });
  assert.deepEqual(result.error.code, "INVALID_REQUEST");
  assert.match(result.error.message, /too large/);
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

  for (const topP of [-0.1, 1.1]) {
    const badTopP = _internal.validateChatEvent({ model: "hy3", messages: [{ role: "user", content: "hi" }], topP });
    assert.deepEqual(badTopP.error.code, "INVALID_REQUEST");
  }
  for (const topP of [0, 1]) {
    const okTopP = _internal.validateChatEvent({ model: "hy3", messages: [{ role: "user", content: "hi" }], topP });
    assert(!okTopP.error, `topP ${topP} is in range`);
    assert.deepEqual(okTopP.params.topP, topP);
    assert.deepEqual(_internal.buildGenerateInput(okTopP.params).topP, topP);
  }

  const tooBig = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: "x".repeat(_internal.MAX_SINGLE_MESSAGE_CHARS + 1) }],
  });
  assert.deepEqual(tooBig.error.code, "INVALID_REQUEST");
  assert.match(tooBig.error.message, /too large/);
});

test("validateChatEvent takes a long agent history and still bounds it", () => {
  const turn = (i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(2_000) });
  const long = _internal.validateChatEvent({ model: "hy3", messages: Array.from({ length: 1_001 }, (_, i) => turn(i)) });
  assert(!long.error, "1001 messages / 2 MB of text is accepted");
  assert.equal(long.params.messages.length, 1_001);

  const tooMany = _internal.validateChatEvent({
    model: "hy3",
    messages: Array.from({ length: _internal.MAX_MESSAGES + 1 }, () => ({ role: "user", content: "x" })),
  });
  assert.equal(tooMany.error.code, "INVALID_REQUEST");
  assert.match(tooMany.error.message, /Too many messages/);

  const half = "x".repeat(_internal.MAX_TOTAL_MESSAGE_CHARS / 2);
  const tooLarge = _internal.validateChatEvent({
    model: "hy3",
    messages: [{ role: "user", content: half }, { role: "assistant", content: half }, { role: "user", content: "x" }],
  });
  assert.equal(tooLarge.error.code, "INVALID_REQUEST");
  assert.match(tooLarge.error.message, /Conversation too large/);
});

test("validateChatEvent keeps reasoning_content on every assistant message that carries it", () => {
  const toolCall = { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } };
  const result = _internal.validateChatEvent({
    model: "hy4",
    messages: [
      { role: "user", content: "read it" },
      { role: "assistant", content: "", reasoning_content: "I should read the file.", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_1", content: "42" },
      { role: "assistant", content: "It says 42.", reasoning_content: "The tool returned 42." },
      { role: "user", content: "thanks", reasoning_content: "not an assistant message" },
      { role: "assistant", content: "Welcome.", reasoning_content: "" },
    ],
  });
  assert(!result.error);
  assert.deepEqual(result.params.messages[1], {
    role: "assistant",
    content: "",
    tool_calls: [toolCall],
    reasoning_content: "I should read the file.",
  });
  assert.deepEqual(result.params.messages[3], { role: "assistant", content: "It says 42.", reasoning_content: "The tool returned 42." });
  assert.deepEqual(result.params.messages[4], { role: "user", content: "thanks" });
  assert.deepEqual(result.params.messages[5], { role: "assistant", content: "Welcome." });

  const tooBig = _internal.validateChatEvent({
    model: "hy4",
    messages: [
      { role: "assistant", content: "", reasoning_content: "x".repeat(_internal.MAX_SINGLE_MESSAGE_CHARS), tool_calls: [toolCall] },
    ],
  });
  assert.match(tooBig.error.message, /too large/);
});

/* ---------------- allowlist ---------------- */

test("default allowlist includes the verified deepseek-v4.1-flash-1017", () => {
  assert.ok(_internal.DEFAULT_ALLOWED_MODELS.includes("deepseek-v4.1-flash-1017"));
  const result = _internal.validateChatEvent({
    model: "deepseek-v4.1-flash-1017",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(!result.error, result.error?.message);
  assert.equal(result.params.model, "deepseek-v4.1-flash-1017");
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

test("buildChatCompletion returns the model's tool calls with finish_reason tool_calls", () => {
  const toolCall = { id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"note.txt"}' } };
  const upstreamMessage = { role: "assistant", content: "", tool_calls: [toolCall] };
  const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };

  const fromRaw = _internal.buildChatCompletion(
    { text: "", messages: [{ role: "user", content: "hi" }, upstreamMessage], usage, rawResponses: [{ choices: [{ message: upstreamMessage, finish_reason: "tool_calls" }] }] },
    "hy4",
    "rid-tc",
    1,
  );
  assert.deepEqual(fromRaw.choices[0].message, { role: "assistant", content: null, tool_calls: [toolCall] });
  assert.deepEqual(fromRaw.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(fromRaw.usage, usage);

  // SDKs without rawResponses: the reply is the message appended to `messages`.
  const fromMessages = _internal.buildChatCompletion(
    { text: "", messages: [{ role: "user", content: "hi" }, upstreamMessage], usage },
    "hy4",
    "rid-tc",
    1,
  );
  assert.deepEqual(fromMessages.choices[0].message.tool_calls, [toolCall]);

  // Tool calls from the conversation history are never echoed as a new reply.
  const history = _internal.buildChatCompletion(
    { text: "done", messages: [{ role: "user", content: "hi" }, upstreamMessage], usage },
    "hy4",
    "rid-tc",
    2,
  );
  assert.deepEqual(history.choices[0].message, { role: "assistant", content: "done" });
  assert.deepEqual(history.choices[0].finish_reason, "stop");

  const truncated = _internal.buildChatCompletion(
    { text: "cut", usage, rawResponses: [{ choices: [{ message: { role: "assistant", content: "cut" }, finish_reason: "length" }] }] },
    "hy4",
  );
  assert.deepEqual(truncated.choices[0].finish_reason, "length");
});

test("buildChatCompletion keeps reasoning_content and reports truncated tool calls as length", () => {
  const toolCall = { id: "call_9", type: "function", function: { name: "read_file", arguments: '{"path":"no' } };
  const usage = { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 };

  const thinking = { role: "assistant", content: "", reasoning_content: "Need the file first.", tool_calls: [{ ...toolCall, function: { name: "read_file", arguments: "{}" } }] };
  const withReasoning = _internal.buildChatCompletion(
    { text: "", usage, rawResponses: [{ choices: [{ message: thinking, finish_reason: "tool_calls" }] }] },
    "hy4",
  );
  assert.deepEqual(withReasoning.choices[0].message.reasoning_content, "Need the file first.");
  assert.deepEqual(withReasoning.choices[0].finish_reason, "tool_calls");

  const textOnly = _internal.buildChatCompletion(
    { text: "hi", usage, rawResponses: [{ choices: [{ message: { role: "assistant", content: "hi", reasoning_content: "Greet." }, finish_reason: "stop" }] }] },
    "hy4",
  );
  assert.deepEqual(textOnly.choices[0].message, { role: "assistant", content: "hi", reasoning_content: "Greet." });

  const noReasoning = _internal.buildChatCompletion(
    { text: "hi", usage, rawResponses: [{ choices: [{ message: { role: "assistant", content: "hi", reasoning_content: "" }, finish_reason: "stop" }] }] },
    "hy4",
  );
  assert.deepEqual(noReasoning.choices[0].message, { role: "assistant", content: "hi" });

  const cutOff = _internal.buildChatCompletion(
    { text: "", usage, rawResponses: [{ choices: [{ message: { role: "assistant", content: "", tool_calls: [toolCall] }, finish_reason: "length" }] }] },
    "hy4",
  );
  assert.deepEqual(cutOff.choices[0].finish_reason, "length");
  assert.deepEqual(cutOff.choices[0].message.tool_calls, [toolCall]);
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

test("exports.main catches thrown SDK errors: upstream code kept, upstream message hidden", async () => {
  const restore = withInjectedCallModel(async () => {
    const err = new Error("channel refused by gateway-7.internal");
    err.code = "AI_CHANNEL_NOT_ALLOWED";
    throw err;
  });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const reply = await aiProxy.main({ model: "hy3", messages: [{ role: "user", content: "hi" }] }, { request_id: "rid-7" });
    assert.deepEqual(reply.error.code, "AI_CHANNEL_NOT_ALLOWED");
    assert.deepEqual(reply.error.requestId, "rid-7");
    assert.doesNotMatch(reply.error.message, /gateway-7/);
    assert.match(logged[0][1].message, /gateway-7/);
  } finally {
    console.error = originalConsoleError;
    restore();
  }
});

test("exports.main still serves the event shape sent by plugin 0.2.4", async () => {
  const seen = [];
  const restore = withInjectedCallModel(async (params) => {
    seen.push(params);
    return { completion: _internal.buildChatCompletion({ text: "pong", usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }, params.model) };
  });
  try {
    // 0.2.4 sends exactly these fields: no tools, toolChoice or maxTokens.
    const reply = await aiProxy.main({
      action: "chat",
      model: "hy4",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "ping" },
      ],
      temperature: 0.7,
      topP: 0.9,
    });
    assert.deepEqual(seen[0], {
      model: "hy4",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "ping" },
      ],
      temperature: 0.7,
      topP: 0.9,
    });
    assert.deepEqual(reply.choices[0].message, { role: "assistant", content: "pong" });
    assert.deepEqual(reply.choices[0].finish_reason, "stop");
    assert.deepEqual(Object.keys(reply).sort(), ["choices", "created", "id", "model", "object", "usage"]);
  } finally {
    restore();
  }
});

/* ---------------- failureEnvelope ---------------- */

function captureConsoleError(run) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    return { value: run(), calls };
  } finally {
    console.error = original;
  }
}

test("failureEnvelope hides upstream messages but keeps the code and logs the original", () => {
  const upstream = Object.assign(new Error("POST https://internal.example/v1 failed for account 100012345: quota 0/1000000"), {
    code: "EXCEED_TOKEN_QUOTA_LIMIT",
  });
  const { value, calls } = captureConsoleError(() => _internal.failureEnvelope(upstream, "rid-9"));
  assert.deepEqual(value.error.code, "EXCEED_TOKEN_QUOTA_LIMIT");
  assert.deepEqual(value.error.requestId, "rid-9");
  assert.doesNotMatch(value.error.message, /internal\.example|100012345|quota 0/);
  assert.match(value.error.message, /EXCEED_TOKEN_QUOTA_LIMIT/);
  assert.deepEqual(calls.length, 1);
  assert.match(calls[0][1].message, /internal\.example/);
  assert.deepEqual(calls[0][1].requestId, "rid-9");

  const uncoded = captureConsoleError(() => _internal.failureEnvelope(new Error("socket hang up 10.0.0.8"))).value;
  assert.deepEqual(uncoded.error.code, "UPSTREAM_ERROR");
  assert.doesNotMatch(uncoded.error.message, /10\.0\.0\.8/);
});

test("failureEnvelope keeps the text of errors raised by aiProxy itself", () => {
  const own = Object.assign(new Error("TCB_ENV is not set."), { code: "TCB_ENV_MISSING", expose: true });
  const { value, calls } = captureConsoleError(() => _internal.failureEnvelope(own, "rid-1"));
  assert.deepEqual(value.error, { code: "TCB_ENV_MISSING", message: "TCB_ENV is not set.", requestId: "rid-1" });
  assert.deepEqual(calls.length, 0);
});

/* ---------------- safeErrorMessage ---------------- */

test("safeErrorMessage bounds length and handles primitives", () => {
  assert.deepEqual(_internal.safeErrorMessage(new Error("boom")), "boom");
  assert.deepEqual(_internal.safeErrorMessage("plain"), "plain");
  assert.deepEqual(_internal.safeErrorMessage(undefined), "(no message)");
  assert.ok(_internal.safeErrorMessage("x".repeat(500)).length <= 301);
});
