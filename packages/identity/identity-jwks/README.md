# @deepseek-ai/dsh-identity-jwks

English | [中文](README.zh.md)

Remote-JWKS JWT Service Provider for [`@deepseek-ai/dsh-identity`](../identity/README.md). `JwksIdentity` registers `ctx.identity`, verifies compact signed JWTs with `jose`, and returns the Service Definition's immutable `VerifiedIdentity`. It never maps claims into Karaka tenants, users, roles, or permissions.

## Configuration

| Field | Contract |
|---|---|
| `issuer` | Required exact trusted issuer. |
| `audience` | Required accepted audience string or non-empty array. |
| `jwksUrl` | Required JWKS endpoint. HTTPS is mandatory except for loopback HTTP used in local development. URL credentials and fragments are rejected. |
| `algorithms` | Required non-empty signature-algorithm allowlist. There is no implicit algorithm fallback. |
| `timeoutMs` | JWKS request deadline; defaults to `5000`. |
| `cooldownMs` | Minimum delay between successful refreshes; defaults to `30000`. |
| `cacheMaxAgeMs` | Maximum age of a successfully fetched key set; defaults to `600000`. |
| `clockToleranceSeconds` | Accepted NumericDate clock skew; defaults to `0`. |
| `additionalRequiredClaims` | Claim names required in addition to the always-required `sub`, `iat`, and `exp`. |

`iss` and `aud` are both required and checked against configuration. Invalid format, signature, algorithm, registered claims, or key selection raises `IDENTITY_CREDENTIAL_INVALID`. Network, timeout, HTTP, or malformed-JWKS failures raise `IDENTITY_VERIFICATION_UNAVAILABLE`. Public errors contain neither the token nor underlying provider details.

Remote keys are cached and refreshed by `jose` according to the configured cooldown and maximum age. Successful claim data is detached and deeply frozen before crossing the provider boundary.

## Model Experience

### JWT verification

#### What the model sees

Nothing. `jose` JWKS retrieval and JWT verification remain model-hidden runtime work and add no model-visible content.

#### Token effect

Zero tokens.

#### KV Cache effect

None; provider selection and verification do not change the model-visible prefix.

## Known Limitations and Deferred Work

- **One configured issuer** — use another provider instance in an isolated Cordis scope for another issuer.
- **Remote JWKS only** — static keys, discovery documents, and hardware-backed verification providers are separate implementations of the same Service Definition.
- **Cooperative request cancellation** — an already-aborted request rejects immediately and a request aborted after verification rejects before returning; the shared remote-key fetch uses the provider's configured timeout.
- **No key-cache persistence** — key state is process-local and refetched after restart.
