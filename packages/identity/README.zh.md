# identity/ — 运行时身份

[English](README.md) | 中文

运行时身份能力家族，以及既有的匿名关联 id。已验证身份、应用 authority 规范化与资源授权始终是相互独立的 seam。

| 包 | 职责 | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.zh.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |
| [`identity/`](identity/README.zh.md) | 提供方无关的已验证身份 Service Definition | `ctx.identity` |
| [`identity-jwks/`](identity-jwks/README.zh.md) | 远程 JWKS JWT Service Provider | 注册 `ctx.identity` |
| [`identity-http-bearer/`](identity-http-bearer/README.zh.md) | HTTP Authorization Bearer 消费方 | `ctx.identityHttpBearer` |

只有 Service Definition、Service Provider 与消费方三种角色共同存在时，三角色身份能力才算完整。组合配置挂载提供方与消费方配置行；抽象 Service Definition 提供二者共享的约定，不单独挂载。
