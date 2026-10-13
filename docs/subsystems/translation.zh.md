# 文本翻译

[English](translation.md) | 中文

实验性 [translator](../../packages/experimental/translator/README.zh.md) 通过免登录 Google 或 Bing 浏览器端点翻译文本。它独立于 Agent 和 Session 运行；消费者负责展示、调度与保留结果。

## 请求与结果

`TranslationProvider` 选择 `google` 或 `bing`。`TranslationRequest` 提供 `text`、`targetLanguage` 及可选的 `sourceLanguage` 和 `provider`。`resolve()` 将显式路由写入 `TranslationSpec`：配置的默认 Provider 为 Bing，省略源语言时自动检测。常见中文 locale 标签映射为所选 Provider 的语言代码。`translate()` 返回所选 Provider 翻译后的纯文本。

服务公开配置的 `maxTextChars`，单位为 UTF-16 code unit。消费者先拆分超长输入，再请求翻译。每次调用限制响应字节数，并将响应体读取计入超时。调用者取消和服务卸载都会中止已接收的请求；卸载等待这些请求完成。

## 失败与数据处理

`TranslationError` 的 `TranslationErrorCode` 区分文本超限、HTTP 失败、无效响应、响应超限、服务自身超时与请求失败。Provider 错误信息省略提交的文本与响应体。失败时不选择其他 Provider。响应作为外部 JSON 校验，重定向被拒绝。

Google 在 form POST 请求体中接收原文，Bing 在 JSON POST 请求体中接收原文。两者都是远端服务。免登录端点不保证开发者 API 的可用性或免费额度。区域连通性须在用户网络上验证。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtranslator--translator"></a>

### `ctx.translator` — `Translator`

One Host service with explicit routing, cancellation and quiescent unload.

```ts cordis-catalog
/**
 * Resolve provider and source-language defaults without sending text.
 * @param request - consumer text, destination and optional routing choices.
 * @returns a complete specification; exceeding `maxTextChars` throws `TRANSLATION_TEXT_LIMIT`.
 */
resolve(request: TranslationRequest): TranslationSpec

/**
 * Translate one resolved specification; the selected provider receives its text.
 * @param spec - complete routing and language choices from `resolve()`.
 * @param signal - optional caller cancellation, combined with service disposal.
 * @returns translated plain text; rejects provider/limit failures and preserves cancellation reasons.
 */
async translate(spec: TranslationSpec, signal?: AbortSignal): Promise<string>
```

Source: [`packages/experimental/translator/src/index.ts`](../../packages/experimental/translator/src/index.ts)
<!-- END GENERATED cordis-surface -->
