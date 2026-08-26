# Agent Note: Split JWT identity verification into a three-role capability

Status: implemented

English | [中文](2026-08-26-jwt-identity-capability-seam.zh.md)

## Problem

SaaS transports need to turn an external credential into trusted runtime identity without binding the harness to one identity provider, HTTP framework, tenant model, or application authorization policy. Treating verification, authority normalization, and resource authorization as one service would make cryptographic provider replacement carry application-specific policy. Putting bearer parsing or JWT verification directly in REST/SSE handlers would instead duplicate security behavior and let transports accumulate business logic.

## Decision

JWT identity verification is one complete three-role capability under `packages/identity/`:

- `@deepseek-ai/dsh-identity` owns the provider-neutral Service Definition, `ctx.identity`, the credential request, immutable `VerifiedIdentity`, branded issuer/subject/audience/token identifiers, and stable safe `IdentityError` codes.
- `@deepseek-ai/dsh-identity-jwks` is the first Service Provider. It uses `jose` to verify signed JWTs against an explicitly configured issuer, audience, remote JWKS URL, and algorithm allowlist. It requires `sub`, `iat`, and `exp`, separates invalid credentials from provider unavailability, and detaches and freezes claims before returning them.
- `@deepseek-ai/dsh-identity-http-bearer` is the first Consumer. It registers `ctx.identityHttpBearer`, accepts the raw Authorization-header shape used by HTTP runtimes, admits exactly one Bearer credential, and delegates verification only through `ctx.identity`.

The abstract Service Definition is a shared dependency, not a standalone Loader row. Compositions mount one provider and any Consumers. The JWKS provider and HTTP Consumer never depend on each other.

Verified identity stops at cryptographically trusted issuer-local facts. It contains no Karaka tenant id, application user id, role, permission, or resource decision. Authority normalization and resource authorization remain separate future capability seams whose providers may consume `VerifiedIdentity`.

The JWKS provider permits HTTPS endpoints and loopback HTTP for local development. It rejects URL credentials and fragments, exposes request/cache timing as configuration, relies on `jose` for key selection and signature/registered-claim verification, and never attaches the raw provider error or credential to its public failure.

## Testing

Package tests pin Service lifecycle disposal, stable safe errors, strict Authorization parsing, provider delegation, configuration constraints, real RSA signing and loopback JWKS retrieval, issuer/audience/expiry/required-claim/algorithm/signature refusal, provider-unavailable classification, claim immutability, and cancellation before work. A real Loader test boots provider and Consumer rows from a test-only `cordis.yml` and verifies a signed credential through the assembled seam.

## Alternatives considered

- **One package for contract, JWKS verification, bearer parsing, and future authority mapping** — rejected because replacing the identity provider or HTTP adapter would require changing an unrelated role, and application authority policy would leak into a generic cryptographic boundary.
- **Return normalized Karaka authority from `ctx.identity`** — rejected because a verified subject is not yet a tenant membership or authorization grant. The same issuer identity can map differently by SaaS application and deployment.
- **Parse and verify credentials inside every REST/SSE plugin** — rejected because transports would duplicate security-sensitive behavior, choose concrete providers, and become harder to test independently from route logic.
- **Hand-roll JWT/JWKS verification** — rejected because maintained JOSE code already owns algorithm validation, JWS verification, claim validation, key selection, refresh cooldown, caching, and request timeout behavior.
- **Mount the abstract Service Definition as a third Loader row** — rejected because the provider subclass is the concrete `ctx.identity` registration. A separate abstract row has no behavior and would create a competing service owner.

## Consequences

Transports gain one narrow, replaceable entry to trusted identity while cryptography, HTTP extraction, authority normalization, and authorization remain independently replaceable plugins. The split costs three package manifests, documentation sets, invariant companions, and cross-package composition tests. The initial request vocabulary admits only bearer credentials, the initial provider supports one configured issuer per Cordis scope, and its remote-key cache is process-local; later credential kinds and providers extend or replace the seam without adding application branches to these packages.
