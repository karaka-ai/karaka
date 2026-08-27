# Agent Note: 将运行时身份角色合并到一个插件包

Status: implemented

[English](2026-08-27-single-package-runtime-identity.md) | 中文

## 问题

SaaS 宿主需要一个小型身份入口来支持两种当前部署形态：可信服务器代码在同一进程中调用 Karaka，以及 HTTP worker 接收不可信 Bearer 凭据。把首个实现拆成 definition、JWKS provider 和 HTTP consumer 三个包，会让运维方组合多个配置行，也会让维护者在第二个 provider 或 consumer 出现之前承担三份 manifest、invariant companion、文档集和包关系图。此拆分也无法在不新增 provider 包的情况下表示嵌入式身份。

身份仍必须阻止浏览器控制的 id 进入可信路径，集中执行严格的 Authorization 解析，依赖维护中的 JOSE 验证，返回分离且不可变的值，并且止步于角色、权限、资源所有权或 session 访问之前。

## 决定

`@deepseek-ai/dsh-identity` 是一个具体 Cordis 插件包，它在 `ctx.identity.resolve(request)` 后合并 Service Definition、当前 provider 与当前 consumer。它是唯一的身份 Loader 配置行，并默认导出具体的 `Identity` 服务。

`ResolveIdentityRequest` 是可辨识联合类型。`trusted` 形式接受类型化同进程宿主代码提供的包自有 branded `userId` 与可选 `tenantId`；服务把这些值复制到新的冻结结果中，不为该类型化边界增加敌对输入校验。`http-bearer` 形式接受原始 Authorization 值与可选取消，只允许一个 Bearer 凭据，并通过同一个服务完成验证。

可选的嵌套 `jwt` 配置启用 HTTP 路径。它要求显式指定签发方、受众、远程 JWKS URL 和算法 allowlist；公开请求超时、刷新冷却、缓存时长、时钟容差和额外必需 claim；并且可以命名一个 tenant-id claim。JWT `sub` 成为 branded `userId`。配置的 tenant claim 必须是非空字符串并成为 branded `tenantId`。输出的来源判别字段区分可信身份与 HTTP 身份；HTTP 结果还保留经过分离和深度冻结的已验证 JWT 事实与 claim。

插件允许 HTTPS endpoint 与用于本地开发的 loopback HTTP，在加载时拒绝 URL 凭据和片段，使用 `jose` 完成密钥选择、签名与注册 claim 验证，并把远程密钥缓存限制在进程内。调用方取消会立即以 `IDENTITY_VERIFICATION_ABORTED` 结算，但不会中止进行中的共享密钥获取；该获取仍受观察，并可为其他调用方填充缓存。未配置 `jwt` 时的 HTTP 解析以安全稳定的 `IDENTITY_VERIFICATION_UNAVAILABLE` 代码失败。缺失、畸形、不受支持、无效、不可用和已取消情况继续使用安全稳定的 `IdentityError` 代码，不包含原始凭据或 provider 错误。

Tenant 规范化只证明哪个签名或可信 tenant id 进入了运行。资源授权仍是独立能力，它决定该用户能否访问 session、run、tool 或应用对象。

## 测试

聚焦包测试覆盖可信宿主规范化与卸载、稳定安全错误、严格 Authorization 解析、缺少 JWT 配置的行为、真实 RSA 签名与 loopback JWKS 获取、签发方／受众／过期／必需 claim／算法／签名拒绝、可选 tenant 映射、时钟容差、缓存复用、provider 不可用分类、claim 深度不可变、工作前取消、共享获取被闸门阻塞时的取消，以及加载时配置拒绝。真实 Loader 测试挂载一个 `@deepseek-ai/dsh-identity` 配置行，并通过组装后的服务解析可信输入与签名 HTTP 输入。

## 考虑过的替代方案

- **保留独立的 definition、JWKS provider 和 HTTP consumer 包**：这在理论上保留独立替换能力，但当前没有第二个实现或独立演进的 consumer。包成本与多配置行的 founder 集成是即时成本，而真正出现替换需求时仍可直接抽取。
- **只支持可信嵌入式身份**：这会最小化嵌入路径，但让独立部署的 worker 缺少安全凭据入口，并会让未来 transport 重复 Bearer/JWT 行为。
- **从身份返回角色、权限或资源 authority**：拒绝，因为可信或签名的 user/tenant id 并非授权决定。应用策略与资源所有权会独立于凭据证明而变化。
- **让每个 REST 或 SSE transport 解析并验证 JWT**：拒绝，因为 transport 会重复安全敏感行为、选择具体加密策略，并变得更难与路由逻辑分开测试。
- **自行实现 JWT/JWKS 验证**：拒绝，因为维护中的 JOSE 代码已负责算法验证、JWS 验证、注册 claim 验证、密钥选择、刷新冷却、缓存和请求超时行为。
- **保留抽象服务包并增加嵌入式 provider**：在第二个 provider 具有独立生命周期或依赖集合前拒绝。一个具体包仍包含能力的全部三个角色，以后可以在不更改 `ctx.identity.resolve` 的情况下抽取 provider。

## 后果

嵌入式宿主挂载一个不带 JWT 配置的配置行，只解析 branded 应用 id。HTTP worker 增加一个嵌套配置块并调用相同方法，因此 transport 不会获得身份业务逻辑。两条路径汇聚为同一种不可变 user/tenant 结果与同一组稳定失败。

每次安装都包含 `jose` 依赖，即使只使用可信路径；但未配置 `jwt` 时不会创建远程 JWKS 对象，也不会执行网络工作。一个插件 scope 支持一个配置的 JWT 签发方和一个进程内密钥缓存。未来具有独立依赖或生命周期的 provider 可以证明再次抽取角色为独立包的必要性，同时保留公共服务方法和结果类型。
