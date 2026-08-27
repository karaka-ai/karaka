# @deepseek-ai/dsh-identity

[English](README.md) | 中文

供可信同进程宿主调用和 HTTP Bearer JWT 使用的具体运行时身份插件。单个包注册 `ctx.identity`，把两种输入规范化为深度不可变的 `ResolvedIdentity`；配置 JWT 后，它还在包内提供严格的 Authorization 解析与由维护中的 `jose` 实现的远程 JWKS 验证。

## 服务 API

| API | 约定 |
|---|---|
| `ctx.identity.resolve({ kind: 'trusted', userId, tenantId? })` | 接受类型化可信宿主代码提供的应用自有 branded id，将其分离到新的冻结结果中，并且不执行敌对输入校验。 |
| `ctx.identity.resolve({ kind: 'http-bearer', authorization, signal? })` | 只解析一个 Bearer 值，并通过配置的签发方、受众、算法与远程 JWKS 验证 JWT；取消会结算当前调用方，但共享密钥获取可继续为进程内缓存工作。 |
| `ResolvedIdentity` | 不可变的可辨识结果，包含 `source`、branded `userId`、可选 branded `tenantId`；只有 HTTP 结果还包含已验证的 JWT 事实。 |
| `IdentityError` | 安全错误，包含稳定的 `IDENTITY_*` 路由代码，但不包含原始凭据或提供方细节。 |

可信宿主代码在解析前为应用自有 id 加上 brand：

```ts
const identity = await ctx.identity.resolve({
  kind: 'trusted',
  userId: IdentityUserId(session.user.id),
  tenantId: IdentityTenantId(activeWorkspace.id),
})
```

可信路径不需要 JWT 设置。它只适用于调用方与 Karaka 共享同一个可信服务器进程的情况；绝不能通过此路径转发浏览器提供的 id。

## JWT 配置

可选的 `jwt` 块启用 HTTP Bearer 解析：

```yaml
- name: '@deepseek-ai/dsh-identity'
  config:
    jwt:
      issuer: 'https://issuer.example'
      audience: 'karaka-api'
      jwksUrl: 'https://issuer.example/.well-known/jwks.json'
      algorithms: ['RS256']
      tenantIdClaim: 'tenant_id'
      timeoutMs: 5000
      cooldownMs: 30000
      cacheMaxAgeMs: 600000
      clockToleranceSeconds: 0
      additionalRequiredClaims: []
```

`issuer`、`audience`、`jwksUrl` 和 `algorithms` 在 `jwt` 内必填。除本地开发的 loopback HTTP 外必须使用 HTTPS；包含凭据或片段的 URL 会在插件加载时失败。请求、刷新冷却、缓存时长和时钟容差策略仍是部署配置，默认值如上所示。

JWT `sub` 会成为 `userId`。配置 `tenantIdClaim` 后，该 claim 变为必需项，且必须是非空字符串，随后成为 `tenantId`。经过验证的 tenant claim 是签名身份输入，并非资源授权决定；受保护服务仍必须单独执行所有权和权限检查。

未配置 `jwt` 时解析 HTTP Bearer 会以 `IDENTITY_VERIFICATION_UNAVAILABLE` 失败。无效签名或 claim 以 `IDENTITY_CREDENTIAL_INVALID` 失败；远程密钥获取失败、畸形密钥数据和超时以 `IDENTITY_VERIFICATION_UNAVAILABLE` 失败；调用方取消会立即以 `IDENTITY_VERIFICATION_ABORTED` 失败，而进行中的共享密钥获取仍可完成并填充进程内缓存。

## 模型体验

### 规范化运行时身份

#### 模型看到的内容

无。`ctx.identity` 始终是模型不可见的运行时上下文，本包不会添加提示词、工具、消息或请求正文内容。

#### Token 影响

零 token。

#### KV Cache 影响

无；身份解析不会改变模型可见前缀。

## 已知限制与暂缓工作

- **每个插件 scope 一个 JWT 签发方**：服务多个签发方的部署需要挂载隔离的插件实例，或在第二个实现证明需要后再添加提供方 seam。
- **进程内 JWKS 缓存**：配置或密钥获取策略变更需要重新加载插件，不同 worker 实例不会共享已获取的密钥。
- **不作授权决策**：角色、权限、资源所有权和 session guard 属于独立插件。
