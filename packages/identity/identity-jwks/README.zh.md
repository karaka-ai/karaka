# @deepseek-ai/dsh-identity-jwks

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-identity`](../identity/README.zh.md) 的远程 JWKS JWT Service Provider。`JwksIdentity` 注册 `ctx.identity`，通过 `jose` 验证紧凑格式的已签名 JWT，并返回 Service Definition 定义的不可变 `VerifiedIdentity`。它绝不把 claim 映射为 Karaka 租户、用户、角色或权限。

## 配置

| 字段 | 约定 |
|---|---|
| `issuer` | 必填；精确匹配的可信签发方。 |
| `audience` | 必填；一个可接受的受众字符串或非空数组。 |
| `jwksUrl` | 必填；JWKS endpoint。除本地开发使用的 loopback HTTP 外，必须采用 HTTPS。系统拒绝 URL 凭据和片段。 |
| `algorithms` | 必填；非空的签名算法 allowlist。系统不会隐式回退到其他算法。 |
| `timeoutMs` | JWKS 请求截止时间；默认为 `5000`。 |
| `cooldownMs` | 两次成功刷新之间的最短间隔；默认为 `30000`。 |
| `cacheMaxAgeMs` | 成功获取的 key set 的最长有效时间；默认为 `600000`。 |
| `clockToleranceSeconds` | NumericDate 可接受的时钟偏差；默认为 `0`。 |
| `additionalRequiredClaims` | 除始终必需的 `sub`、`iat` 和 `exp` 外，额外要求存在的 claim 名称。 |

系统要求 `iss` 与 `aud` 同时存在，并按照配置验证。格式、签名、算法、注册 claim 或 key 选择无效时抛出 `IDENTITY_CREDENTIAL_INVALID`。网络、超时、HTTP 或畸形 JWKS 故障抛出 `IDENTITY_VERIFICATION_UNAVAILABLE`。公开错误既不包含 token，也不包含底层提供方细节。

`jose` 按照配置的 cooldown 与最长有效时间缓存和刷新远程 key。通过验证的 claim 数据在跨越提供方边界前会先分离并深度冻结。

## 模型体验

### JWT 验证

#### 模型看到的内容

无。`jose` 的 JWKS 获取与 JWT 验证始终是模型不可见的运行时工作，不会添加模型可见内容。

#### Token 影响

零 token。

#### KV Cache 影响

无；提供方选择与验证不会改变模型可见前缀。

## 已知限制与暂缓工作

- **单个已配置签发方**：另一个签发方应在隔离的 Cordis scope 中使用另一个提供方实例。
- **仅支持远程 JWKS**：静态 key、discovery document 与硬件支持的验证提供方应作为同一 Service Definition 的独立实现。
- **协作式请求取消**：请求如果已经取消，会立即拒绝；如果验证完成后才取消，则在返回前拒绝。共享的远程 key 获取使用提供方配置的超时。
- **不持久化 key cache**：key 状态只存在于进程内，重启后会重新获取。
