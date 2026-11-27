import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { main } = require("../cloudfunctions/unified-entry.cjs");
const image = require("../cloudfunctions/generateImage/index.js");
const chat = require("../cloudfunctions/aiProxy/index.js");

test("unified ping only adds the capability; legacy chat events still reach chat", async t => {
  const ping = await main({ action: "ping" });
  assert.equal(ping.service, "aiProxy");
  assert.ok(ping.models.includes("hy4"));
  assert.equal(ping.capabilities.generateImage, true);
  const answer = { completion: { choices: [{ message: { content: "OK" } }] } };
  const send = t.mock.method(chat, "main", async () => answer);
  for (const event of [{ messages: [] }, { action: "chat", prompt: "not an image", messages: [] }]) {
    const ctx = { requestId: "test" };
    assert.equal(await main(event, ctx), answer);
    assert.deepEqual(send.mock.calls.at(-1).arguments, [event, ctx]);
  }
});

test("unified checkImage and generateImage forward exactly one image event", async t => {
  const result = { ok: false, code: "TEST" };
  const send = t.mock.method(image, "main", async () => result);
  const prompt = "A banner, aspect ratio 5:2";
  for (const action of ["checkImage", "generateImage"]) {
    assert.equal(await main({ action, prompt, messages: [], tools: [] }), result);
  }
  assert.deepEqual(send.mock.calls.map(c => c.arguments), [[{ action: "check", prompt }], [{ prompt }]]);
  assert.ok((await main({ prompt })).error);
  assert.equal(send.mock.callCount(), 2);
});
