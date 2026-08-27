# 运行时身份

[English](identity.md) | 中文

运行时身份子系统规范化可信同进程宿主 id，并证明 HTTP Bearer JWT，但不作资源授权决定。[`dsh-identity`](../../packages/identity/identity/README.zh.md) 在一个具体的 `ctx.identity` 服务后合并 definition、严格 Authorization consumer 和维护中的远程 JWKS provider。

## 边界

`ResolveIdentityRequest` 选择可信宿主输入或原始 HTTP Authorization 输入。两种输入都返回深度不可变的 `ResolvedIdentity`，其中包含 branded 应用 `userId`、可选 branded `tenantId` 和来源判别字段；HTTP 结果还包含已验证的签发方、受众、NumericDate 字段、可选 token id 与分离的 claim 集。

可信输入只接受由类型化宿主代码建立的 branded id。HTTP 输入把 JWT `sub` 映射为 `userId`，并把显式配置的非空字符串 claim 映射为 `tenantId`；两条路径都不授予角色、权限、资源所有权或 session 访问权。

## 故障约定

`IdentityError.code` 区分缺少、畸形、不受支持和无效凭据，以及提供方不可用与取消。未配置 JWT 时的 HTTP 解析属于不可用。消息可安全用于传输层映射，并且绝不包含原始凭据或底层提供方错误。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
