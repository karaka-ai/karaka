---
description: "Application JWT verification settings and rejection behavior for Karaka browser transports."
kind: "package-reference"
---

# @karaka-ai/browser-auth

English | [中文](README.zh.md)

## Summary

Verify application-issued browser credentials with public keys while keeping signing keys in the application backend. Require an explicit application, issuer, audience, and lifetime. Successful verification returns the signed tenant and user plus the expiry time. The transport owns connection expiry and request authorization.

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

Mount `@karaka-ai/browser-auth` in `cordis.yml`. Supply nonempty `applicationId`, `issuer`, and `audience`, a positive `maxTokenAgeSeconds`, and at least one `keys` entry containing `id`, `algorithm`, and SPKI PEM `publicKey`. Supported algorithms are `ES256`, `RS256`, and `EdDSA`. Duplicate key IDs or invalid public keys prevent mounting.

JWTs must contain `exp`, `iat`, `applicationId`, `tenantId`, and `userId`. Verification rejects invalid signatures, unknown key IDs, mismatched claims, expired tokens, and issued lifetimes exceeding the configured maximum. Validation failures return `undefined`; unrelated runtime errors propagate.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [verifier](src/index.ts) imports configured public keys before providing `karakaBrowserAuth`. Each JWT selects one key by its protected `kid`, and that key must match the protected algorithm. Returned expiration timestamps use milliseconds since the Unix epoch.

No invariant companion is published because JWT verification has no mutable ownership registry or independently derived authentication state to compare.

</details>


-----

<a id="further-exploration"></a>
## Further Exploration

- [Identity](../identity/README.md): signed owner types.

- [Server authentication](../server-auth/README.md): application server credentials.

- [HTTP transport](../transport-http/README.md): browser ingress.

-----

<a id="model-experience"></a>
## Model Experience

### Authorization

#### What the model sees

`karakaBrowserAuth` adds no model context or tools; the transport consumes its verified owner.

#### Token effect

JWT verification adds no input tokens or tool descriptions.

#### KV Cache effect

JWT verification does not change the model request prefix or KV-cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Deployments must account for these constraints.

- Verification keys are configured at mount time; this service does not fetch JWKS or manage signing keys.
- The transport must enforce `expiresAt` after authentication; this service does not own browser connections or implement the DSH Connection wire protocol.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
