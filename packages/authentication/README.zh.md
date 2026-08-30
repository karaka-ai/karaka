# @karaka/authentication

[English](README.md) | 中文

Karaka 认证服务器，而不是最终用户。应用后端负责认证自己的用户；Karaka 验证该后端后，接受它提供的可信 `tenantId` 和 `userId` 上下文。

该包导出：

- `AuthenticationService`：与提供方无关的 Cordis 契约；
- `@karaka/authentication/oauth-client-credentials`：默认的 OAuth 2.0 Client Credentials 提供方。

```yaml
- name: '@karaka/authentication/oauth-client-credentials'
  config:
    issuer: https://identity.example.com/
    audience: https://karaka.internal
    tokenEndpoint: https://identity.example.com/oauth/token
    jwksUri: https://identity.example.com/.well-known/jwks.json
    clientId: application-backend
    clientSecretEnv: KARAKA_OAUTH_CLIENT_SECRET
```

若要通过 `private_key_jwt` 认证 OAuth 客户端，请使用 `privateKeyPath` 代替 `clientSecretEnv`。密钥应放在环境变量或挂载的密钥文件中，而不是直接写入 setup YAML。

## 提供方契约

其他认证插件注册一个实现：

```ts
interface AuthenticationProvider {
  name: string
  authenticate(request: Request): Promise<AuthenticatedServer>
  request(target: { audience: string }, request: Request, dispatch: AuthenticationDispatch): Promise<Response>
}
```

`authenticate()` 验证传入请求的服务器；`request()` 发出经过认证的传出请求。因此，提供方可以使用 OAuth、mTLS、请求签名或其他机制，而无需修改 Transport 或 MCP。OAuth 插件会用一条普通 setup 配置同时挂载契约和提供方。一个 Cordis 图中只激活一个提供方，其注册会随插件卸载而移除。

Transport 会在整个聊天调用期间绑定应用提供的可信用户上下文。MCP 会认证 `tools/list` 和 `tools/call`；工具调用还会在同一条已认证通道上传递已经绑定的用户上下文。用户上下文不是第二份凭据。
