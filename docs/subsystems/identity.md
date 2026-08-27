# Runtime Identity

English | [中文](identity.zh.md)

The runtime identity subsystem normalizes trusted same-process host ids and proves HTTP Bearer JWTs without making resource-authorization decisions. [`dsh-identity`](../../packages/identity/identity/README.md) combines the definition, strict Authorization consumer, and maintained remote-JWKS provider behind one concrete `ctx.identity` service.

## Boundary

`ResolveIdentityRequest` selects trusted host input or raw HTTP Authorization input. Both return a deeply immutable `ResolvedIdentity` with a branded application `userId`, optional branded `tenantId`, and a source discriminator; HTTP results also carry verified issuer, audiences, NumericDate fields, optional token id, and a detached claim set.

Trusted input accepts only branded ids established by typed host code. HTTP input maps JWT `sub` to `userId` and an explicitly configured non-empty string claim to `tenantId`; neither path grants roles, permissions, resource ownership, or session access.

## Failure contract

`IdentityError.code` distinguishes missing, malformed, unsupported, and invalid credentials from provider unavailability and cancellation. HTTP resolution without JWT configuration is unavailable. Messages are safe for transport mapping and never include raw credentials or underlying provider errors.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxidentity--identity"></a>

### `ctx.identity` — `Identity`

Identity service for trusted host values and configured HTTP Bearer JWTs.

```ts cordis-catalog
/**
 * Normalize a trusted host identity or verify one HTTP Bearer JWT.
 * Trusted input is detached and frozen without hostile validation. HTTP input
 * is parsed strictly, cancels caller settlement cooperatively, and fails with
 * `IDENTITY_VERIFICATION_UNAVAILABLE` when JWT configuration is absent.
 * Cancellation does not abort a shared remote-JWKS fetch, which may continue
 * to populate the process-local cache for other callers.
 * @param request - trusted host identity or raw HTTP Authorization input.
 * @returns one deeply immutable normalized identity.
 */
async resolve(request: ResolveIdentityRequest): Promise<ResolvedIdentity>
```

Source: [`packages/identity/identity/src/index.ts`](../../packages/identity/identity/src/index.ts)
<!-- END GENERATED cordis-surface -->
