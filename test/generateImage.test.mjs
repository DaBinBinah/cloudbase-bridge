import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../cloudfunctions/generateImage/index.js", import.meta.url), "utf8");

function fixture(mode) {
  const calls = [];
  const model = { generateImage: async request => {
    calls.push(request);
    return { choices: [{ delta: { image: { url: "https://example.org/result" } } }] };
  } };
  const sdk = {
    getCloudbaseContext: () => ({ TCB_ENV: "test" }),
    init: () => ({ ai: () => ({ createImageModel: () => model }) }),
  };
  const exports = {};
  runInNewContext(source, {
    exports, process: { env: { IMAGE_FOOTNOTE_MODE: mode } },
    require: id => {
      if (id === "@cloudbase/node-sdk") return sdk;
      assert.ok(["@cloudbase/ai/package.json", "@cloudbase/node-sdk/package.json"].includes(id));
      return { version: "test" };
    },
  });
  return { main: exports.main, calls };
}

for (const [mode, expected] of [[undefined, ""], ["empty", ""], ["space", " "], ["omit", undefined]]) {
  test(`generateImage ${mode ?? "default"}: check is free; send the configured footnote and user prompt`, async () => {
    const { main, calls } = fixture(mode);
    const status = await main({ action: "check" });
    assert.equal(status.stage, "ready");
    assert.equal(status.footnoteMode, mode ?? "empty");
    assert.equal(status.modelCalled, false);
    assert.equal((await main({ prompt: " " })).code, "EMPTY_PROMPT");
    assert.equal(calls.length, 0);
    assert.equal((await main({ prompt: "A ceramic vase" })).url, "https://example.org/result");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages[0].content[0].text, "A ceramic vase");
    assert.equal(Object.hasOwn(calls[0], "footnote"), expected !== undefined);
    assert.equal(calls[0].footnote, expected);
  });
}

test("generateImage rejects an invalid footnote mode before calling the model", async () => {
  const { main, calls } = fixture("invalid");
  assert.equal((await main({ prompt: "A ceramic vase" })).code, "INVALID_FOOTNOTE_MODE");
  assert.equal(calls.length, 0);
});
