# Text translation

English | [中文](translation.zh.md)

The experimental [translator](../../packages/experimental/translator/README.md) translates text through anonymous Google or Bing browser endpoints. It runs independently of Agents and Sessions; consumers own display, scheduling, and retention.

## Requests and results

`TranslationProvider` selects `google` or `bing`. `TranslationRequest` supplies `text`, `targetLanguage`, and optional `sourceLanguage` and `provider`. `resolve()` captures explicit routing in `TranslationSpec`: the configured provider defaults to Bing and omitted source language uses automatic detection. Common Chinese locale tags map to the selected provider's language codes. `translate()` returns plain text from the resolved provider.

The service exposes its configured `maxTextChars`, measured in UTF-16 code units. Consumers split longer inputs before requesting translation. Each call bounds the response bytes and includes the response-body read in its deadline. Caller cancellation and service disposal abort accepted requests; disposal waits for them to settle.

## Failures and data handling

`TranslationError` carries a `TranslationErrorCode` distinguishing text limits, HTTP failures, invalid responses, response limits, owned deadlines, and request failures. Provider diagnostics omit submitted text and response bodies. Failed calls do not select another provider. Responses are validated as external JSON and redirects are rejected.

Google receives source text in a form POST body; Bing receives it in a JSON POST body. Both are remote services. Their anonymous endpoints provide no supported developer availability or quota guarantee. Regional connectivity must be verified on the user's network.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
