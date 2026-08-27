# 认证

[English](README.md) | 中文

`@karaka/authentication` 是 Karaka 的认证接缝。包根路径提供与提供方无关的 `ctx.authentication` 服务、租户路由器和身份契约。两个内置插件子路径通过不同的信任模型建立身份：

- `@karaka/authentication/authentication-jwks` 通过已配置的租户 JWKS 端点验证 bearer token。
- `@karaka/authentication/authentication-host` 接受可信嵌入应用给出的身份断言。

认证只负责建立身份，不负责授权、权益或会话决策。

## 可信宿主开发模式

对于本地开发，以及宿主已经完成调用方认证的嵌入式应用，host 插件是最短路径：

```yaml
- name: '@karaka/authentication/authentication-host'
  config:
    tenantId: local
    subject: developer
    claims:
      role: developer
```

该插件会提供 `ctx.identity`，并将 `provider` 固定为 `'host'`。这些配置是信任断言，不是 Karaka 自行验证的证据。它只能来自可信部署配置或可信宿主代码；绝不能直接取自模型输出、请求参数或其他不可信输入。

静态 YAML 形式适用于单一本地身份。共享进程的宿主必须为每个请求、会话或任务隔离 `identity`，并在该上下文内挂载 host 插件：

```ts
import AuthenticationHost from '@karaka/authentication/authentication-host'

const caller = ctx.isolate('identity')
await caller.plugin(AuthenticationHost, {
  tenantId: hostPrincipal.tenantId,
  subject: hostPrincipal.subject,
  claims: hostPrincipal.claims,
})

await caller.plugin(applicationWorkflows)
```

根上下文不会获得调用方身份。释放隔离的 host 插件会删除该身份，并停止注入它的消费者，同时不影响其他调用方的身份作用域。

## 通过 YAML 验证令牌

两个配置项都是普通 Cordis 插件。包根路径拥有注册表，JWKS 子路径贡献验证器：

```yaml
- name: '@karaka/authentication'
- name: '@karaka/authentication/authentication-jwks'
  config:
    name: customer-jwks
    tenants:
      acme:
        issuer: https://identity.example.com/
        audience: karaka-api
        jwksUri: https://identity.example.com/.well-known/jwks.json
        algorithms: [RS256]
        tenantClaim: org_id
        tenantValue: org_acme
      beta:
        issuer: https://identity.example.com/
        audience: karaka-api
        jwksUri: https://identity.example.com/.well-known/jwks.json
        algorithms: [RS256]
        tenantClaim: org_id
        tenantValue: org_beta
```

提供方只根据调用方传入的 `tenantId` 路由。它会针对该租户配置的 JWKS URL、issuer、audience、算法白名单、过期时间、subject 和可选租户 claim 验证令牌。它绝不会从未验证的令牌中读取 JWKS URL。

当多个租户共享 issuer 和任意 audience 时，每个租户都必须配置不同的已签名租户 claim。这样可以防止一个租户的有效令牌被当作另一个租户的令牌重放。

## 验证令牌

```ts
const identity = await ctx.authentication.authenticate({
  tenantId: 'acme',
  token,
})

identity.tenantId
identity.subject
identity.provider
identity.claims
```

调用方必须从可信路由上下文中取得 `tenantId`，例如已解析的工作区或租户主机名。下游授权必须使用返回的已验证身份，而不是未验证的令牌数据。

## 添加提供方

用户插件可以实现公共 `AuthenticationProvider` 契约，并通过与内置 JWKS 插件相同的 Cordis 服务进行注册：

```ts
import type { Context } from '@karaka/cordis'
import type { AuthenticationProvider } from '@karaka/authentication'

export const name = 'company-authentication'
export const inject = ['authentication']

export function apply(ctx: Context) {
  const provider: AuthenticationProvider = {
    name: 'company',
    tenantIds: ['internal'],
    async authenticate(request) {
      return verifyCompanyToken(request)
    },
  }

  ctx.authentication.register(provider)
}
```

该注册是由贡献插件拥有的 Cordis effect。卸载该插件会移除其提供方和租户路由。
