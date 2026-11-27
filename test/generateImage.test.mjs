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
    assert.equal(status.requestedSize, "1024x1024");
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

for (const [prompt, size] of [
  ["内容是：黑五 Google AI 订阅避坑指南\n生成一张宽高比为 5:2 的图片", "1600x640"],
  ["生成一张宽高比为２：５的图片", "640x1600"],
  ["设计一张 10:4 的横幅", "1600x640"],
  ["设计一张 16:9 的横版海报，展示模型比例 1:50 的火车", "1408x792"],
  ["展示模型比例 1:50 的火车", "1024x1024"],
  ["生成一张橘猫的图片，比例 5:2", "1600x640"],
  ["16:9", "1408x792"],
  ["Create a banner, aspect ratio 5:2.", "1600x640"],
  ["Create a 16:9 banner", "1408x792"],
  ["画一个正方形图标 --ar 1:1", "1024x1024"],
  ["一只猫坐在窗台上", "1024x1024"],
  ["显示 12:30 的时钟和比分 5:2", "1024x1024"],
  ["画一个时钟，12:00", "1024x1024"],
  ["画一个记分牌，5:2", "1024x1024"],
]) {
  test(`generateImage canvas: ${prompt}`, async () => {
    const { main, calls } = fixture("space");
    const status = await main({ action: "check", prompt });
    assert.equal(status.requestedSize, size);
    assert.equal(status.modelCalled, false);
    assert.equal(calls.length, 0);
    assert.equal((await main({ prompt })).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].size, size);
    assert.equal(Object.hasOwn(calls[0], "generate_max_pixels"), false);
    assert.equal(calls[0].messages[0].content[0].text, prompt);
    assert.equal(calls[0].footnote, " ");
  });
}

test("generateImage rejects unrepresentable ratios without calling the model", async () => {
  const { main, calls } = fixture();
  for (const prompt of ["宽高比 0:2", "aspect ratio 1:50"]) {
    assert.equal((await main({ prompt })).code, "INVALID_ASPECT_RATIO");
  }
  assert.equal(calls.length, 0);
});
