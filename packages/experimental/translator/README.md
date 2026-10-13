---
description: "Translate transient text through anonymous Bing or Google endpoints, defaulting to Bing."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-translator

English | [中文](README.zh.md)

## Summary

`ctx.translator` translates one bounded text request through Bing or Google. It requires no API key or login and defaults to Bing. This experimental package is opt-in.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package as a Cordis service. Call `resolve({ text, targetLanguage, sourceLanguage?, provider? })`, then `translate(spec, signal?)`. The result is plain translated text. An omitted source uses `auto`; an omitted provider uses configured `provider`, initially `bing`. Consumers can read `maxTextChars` to split longer text before submission.

| Config | Default | Meaning |
|---|---|---|
| `provider` | `bing` | `google` or `bing` |
| `googleEndpoint` | `https://translate.googleapis.com/translate_a/single` | Google-compatible anonymous endpoint |
| `bingEndpoint` | `https://edge.microsoft.com/translate/translatetext` | Microsoft Edge browser translation endpoint |
| `timeoutMs` | `10000` | Deadline for the request and complete response body |
| `maxTextChars` | `4000` | Maximum submitted UTF-16 code units per request |
| `maxResponseBytes` | `1048576` | Maximum response body bytes before JSON parsing |

Endpoints accept HTTP(S) URLs without credentials or fragments. Native `fetch` uses the Host's global dispatcher and the HTTP proxy policy installed by the `dsh` launcher. No new translation library is required.

The service maps `zh`, `zh-CN`, `zh-SG` and `zh-Hans` to Simplified Chinese, and `zh-TW`, `zh-HK`, `zh-MO` and `zh-Hant` to Traditional Chinese. Other tags pass through to the selected provider. Empty text returns an empty string without a network request.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

Google receives a form POST using the `gtx` client; Bing receives a JSON text array through Microsoft's Edge endpoint. Both receive submitted text in the request body. Cookies, HTTP redirects and automatic provider fallback are disabled. Text and translations remain transient; this service changes neither Session events nor model requests.

`TranslationError.code` distinguishes input limits, HTTP failures, response limits, invalid provider responses, transport failures and the service's `TRANSLATION_TIMEOUT` deadline. Diagnostics include no submitted text or provider error body. `translate()` always returns a Promise and rejects admission or provider failures. Caller cancellation and service disposal preserve their original abort reasons, including caller-owned timeout reasons. Unloading aborts accepted requests and waits for settlement. Input limits apply in both `resolve()` and `translate()`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Experimental packages](../README.md) · [HTTP proxy behavior](../../util/http-proxy/README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as translation is transient and does not contribute to model requests or Session logs.

#### KV Cache effect

No direct effect; translation does not change model history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- These unofficial browser endpoints have no supported third-party API guarantee. They may rate-limit requests, become unavailable or change response formats. Availability from mainland China depends on the user's network; the service guarantees no region-wide connectivity.
- Unsupported language tags fail through the selected provider. Consumers own paragraph scheduling, input splitting, caching and any display fallback; this service performs one request and never retries or switches providers.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

Live provider tests use the actual default endpoints without credentials. They are skipped unless explicitly enabled with `DSH_TRANSLATION_LIVE=1 pnpm run test:e2e packages/experimental/translator/tests/upstream.e2e.ts`. They cover Bing automatic and explicit source selection, both providers' Chinese locale tags, and a Google request at the default 4000-character limit.

</details>
