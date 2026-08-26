# Runtime Identity

English | [中文](identity.zh.md)

The runtime identity subsystem proves external credentials without deciding application authority. Its complete first capability has three roles: [`dsh-identity`](../../packages/identity/identity/README.md) defines `ctx.identity`, [`dsh-identity-jwks`](../../packages/identity/identity-jwks/README.md) verifies signed JWTs through remote JWKS, and [`dsh-identity-http-bearer`](../../packages/identity/identity-http-bearer/README.md) adapts an HTTP Authorization header to the provider-neutral request.

## Boundary

`VerifyIdentityRequest` carries an opaque bearer credential and optional cancellation. `VerifiedIdentity` contains a trusted issuer-local subject, audiences, issuance and expiration times, an optional not-before time and token id, and a deeply immutable verified claim set. `HttpBearerIdentityRequest` carries the raw Authorization value shape exposed by common HTTP runtimes.

These types do not contain a tenant id, application user id, role, permission, or resource decision. Later authority-normalization and resource-authorization capabilities consume verified identity through their own Service Definitions and providers.

## Failure contract

`IdentityError.code` distinguishes missing, malformed, unsupported, and invalid credentials from provider unavailability and cancellation. Messages are safe for transport mapping and never include raw credentials or underlying provider errors.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxidentity--identity-abstract-seam"></a>

### `ctx.identity` — `Identity` (abstract seam)

Replaceable credential verifier.

```ts cordis-catalog
/**
 * Verify one credential and return only cryptographically trusted identity
 * claims. Authority normalization and authorization are separate seams.
 * @param request - credential envelope and optional cancellation.
 * @returns deeply immutable verified identity claims.
 */
abstract verify(request: VerifyIdentityRequest): Promise<VerifiedIdentity>
```

Source: [`packages/identity/identity/src/index.ts`](../../packages/identity/identity/src/index.ts)

<a id="ctxidentityhttpbearer--identityhttpbearer"></a>

### `ctx.identityHttpBearer` — `IdentityHttpBearer`

HTTP-specific credential adapter. Future REST/SSE plugins inject this service instead of parsing credentials or selecting an identity provider.

```ts cordis-catalog
/**
 * Parse exactly one Bearer credential and delegate provider verification.
 * @param request - raw Authorization value and optional cancellation.
 * @returns the provider's deeply immutable verified identity.
 */
async authenticate(request: HttpBearerIdentityRequest): Promise<VerifiedIdentity>
```

Source: [`packages/identity/identity-http-bearer/src/index.ts`](../../packages/identity/identity-http-bearer/src/index.ts)
<!-- END GENERATED cordis-surface -->
