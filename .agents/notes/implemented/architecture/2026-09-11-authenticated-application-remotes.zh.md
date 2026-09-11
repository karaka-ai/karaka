# Agent Note: 在现有 Remote 连接上认证应用用户

Status: implemented

[English](2026-09-11-authenticated-application-remotes.md) | 中文

## 问题

Host 浏览器 cookie 授予进程级权限。应用浏览器需要更窄的持久聊天和人工交互所有权，包括两个用户同时连接，或切换账户后复用浏览器的情况。调用者提供的租户和用户字段不能确立这种权限。

## 决策

Connection 接受现有 Host 认证模式或应用凭证提供方。随附 browser-auth 提供方依据配置的公开密钥、签发者、受众、应用 id 和有效期验证短期签名 JWT。已验证的应用、租户和用户作为一个调用者共同传递；只有应用后端签发凭证。Karaka 不包含应用登录逻辑。

Gateway 通过独立 Cordis context 将调用者绑定到每次调用，并通过现有 Remotes 组装选择方法和事件接收者。浏览器聊天方法获取 owner 并委托给现有 application controller。审批响应必须指定一个已投递给活跃客户端 generation 的待处理事件，且该 generation 归已认证调用者所有。重连重新执行认证，并按新调用者过滤待处理交互。过期或访问策略撤销会中止活跃应用流。

Agent 包发布独立浏览器 ESM 入口和可重定位声明。它组装 Connection、Gateway 和生成的 Typert remote，不增加浏览器运行时插件。HTTP transport 可以禁用其问题 handler，同时保留后端路由，使每次人工交互由一个配置的 handler 负责。

[Host cookie 决策](2026-08-24-browser-token-authentication.zh.md)、[Remote 事件投递决策](2026-08-10-remote-event-delivery.zh.md) 和 [Karaka 分发决策](2026-09-02-karaka-agent-runtime-package.zh.md) 继续生效：其 Host 权限、待处理事件生命周期和公开包身份规则仍然适用。应用认证为这些机制增加独立权限模式。

## 考虑过的替代方案

**独立浏览器通信系统。** 另一个 gateway 会重复类型化调用、流、重连状态和待处理交互投递。扩展现有调用者路径使所有权约束与共享分发和响应处理保持在一起。

**信任浏览器提供的 owner，或复用 Host 凭证。** 前者允许用户冒充其他 owner；后者授予进程级管理权限。签名应用身份加显式能力在复用持久 controller 检查的同时限制访问。

**将服务器 bundle 导入前端。** 服务器构建包含 Node 服务和插件加载器。独立 ESM 产物保留现有客户端实现，同时排除这些运行时依赖。

## 影响

真实 Karaka 组装测试使用两个签名调用者、实际审批与问题服务、工具执行、agent loop 和 SQLite。测试验证跨聊天拒绝、伪造审批拒绝、重连后的 owner 变更、待处理重放和过期凭证。打包消费者检查在没有隐式 Node 类型的情况下编译浏览器 API。

待处理交互仍然局限于单个进程，重连必须路由到同一个 Karaka 进程。凭证具有绝对过期时间；没有逐令牌撤销列表。TLS、凭证签发和前端凭证续期仍由应用部署负责。现有 socket 在过期前保留已验证调用者；后续请求使用当前挂载的验证器。
