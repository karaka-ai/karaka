# 运行时身份

[English](identity.md) | 中文

运行时身份子系统证明外部凭据，但不决定应用 authority。它的首项完整能力包含三种角色：[dsh-identity](../../packages/identity/identity/README.zh.md) 定义 `ctx.identity`，[dsh-identity-jwks](../../packages/identity/identity-jwks/README.zh.md) 通过远程 JWKS 验证已签名 JWT，[dsh-identity-http-bearer](../../packages/identity/identity-http-bearer/README.zh.md) 则把 HTTP Authorization 标头适配为提供方无关的请求。

## 边界

`VerifyIdentityRequest` 携带不透明 bearer 凭据与可选取消。`VerifiedIdentity` 包含可信的签发方本地主体、受众、签发与过期时间、可选生效时间与 token id，以及深度不可变的已验证 claim 集。`HttpBearerIdentityRequest` 携带常见 HTTP 运行时暴露的原始 Authorization 值形态。

这些类型不包含租户 id、应用用户 id、角色、权限或资源决策。后续 authority 规范化与资源授权能力通过各自的 Service Definition 与提供方消费已验证身份。

## 故障约定

`IdentityError.code` 区分缺少、畸形、不受支持和无效凭据，以及提供方不可用与取消。消息可安全用于传输层映射，并且绝不包含原始凭据或底层提供方错误。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
