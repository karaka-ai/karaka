# @deepseek-ai/dsh-identity

[English](README.md) | 中文

这是经过验证的运行时身份所使用的提供方无关 Service Definition。`Identity` 注册 `ctx.identity`；Service Provider 验证不透明凭据，并返回深度不可变的 `VerifiedIdentity`。结果包含可信的签发方、主体、受众、NumericDate、可选 token id 和 claim 数据。它刻意不包含租户成员关系、应用角色、权限或授权决策。

## 服务 API

| API | 约定 |
|---|---|
| `ctx.identity.verify(request)` | 验证一个不透明 bearer 凭据并返回可信身份 claim。可选 `AbortSignal` 用于请求协作式取消。 |
| `VerifiedIdentity` | 不可变的签发方本地主体身份与已验证 JSON claim 集。`issuer`、`subject`、受众和 token id 使用本包拥有的 branded string 类型。 |
| `IdentityError` | 安全错误，包含稳定的 `IDENTITY_*` 路由代码，但不包含原始凭据或提供方细节。 |

Service Definition 拥有请求、结果和错误类型。提供方与消费方只依赖本包，彼此不形成依赖。authority 规范化与资源授权是独立的能力 seam，因为它们回答不同问题：本服务只证明凭据由谁签发、它指向哪个主体，不决定该主体可以执行什么操作。

## 组合

不要把抽象 Service Definition 作为独立配置行挂载。应组合一个提供方，以及需要它的消费方：

```yaml
- name: '@deepseek-ai/dsh-identity-jwks'
  config:
    issuer: 'https://issuer.example'
    audience: 'karaka-api'
    jwksUrl: 'https://issuer.example/.well-known/jwks.json'
    algorithms: ['RS256']
- name: '@deepseek-ai/dsh-identity-http-bearer'
```

## 模型体验

### 已验证运行时身份

#### 模型看到的内容

无。`ctx.identity` 始终是模型不可见的运行时上下文，本包不会添加提示词、工具、消息或请求正文内容。

#### Token 影响

零 token。

#### KV Cache 影响

无；身份验证不会改变模型可见前缀。

## 已知限制与暂缓工作

- **仅支持 bearer 凭据**：首个请求联合类型只包含 `kind: 'bearer'`；增加其他凭据家族时必须显式扩展约定。
- **不执行 authority 映射**：租户、用户、角色和应用策略规范化属于后续的 Service Definition 与提供方。
- **不作授权决策**：消费方执行受保护操作前，必须调用独立的资源授权能力。
