# CloudBase Bridge

[English](README.md) | [简体中文](README.zh-CN.md)

一个 **[Magpie](https://usemagpie.ai) / OpenCode 供应商插件**：通过**你自己部署**
的 `aiProxy` 云函数，把腾讯云开发 CloudBase「小程序成长计划」的 AI 额度
变成普通的 OpenAI 兼容供应商。

> **独立性声明。** 本项目是社区作品，**未经 Magpie 官方审核或收录**，与
> 腾讯云 / 腾讯云开发**无任何隶属关系**。下文的模型可用性说明摘自腾讯公开
> 文档并注明核对日期，使用前请以官方页面为准。

---

## 为什么要经过云函数？

成长计划赠送额度只能从 **CloudBase SDK 通道**消耗（小程序端 SDK、云开发
服务端 SDK、控制台）。直接请求 HTTP AI 模型端点会被拒绝：

```
POST https://{envId}.api.tcloudbasegateway.com/v1/ai/…/chat/completions
→ 403 AI_CHANNEL_NOT_ALLOWED
```

因此本插件**完全不请求 `/v1/ai/*`**，而是通过官方**函数调用端点**请求一个
普通（事件型）云函数 —— 名为 **`aiProxy`** —— 由它用 `@cloudbase/node-sdk`
调用模型（这是允许的通道）：

```
Agent ──► magpie 网关 ──► 插件 fetch（本仓库）
                            │  POST https://{envId}.api.tcloudbasegateway.com/v1/functions/aiProxy
                            │  Authorization: Bearer <CloudBase API Key>
                            ▼
                       aiProxy（你部署在你的环境里）
                            │  @cloudbase/node-sdk
                            │  ai.createModel("cloudbase").generateText({ model, messages })
                            ▼
                       hy3 / hy4-preview / deepseek-v4.1-flash
```

云函数返回**一次性** OpenAI Chat Completions JSON；插件负责适配，并在
agent 请求 `stream: true` 时**合成 SSE**（角色 chunk → 内容 chunk → 结束
chunk → `data: [DONE]`）。Magpie 网关会替你在各家 API 之间转换，所以任何
agent 都能用。

## 模型

成长计划赠送额度可抵扣模型，依据
[官方通知](https://docs.cloudbase.net/ai/ai-inspire-plan-new-models)
（核对日期 **2026-11-09**，使用前请复核）：

| 模型 ID | 上下文 | 图片 | 本插件中的状态 |
| --- | --- | --- | --- |
| `hy3` | 256K | — | 启用 |
| `hy4-preview` | 1M | — | 启用 |
| `deepseek-v4.1-flash` | 1M | 模型支持，但**本代理不转发图片** | 启用 |
| `hy4` | ? | ? | **禁用**占位（不在当前官方通知中） |
| `deepseek-v4.1-flash-1017` | ? | ? | **禁用**占位（不在当前官方通知中） |

说明：

- 成长计划三个模型**无需在控制台开启**，Token 用量自动从赠送资源包扣除。
- 两个占位模型来自前作
  ([opencode-cloudbase-auth](https://github.com/Le0nByte/opencode-cloudbase-auth))，
  但**不在当前官方通知目录**，因此默认禁用。你可以在 Magpie/OpenCode 配置里
  重新启用，并用函数的环境变量 `AI_PROXY_ALLOWED_MODELS` 放开白名单 ——
  到底能不能调，由 CloudBase 自己裁决，不行就返回 `AI_MODEL_NOT_SUPPORTED`。
- 走出赠送额度之外的调用，按 Token Credits 资源包计费（托管分组
  `cloudbase`）。

## 你需要准备什么

1. 一个 CloudBase 环境（成长计划，或已购买有效的 Token Credits 资源包）。
2. 在**该环境**中部署 **aiProxy 云函数** —— 见
   [`cloudfunctions/aiProxy/README.md`](cloudfunctions/aiProxy/README.md)。
3. 一个**服务端 CloudBase API Key**，在控制台
   [tcb.cloud.tencent.com → 环境设置 → API Key](https://tcb.cloud.tencent.com/dev?#/identity/token-management)
   创建。

> ⚠️ **API Key 是环境的最高权限凭证**（管理员权限，绕过按用户的数据访问
> 检查）。只放在自己机器上。本插件只在函数调用请求的
> `Authorization: Bearer` 头中使用它，绝不会写进源码、默认配置、日志或错误
> 信息。Magpie 把登录信息保存在 `~/.config/magpie/plugin-auth.json`
> （权限 600）。

## 安装与登录（Magpie）

```bash
# 从 npm（发布后）
magpie plugin add opencode-cloudbase-bridge

# 或直接从本 GitHub 仓库
magpie plugin add DaBinBinah/cloudbase-bridge

# 或就地加载本地目录
magpie plugin add ./cloudbase-bridge

magpie plugin login cloudbase
#   1. 粘贴 CloudBase 服务端 API Key
#   2. 输入环境 ID        （如 cloud1-2a3b4c5d6e7f）
#   3. 选择区域           （中国大陆默认 / 国际站）
#   4. 云函数名           （回车 = aiProxy）
```

登录回答（envId、region、functionName）按账号存放在 Magpie 本机认证存储的
`metadata` 里，不写入仓库或 npm 包。登出即删除：

```bash
magpie plugin logout cloudbase
```

在 Magpie 应用里：打开**插件**，添加插件（npm 名 / `github:owner/repo` /
文件夹路径），然后在供应商那一行登录。模型名形如 `cloudbase/hy3`、
`cloudbase/hy4-preview`、`cloudbase/deepseek-v4.1-flash`（若 Magpie 已占用
`cloudbase` 这个 id，会自动变成 `cloudbase-plugin/…`，插件两种前缀都认）。

## 沙盒测试（不碰你正在用的 magpie）

```bash
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config XDG_CACHE_HOME=$sb/.cache MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./cloudbase-bridge   </dev/null
m plugin --json                   # 宿主报告的方式、账号、模型、加载错误
m plugin login cloudbase          # 走一遍每个提问
m provider test cloudbase         # 通过 aiProxy 发一个小请求
m provider test cloudbase hy3     # 只测指定模型
m quota                           # usage 钩子（未实现，见“限制”）
m plugin logout cloudbase
```

没装 Magpie，或想在没有 CloudBase 环境的情况下验证插件逻辑？把它指向仓库
自带的 mock 网关：

```bash
node scripts/mock-ai-proxy.mjs --port 8787            # 终端 1
# 终端 2（同样用上面的沙盒方式），然后：
m plugin options <插件短名> '{"gatewayBaseUrl":"http://127.0.0.1:8787"}'
```

> `gatewayBaseUrl` 是**仅用于测试**的选项：它会把所有请求（包括 API Key
> 请求头）重定向到该地址。正式使用请移除该选项
> （`magpie plugin options <名字> off`），也不要指向不受你控制的端点。

## 配置参考

| 内容 | 位置 | 取值 |
| --- | --- | --- |
| 环境 ID / 区域 / 云函数名 | 登录 `prompts`（按账号保存） | 如 `cloud1-…`、`cn`/`intl`、`aiProxy` |
| 同上，作为后备 | 插件 options（`plugins.json` → options） | `envId`、`region`、`functionName` —— 在纯 OpenCode 下 prompts 可能不渲染，用这里兜底 |
| 调用超时 | 选项 `timeoutMs` | 默认 150000 ms（高于推荐的 120 s 函数超时） |
| 测试网关覆盖 | 选项 `gatewayBaseUrl` | 生产不设置 |
| 模型白名单 | 函数环境变量 `AI_PROXY_ALLOWED_MODELS` | 逗号分隔；默认 `hy3,hy4,hy4-preview,deepseek-v4.1-flash,deepseek-v4.1-flash-1017` |
| 函数超时 | CloudBase 函数配置 | 建议 **120 s** |

账号级取值优先于插件 options。`provider.models` 钩子会 ping aiProxy
（`{"action":"ping"}`），只显示已部署函数白名单接受的模型；ping 失败时
沿用静态目录。

## 本地开发

```bash
npm install
npm run check      # 类型检查 (tsc) + 构建 + node --test + 模拟宿主加载检查
npm test           # 构建 + 单元测试（32 个，无需网络）
node scripts/check-plugin.mjs   # 像 Magpie 一样加载 dist/，对 mock 网关端到端验证
node scripts/mock-ai-proxy.mjs  # 独立的网关/函数 mock
```

**本仓库内已验证**（macOS、Node 24、TypeScript 5.9）：`tsc --noEmit` 无错，
32/32 单元测试通过，模拟宿主加载检查 9/9 通过（模块导出形状、config 钩子、
登录 prompts、loader、ping 驱动的模型列表、非流式 + 流式往返、
`FUNCTIONS_NOT_FOUND` 与坏 Key 的错误映射、日志无凭证泄漏）。

**本仓库未验证 —— 请你在真实环境自行执行：** 上面的 Magpie 沙盒命令、真实
部署 aiProxy 后的 `ping`、走成长计划的真实对话补全、额度行为。在这些验证
完成前，本项目不对它们做任何断言。

## 限制（设计使然，不是 bug）

- **没有真流式。** 上游回复是一份完整 JSON，SSE 在本地合成，因此
  首 token 时间 = 完整生成时间。短回答无感，长回答偏慢（与前作相同的取舍）。
- **不支持工具调用。** 官方文档中 `generateText` 的输入只有
  `{ model, messages, temperature?, topP? }` —— `tools`/`tool_choice`
  不转发，模型目录声明 `tool_call: false`。
- **不支持图片输入。** OpenAI 风格的图片分片会被拒绝
  （`IMAGE_INPUT_NOT_SUPPORTED`；该 SDK 通道文档只定义字符串内容）。
- **忽略 `max_tokens`**（不在 SDK 文档输入中）。
- **云函数超时会截断长输出** —— 把函数超时调到 120 s；插件调用超时默认 150 s。
- **没有额度上报**（`auth.usage`）：官方没有给出成长计划赠送余额的 HTTP API，
  该钩子未实现。
- 成长计划赠送额度**有期限**（按活动条款 6 个月）。

## 与 opencode-cloudbase-auth 的差异

本项目替代前作，并按当前官方文档修正旧实现滞后之处：

| 主题 | opencode-cloudbase-auth | cloudbase-bridge |
| --- | --- | --- |
| 模型分组 | `createModel(provider)`，默认 `hunyuan-v3` | 按官方通知改为 `createModel("cloudbase")` |
| 模型目录 | `hy3, hy4, hy4-preview, deepseek-v4.1-flash, deepseek-v4.1-flash-1017` | 官方通知确认的 3 个启用，其余 2 个保留为禁用占位，并记录来源与核对日期 |
| 环境 ID | 登录时收集 | 登录时收集；云函数侧从 `TCB_ENV`（运行时注入）读取 |
| 区域 | 仅国内网关 | 登录时选择 `cn` / `intl` 网关 |
| 模型列表 | 静态 | 通过 `ping` 按账号从 aiProxy 白名单刷新 |
| 语言/形态 | 单文件 `index.mjs` | TypeScript 源码 + 构建产物 `dist/` 入库（Magpie GitHub 发现路径必需），带测试与加载检查 |

## 仓库结构

```
├── package.json              # npm 包 + magpie metadata + 插件入口
├── src/index.ts              # 插件源码（TypeScript，零运行时依赖）
├── dist/index.js             # 构建产物 —— 提交入库（GitHub 发现路径必需）
├── cloudfunctions/aiProxy/   # 云函数（事件函数，index.main）
├── cloudbaserc.example.json  # tcb CLI 部署配置
├── test/                     # 单元测试（node --test）
├── scripts/                  # 模拟宿主加载检查 + mock 网关
├── docs/troubleshooting.md   # FUNCTIONS_NOT_FOUND、AI_CHANNEL_NOT_ALLOWED 等
├── docs/publish-checklist.md # GitHub 发布与 Magpie 收录步骤
└── examples/registry-entry.json  # magpie-community registry.json 条目
```

## 发布 / 收录（维护者）

两条相互独立的路径（GitHub Unofficial 发现 vs 社区精选列表）见
[`docs/publish-checklist.md`](docs/publish-checklist.md)。本仓库尚未向任何
外部渠道提交过内容。

## 许可证

[MIT](LICENSE)。
