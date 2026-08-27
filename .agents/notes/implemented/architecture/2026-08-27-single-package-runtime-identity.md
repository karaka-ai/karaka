# Agent Note: Combine runtime identity roles in one plugin package

Status: implemented

English | [中文](2026-08-27-single-package-runtime-identity.zh.md)

## Problem

SaaS hosts need one small identity entry for two current deployment forms: trusted server code calling Karaka in the same process, and an HTTP worker receiving an untrusted Bearer credential. Splitting the first implementation into separate definition, JWKS-provider, and HTTP-consumer packages made operators compose multiple rows and made maintainers carry three manifests, invariant companions, documentation sets, and package graphs before a second provider or consumer existed. The split also could not represent embedded identity without another provider package.

Identity still must keep browser-controlled ids out of the trusted path, centralize strict Authorization parsing, rely on maintained JOSE verification, return detached immutable values, and stop before roles, permissions, resource ownership, or session access.

## Decision

`@deepseek-ai/dsh-identity` is one concrete Cordis plugin package that combines the Service Definition, current providers, and current consumer behind `ctx.identity.resolve(request)`. It is the only identity Loader row and default-exports the concrete `Identity` service.

`ResolveIdentityRequest` is a discriminated union. The `trusted` form accepts package-branded `userId` and optional `tenantId` from typed same-process host code; the service copies those values into a new frozen result without adding hostile-input validation to that typed boundary. The `http-bearer` form accepts a raw Authorization value and optional cancellation, admits exactly one Bearer credential, and verifies it through the same service.

The optional nested `jwt` configuration enables the HTTP path. It requires an explicit issuer, audience, remote JWKS URL, and algorithm allowlist; exposes request timeout, refresh cooldown, cache age, clock tolerance, and additional required claims; and may name one tenant-id claim. JWT `sub` becomes the branded `userId`. A configured tenant claim is required to be a non-empty string and becomes the branded `tenantId`. The output source discriminator separates trusted and HTTP identities, while HTTP results additionally preserve detached, deeply frozen verified JWT facts and claims.

The plugin permits HTTPS endpoints and loopback HTTP for local development, rejects URL credentials and fragments at load, uses `jose` for key selection, signature and registered-claim verification, and keeps the remote-key cache process-local. Caller cancellation settles promptly with `IDENTITY_VERIFICATION_ABORTED` without aborting an in-flight shared key fetch; that fetch remains observed and may populate the cache for other callers. HTTP resolution without `jwt` fails with the safe stable `IDENTITY_VERIFICATION_UNAVAILABLE` code. Missing, malformed, unsupported, invalid, unavailable, and aborted cases retain safe stable `IdentityError` codes without raw credentials or provider errors.

Tenant normalization proves only which signed or trusted tenant id entered the run. Resource authorization remains a separate capability that decides whether that user may access a session, run, tool, or application object.

## Testing

Focused package tests cover trusted host normalization and disposal, stable safe errors, strict Authorization parsing, absent-JWT behavior, real RSA signing and loopback JWKS retrieval, issuer/audience/expiry/required-claim/algorithm/signature refusal, optional tenant mapping, clock tolerance, cache reuse, provider-unavailable classification, deep claim immutability, cancellation before work and while a gated shared fetch remains in flight, and load-time configuration rejection. A real Loader test mounts one `@deepseek-ai/dsh-identity` row and resolves both trusted and signed HTTP inputs through the assembled service.

## Alternatives considered

- **Keep separate definition, JWKS-provider, and HTTP-consumer packages** — this preserves independent replacement in theory, but there is no second implementation or separately evolving consumer. The package cost and multi-row founder integration are immediate, while extraction remains straightforward if a real replacement appears.
- **Support only trusted embedded identity** — this minimizes the embedded path but leaves the separately deployed worker without a safe credential entry and would duplicate Bearer/JWT behavior in future transports.
- **Return roles, permissions, or resource authority from identity** — rejected because a trusted or signed user/tenant id is not an authorization decision. Application policy and resource ownership change independently from credential proof.
- **Let every REST or SSE transport parse and verify JWTs** — rejected because transports would duplicate security-sensitive behavior, select concrete cryptographic policy, and become harder to test independently from route logic.
- **Hand-roll JWT/JWKS verification** — rejected because maintained JOSE code already owns algorithm validation, JWS verification, registered-claim validation, key selection, refresh cooldown, caching, and request timeout behavior.
- **Keep an abstract service package and add an embedded provider** — rejected until a second provider has an independent lifecycle or dependency set. One concrete package still contains all three capability roles and can later extract a provider without changing `ctx.identity.resolve`.

## Consequences

Embedded hosts mount one row without JWT configuration and resolve only branded application ids. HTTP workers add one nested configuration block and call the same method, so transports do not gain identity business logic. Both paths converge on one immutable user/tenant result and the same stable failures.

Every installation includes the `jose` dependency even when the trusted path is the only path, though no remote JWKS object or network work is created without `jwt`. One plugin scope supports one configured JWT issuer and one process-local key cache. A future provider with independent dependencies or lifecycle can justify extracting roles into packages while preserving the public service method and result types.
