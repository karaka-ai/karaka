---
description: "Verify backend-issued browser credentials into an application, tenant, and user identity."
kind: "package-reference"
---

# @karaka-ai/browser-auth

English | [中文](README.zh.md)

## Summary

Accept short-lived application credentials without embedding application login logic in Karaka. The application backend signs each credential; this plugin verifies it and supplies the complete trusted owner to the existing browser connection.

## Table of Contents

- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="configuration"></a>
## Configuration

Mount `@karaka-ai/agent/browser-auth` before the application-mode Connection. Every field below is required. See the [Agent browser entry](../agent/README.md#browser-clients) for deployment and client assembly.

| Field | Meaning |
|---|---|
| `applicationId` | Exact application claim accepted by this deployment |
| `issuer`, `audience` | Required JWT issuer and audience |
| `maxTokenAgeSeconds` | Maximum age and issued lifetime, 1–2,147,483 seconds |
| `keys` | Nonempty list of unique `id`, `algorithm` (`ES256`, `RS256`, or `EdDSA`), and SPKI PEM `publicKey` |

Credentials require a matching protected `kid` and algorithm, `iss`, `aud`, `iat`, `exp`, and nonempty `applicationId`, `tenantId`, `userId` claims. Invalid signatures, wrong claims, excessive lifetime, and expired credentials are rejected. Invalid or duplicate verification keys fail plugin activation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Verification and ownership</summary>

The maintained `jose` verifier checks signed claims against configured public keys. The provider returns `ConnectionCaller` with the atomic owner and absolute expiry; Connection and Gateway own HTTP, WebSocket, authorization, and reconnect lifetimes. Signing keys and login sessions remain in the application backend.

</details>

No runtime invariant companion is published because credentials are resolved and checked at each request boundary.

<a id="model-experience"></a>
## Model Experience

None, as credential verification adds no model-visible input.

#### KV Cache effect

None; verification runs outside model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No login or token issuance** — the application backend owns both.
- **No per-token revocation list** — credentials remain valid until expiry; verification-key changes apply when the provider reloads. Existing sockets retain their verified identity until expiry.

<a id="dev-note"></a>
### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
