"use strict";

function requestedSize(prompt) {
  const text = prompt.normalize("NFKC").trim();
  const ratio = /(?:宽高比(?:例)?|长宽比(?:例)?|横纵比|画幅(?:比例)?|(?:画布|图片|图像|海报)比例|aspect\s+ratio\b|--ar\b)\s*(?:为|是|设为|设置为|of|is|=|:)?\s*(\d{1,4})\s*[:∶比]\s*(\d{1,4})(?!\d|[.:∶]\s*\d)/iu.exec(text)
    ?? /(?<![\d.:∶])(\d{1,4})\s*[:∶比]\s*(\d{1,4})\s*(?:的\s*)?(?:宽高比|长宽比|画幅|横幅|竖幅|横版|竖版|aspect\s+ratio\b)/iu.exec(text)
    ?? /^(\d{1,4})\s*[:∶比]\s*(\d{1,4})$/u.exec(text);
  if (!ratio) return {};
  let w = Number(ratio[1]), h = Number(ratio[2]);
  if (w && h) {
    let a = w, b = h;
    while (b) [a, b] = [b, a % b];
    w /= a;
    h /= a;
    // Keep explicitly sized images near 1 MP, within CloudBase's dimension and area limits.
    const min = Math.ceil(256 / Math.min(w, h));
    const max = Math.min(Math.floor(8192 / Math.max(w, h)), Math.floor(4096 / Math.sqrt(w * h)));
    if (min <= max) {
      const scale = Math.min(max, Math.max(min, 8 * Math.round(1024 / Math.sqrt(w * h) / 8)));
      return { size: `${w * scale}x${h * scale}` };
    }
  }
  return { error: "该宽高比无法生成有效尺寸。请使用正整数比例，如「宽高比 5:2」。" };
}

function diagnostic(err) {
  const message = String(err?.message ?? "");
  const rawCode = err?.code ?? err?.err?.code ?? message.match(/错误码[:：]\s*([\w.-]+)/)?.[1];
  const code = /^[\w.-]{1,80}$/.test(String(rawCode ?? "")) ? String(rawCode) : "NO_SDK_CODE";
  const reasons = [
    [/MODULE_NOT_FOUND|Cannot find module/i, "SDK 或其依赖没有成功加载。"],
    [/environment|envId|TCB_ENV|环境ID/i, "错误信息涉及云环境，请核对当前环境。"],
    [/quota|balance|resource package|insufficient|额度|资源包|余额/i, "错误信息涉及额度，请检查本环境的生图资源。"],
    [/permission|unauthorized|forbidden|access denied|权限|未授权|调用来源/i, "错误信息涉及权限或调用来源。"],
    [/timeout|timedout|超时/i, "SDK 或上游请求超时。"],
    [/credential|access.token|密钥|凭证/i, "SDK 获取或使用运行身份凭证时出错。"],
    [/content.?policy|moderation|审核/i, "上游提示内容审核问题。"],
  ];
  return {
    code,
    message: reasons.find(([re]) => re.test(`${code} ${message}`))?.[1] ?? "请按失败阶段及错误码排查。",
    ...(/^[a-zA-Z0-9-]{8,80}$/.test(err?.requestId ?? "") && { requestId: err.requestId }),
  };
}

exports.main = async (event) => {
  const started = Date.now();
  let stage = "load-sdk";
  try {
    const sdk = require("@cloudbase/node-sdk");
    const versions = {
      nodeSdk: require("@cloudbase/node-sdk/package.json").version,
      aiSdk: require("@cloudbase/ai/package.json").version,
    };
    stage = "init";
    const context = sdk.getCloudbaseContext();
    const env = context.TCB_ENV || process.env.TCB_ENV || process.env.ENV_ID || context.SCF_NAMESPACE;
    if (!env) return { ok: false, stage, code: "ENV_NOT_FOUND", message: "请将环境变量 ENV_ID 设为当前 CloudBase 环境 ID。" };
    const model = sdk.init({ env, timeout: 180_000 }).ai().createImageModel("cloudbase");
    if (typeof model?.generateImage !== "function") return { ok: false, stage, code: "IMAGE_SDK_UNAVAILABLE", versions };
    const footnoteMode = process.env.IMAGE_FOOTNOTE_MODE || "empty";
    if (!["empty", "space", "omit"].includes(footnoteMode)) {
      return { ok: false, stage: "config", code: "INVALID_FOOTNOTE_MODE", message: "IMAGE_FOOTNOTE_MODE 只接受 empty、space 或 omit。", modelCalled: false };
    }
    const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
    const { size, error } = requestedSize(prompt);
    if (error) return { ok: false, stage: "input", code: "INVALID_ASPECT_RATIO", message: error, modelCalled: false };
    if (event?.action === "check") return { ok: true, stage: "ready", versions, footnoteMode, requestedSize: size ?? "auto", modelCalled: false };
    if (!prompt) return { ok: false, stage: "input", code: "EMPTY_PROMPT", message: "请传入非空的 prompt。" };
    stage = "generate";
    const res = await model.generateImage({
      model: "hy-image-v3.5-preview",
      ...(size && { size }),
      ...(footnoteMode !== "omit" && { footnote: footnoteMode === "space" ? " " : "" }),
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    if (res?.error) throw res.error;
    stage = "response";
    const image = res?.choices?.[0]?.delta?.image;
    if (!image?.url) return { ok: false, stage, code: "NO_IMAGE_URL", elapsedMs: Date.now() - started };
    return { ok: true, url: image.url, width: image.width, height: image.height };
  } catch (err) {
    return { ok: false, stage, ...diagnostic(err), elapsedMs: Date.now() - started };
  }
};
