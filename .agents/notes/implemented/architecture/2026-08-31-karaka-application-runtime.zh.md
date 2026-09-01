# Agent Note: Karaka 应用运行时复用作用域化 Harness

Status: implemented

[English](2026-08-31-karaka-application-runtime.md) | 中文

## 问题

应用后端需要提供长期运行的具名 Agent，同时不嵌入 Harness、不复制 Agent loop，也不把业务代码导入 Agent 进程。多个租户和用户可能同时使用同一 Agent 定义。业务工具保留在应用进程中，而聊天 owner 必须在重启后保留，并且每次跨进程调用都必须认证发起调用的服务器。

## 决策

Karaka 作为额外的持久 DSH profile 交付。[`@karaka/harness`](../../../../packages/karaka/harness/README.zh.md) 组合现有 Loader、workspace registry、[Agent Presets](2026-08-03-per-session-agent-presets.zh.md)、ReactLoopAgent、工具 registry、模型 adapter、Session log 与 SQLite provider。[`@karaka/cli`](../../../../packages/karaka/cli/README.zh.md) 创建部署 patch 和 Agent Preset 目录、准备项目本地的 profile home、让已安装的 Harness bundle 可从该 profile 解析，然后启动现有 `dsh` binary。它不实现另一套运行时或进程管理器。

应用后端安装独立的 [`@karaka/sdk`](../../../../packages/karaka/sdk/README.zh.md)。其聊天客户端通过带认证 JSON 与 SSE 调用持久进程。其工具主机把显式注册的应用 callback 暴露为后端已有 Node HTTP 服务器上的无状态 Streamable HTTP MCP 工具；SDK 不监听端口，也不启动 Karaka 进程。

一个 Agent 定义就是一个现有 Agent Preset 目录。`preset.yml` 拥有发现元数据，`agent.cordis.yml` 拥有行为插件组合。每个聊天在该 preset 的 scope 中创建或恢复不同的 Agent 与持久 Session。每个检测到的组合世代都会挂载一棵常驻插件树，因此加入同一世代的聊天会共享其插件实例。组合发生变化时会启动新世代，已加入的聊天则保留旧世代。需要保持聊天隔离的可变状态必须放在 Agent 或 Session 上，或由插件按其标识进行分区。

每个应用聊天 Session 都在持久 header 中拥有一个原子 `{ applicationId, tenantId, userId }` owner。已认证服务器提供可信租户与用户值；入站凭据决定 `applicationId`。Session Controller 为每次操作检查同一 owner，并只在需要时保留活动 Agent。应用 streaming 直接读取 Session log，因此没有 cwd 的聊天不依赖按 workspace 过滤的浏览历史服务。subagent 继承该 owner。

[`@karaka/server-auth`](../../../../packages/karaka/server-auth/README.zh.md) 是两个方向共用的可替换 Cordis 认证约定。其内置 bearer provider 在每次操作时分别解析聊天和工具凭据引用。[`@karaka/mcp-application`](../../../../packages/karaka/mcp-application/README.zh.md) 用该 service、本地参数验证、Agent Preset 选择与执行中 Session 的 owner metadata 来专门化现有 [MCP 客户端](../../../../packages/mcp/mcp-client/README.zh.md)。任意 MCP 和 stdio endpoint 保持通用行为。本决策扩展但不取代 [MCP 客户端决策](../feature/2026-07-07-mcp-client-plugin.zh.md)。

## 考虑过的替代方案

**把 Harness 嵌入每个应用后端。** 这会把应用请求 worker 与模型轮次生命周期耦合，在多个服务中复制 Agent 进程，并阻止一个持久 Agent 部署服务多个后端。

**创建 Karaka 专用 Agent Runtime 与 Agent 定义 schema。** 这会复制 ReactLoopAgent、作用域 registry、Session 持久性、Agent Preset 和 Cordis dispose。现有 preset 目录已经能同时表达发现元数据与插件行为。

**把业务函数导入 Karaka 进程。** 这会让 Agent 部署携带应用代码与凭据。带认证 MCP 保留应用对执行的所有权，并保持动态工具发现。

**复用本地 DSH SDK JSON-RPC 生命周期。** 该协议拥有一个子 Harness 进程和本地字节流。Karaka 需要独立于调用方的持久服务器、稳定应用 owner 和可重连 HTTP streaming。

## 后果

Karaka 添加一个小型应用边界，同时保留上游 DSH 行为和插件组合。工具与聊天 transport 需要协调客户端和服务器实现，但共享运行时验证的 wire 类型。SQLite 持久化聊天 owner 与事件；待回答结构化问题仍是进程本地状态。一个进程内会串行化每个聊天，而 TLS、副本数、跨副本路由和监督仍由部署负责。除非显式可信组合启用，否则 Karaka bundle 禁用本地文件系统与子进程工具。
