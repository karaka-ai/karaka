# Agent Note: 将 JWT 身份验证拆分为三角色能力

Status: implemented

[English](2026-08-26-jwt-identity-capability-seam.md) | 中文

## 问题

SaaS 传输层需要把外部凭据转换为可信运行时身份，同时不能把 harness 绑定到某个身份提供方、HTTP framework、租户模型或应用授权策略。如果把验证、authority 规范化与资源授权合并为一个服务，更换密码学提供方时就会连带应用专属策略。如果把 bearer 解析或 JWT 验证直接写入 REST/SSE handler，则会复制安全敏感行为，并使传输层不断积累业务逻辑。

## 决策

JWT 身份验证是位于 `packages/identity/` 下的一项完整三角色能力：

- `@deepseek-ai/dsh-identity` 拥有提供方无关的 Service Definition、`ctx.identity`、凭据请求、不可变 `VerifiedIdentity`、branded 的签发方／主体／受众／token 标识符，以及稳定且安全的 `IdentityError` 代码。
- `@deepseek-ai/dsh-identity-jwks` 是首个 Service Provider。它使用 `jose`，按照显式配置的签发方、受众、远程 JWKS URL 与算法 allowlist 验证已签名 JWT。它要求 `sub`、`iat` 和 `exp`，区分无效凭据与提供方不可用，并在返回前分离并冻结 claim。
- `@deepseek-ai/dsh-identity-http-bearer` 是首个消费方。它注册 `ctx.identityHttpBearer`，接受 HTTP 运行时使用的原始 Authorization 标头形态，只允许一个 Bearer 凭据，并且只通过 `ctx.identity` 委托验证。

抽象 Service Definition 是共享依赖，而不是独立 Loader 配置行。组合配置挂载一个提供方与任意消费方。JWKS 提供方与 HTTP 消费方彼此不形成依赖。

已验证身份止于密码学上可信的签发方本地事实。它不包含 Karaka 租户 id、应用用户 id、角色、权限或资源决策。authority 规范化与资源授权仍是后续独立的能力 seam，其提供方可以消费 `VerifiedIdentity`。

JWKS 提供方允许 HTTPS endpoint，以及用于本地开发的 loopback HTTP。它拒绝 URL 凭据和片段，把请求与 cache 时序暴露为配置，依赖 `jose` 执行 key 选择、签名验证与注册 claim 验证，并且绝不把原始提供方错误或凭据附加到公开故障中。

## 测试

包级测试固定 Service 生命周期释放、稳定且安全的错误、严格 Authorization 解析、提供方委托、配置约束、真实 RSA 签名与 loopback JWKS 获取、签发方／受众／过期时间／必需 claim／算法／签名拒绝、提供方不可用分类、claim 不可变性，以及执行前取消。真实 Loader 测试从测试专用 `cordis.yml` 启动提供方与消费方配置行，并通过组装后的 seam 验证已签名凭据。

## 考虑过的替代方案

- **用一个包承载约定、JWKS 验证、bearer 解析与未来 authority 映射**：不予采用，因为替换身份提供方或 HTTP 适配器时会被迫修改无关角色，而且应用 authority 策略会泄漏进通用密码学边界。
- **让 `ctx.identity` 返回规范化 Karaka authority**：不予采用，因为已验证主体尚不等于租户成员关系或授权授予。同一个签发方身份在不同 SaaS 应用与部署中可以采用不同映射。
- **在每个 REST/SSE 插件内解析并验证凭据**：不予采用，因为传输层会复制安全敏感行为、选择具体提供方，并且难以脱离路由逻辑进行独立测试。
- **手写 JWT/JWKS 验证**：不予采用，因为持续维护的 JOSE 代码已经负责算法验证、JWS 验证、claim 验证、key 选择、刷新 cooldown、cache 与请求超时行为。
- **把抽象 Service Definition 作为第三个 Loader 配置行挂载**：不予采用，因为提供方子类才是具体的 `ctx.identity` 注册。额外的抽象配置行没有行为，还会制造相互竞争的服务所有方。

## 结果

传输层获得一个狭窄且可替换的可信身份入口，而密码学、HTTP 提取、authority 规范化与授权仍是可以独立替换的插件。该拆分增加了 3 份包 manifest、文档集、不变式伴生插件与跨包组合测试。初始请求词汇只允许 bearer 凭据，初始提供方在每个 Cordis scope 中只支持一个已配置签发方，远程 key cache 也只存在于进程内；后续凭据类型与提供方可以扩展或替换该 seam，而无需在这些包中增加应用分支。
