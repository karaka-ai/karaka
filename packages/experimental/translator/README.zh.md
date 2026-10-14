---
description: "通过无需登录的 Bing 或 Google 端点翻译临时文本，默认使用 Bing。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-translator

[English](README.md) | 中文

## 概述

`ctx.translator` 通过 Bing 或 Google 翻译一次有大小限制的文本请求。它无需 API 密钥或登录，默认使用 Bing。此实验包需要显式启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包挂载为 Cordis 服务。先调用 `resolve({ text, targetLanguage, sourceLanguage?, provider? })`，再调用 `translate(spec, signal?)`，结果为翻译后的纯文本。省略源语言时使用 `auto`；省略提供者时使用配置中的 `provider`，初始为 `bing`。消费者可以读取 `maxTextChars`，在提交前拆分较长文本。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `provider` | `bing` | `google` 或 `bing` |
| `googleEndpoint` | `https://translate.googleapis.com/translate_a/single` | 兼容 Google 的匿名端点 |
| `bingEndpoint` | `https://edge.microsoft.com/translate/translatetext` | Microsoft Edge 浏览器翻译端点 |
| `timeoutMs` | `10000` | 请求及完整响应正文的截止时间 |
| `maxTextChars` | `4000` | 每次请求提交文本的 UTF-16 代码单元上限 |
| `maxResponseBytes` | `1048576` | JSON 解析前响应正文的字节上限 |

端点接受不含凭据或片段的 HTTP(S) URL。原生 `fetch` 使用 Host 的全局分发器及 `dsh` 启动器安装的 HTTP 代理策略。无需新增翻译库。

服务将 `zh`、`zh-CN`、`zh-SG` 和 `zh-Hans` 映射为简体中文，将 `zh-TW`、`zh-HK`、`zh-MO` 和 `zh-Hant` 映射为繁体中文。其他标签原样传给所选提供者。空文本直接返回空字符串，不发送网络请求。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者细节 — 点击展开</summary>

Google 接收使用 `gtx` 客户端的表单 POST 请求；Bing 通过 Microsoft Edge 端点接收 JSON 文本数组。两者都通过请求正文接收提交的文本。Cookie、HTTP 重定向和自动切换提供者均已禁用。文本和译文保持临时状态；本服务不会修改 Session 事件或模型请求。

`TranslationError.code` 区分输入限制、HTTP 失败、响应限制、无效的提供者响应、传输失败及服务自身的 `TRANSLATION_TIMEOUT` 截止时间。诊断不包含提交的文本或提供者错误正文。`translate()` 始终返回 Promise，准入或提供者失败都会使其拒绝。调用者取消和服务卸载保留原始中止原因，包括调用者自身的超时原因。卸载时中止已接受的请求并等待它们结束。`resolve()` 和 `translate()` 都执行输入限制。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[实验包](../README.zh.md) · [HTTP 代理行为](../../util/http-proxy/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为翻译是临时操作，不会加入模型请求或 Session 日志。

#### KV 缓存影响

无直接影响；翻译不会改变模型历史。

## 已知限制与待办事项

<a id="known-limitations-and-deferred-work"></a>

- 这些非官方浏览器端点不保证支持第三方 API 调用。它们可能限流、不可用或更改响应格式。在中国大陆的可用性取决于用户网络；服务不保证覆盖整个地区的连接能力。
- 不支持的语言标签由所选提供者报错。消费者负责段落调度、输入拆分、缓存及显示回退；本服务只执行一次请求，不重试或切换提供者。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节 — 点击展开</summary>

真实提供者测试无需凭据，使用实际默认端点。测试默认跳过，需显式运行 `DSH_TRANSLATION_LIVE=1 pnpm run test:e2e packages/experimental/translator/tests/upstream.e2e.ts` 才启用。它们覆盖 Bing 自动及显式源语言选择、两种提供者的中文区域标签，以及达到默认 4000 字符上限的 Google 请求。

</details>
