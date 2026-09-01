# Karaka 最小运行时

[English](karaka-minimum-changes-draft.md) | 中文

## 需求

应用后端使用一个 SDK 调用具名 Karaka Agent，并把显式业务函数暴露为带认证的 MCP 工具。Karaka 作为独立的持久 DSH 进程运行，从目录加载 Agent Preset，在每个聊天上保留租户和用户 owner，并复用现有 ReactLoopAgent、模型、工具、Session、持久化与 Cordis 生命周期。

## 进程拆分

- 应用进程拥有 `@karaka/sdk`、业务函数、现有 Node HTTP 服务器，以及可信租户/用户身份。
- Karaka 进程拥有 `@karaka/cli`、`@karaka/harness`、Agent Preset、模型、Session，以及远程工具发现与调用。
- 两个进程分别认证两个方向：应用到 Karaka 的聊天，以及 Karaka 到应用的工具调用。

## Agent 定义

每个 `agents/<id>` 目录都是现有 DSH Agent Preset。`preset.yml` 携带发现元数据。`agent.cordis.yml` 用普通 Cordis 插件条目表达行为，包括 persona、选中的 MCP 工具、skill、subagent 和用户编写的插件。Karaka 为每个检测到的组合世代挂载一棵常驻插件树。加入同一世代的聊天共享其插件实例，但各自获得自己的 Agent scope 与持久 Session；组合发生变化时会启动新世代，而仍加入旧世代的聊天不会受到干扰。新聊天采用部署的默认模型选择；`chats.setModel()` 从该聊天的下一次请求起生效，并继续作为该聊天的选择，而不会更改部署默认值或其他聊天。

## 包变更

| 变更 | 所有权 |
|---|---|
| 新 `@karaka/sdk` library | 后端聊天客户端、显式 MCP 工具 registry、Express 与 Next.js Pages handler |
| 新 `@karaka/server-auth` 插件 | 可替换的入站与出站应用服务器认证 |
| 新 `@karaka/transport-http` 插件 | 复用现有 Host Web 服务器的带认证 JSON/SSE 路由 |
| 新 `@karaka/harness` bundle | 基于 `dsh-base` 的持久安全组合 |
| 新 `@karaka/cli` | 通过现有 `dsh` binary 创建工作区并启动 |
| 现有 Session 包 | 原子持久 `{ applicationId, tenantId, userId }` owner |
| 现有 JSONL 与 SQLite provider | 在当前 SQLite schema 中持久化 owner |
| 现有 Session Controller | 无 Workspace 应用聊天生命周期、owner 检查、去重、冷恢复与空闲回收 |
| 现有 Agent 与 subagent 包 | owner 接收与继承 |
| 现有 Agent Tool Presentation | 每个 preset 的继承 MCP 工具 allow/deny 选择 |
| 新 `@karaka/mcp-application` 插件 | 用出站认证、owner metadata 和逐 Agent 选择专门化现有 MCP 客户端 |
| 新 `@karaka/sdk` protocol 与类型 | 共享的运行时验证应用 JSON/SSE contract |
| 现有 App Boot | `karaka` profile 模板 |

不会引入第二套 Agent loop、Session 实现、MCP 客户端、工具 registry、Loader、Web 服务器或进程管理器。

## 请求流程

1. 后端向 Karaka 认证，并为可信租户和用户选择一个 Agent id。
2. HTTP transport 从凭据派生应用 id，并把 owner 交给 Session Controller。
3. Session Controller 从所选 preset 创建或恢复 Session 与作用域 Agent。
4. ReactLoopAgent 通过现有 DSH registry 运行模型步骤，并且只运行该 Agent Preset 显式允许的应用工具。
5. 远程工具调用使用已配置 MCP endpoint、新解析的出站凭据和可信 owner metadata。
6. SQLite 持久化 Session log 与 owner；SSE 把稳定应用事件投影回 SDK。

## 明确限制

首版运行时使用一个 Node 进程、用于聊天的 HTTP JSON/SSE、用于工具的 Streamable HTTP MCP、共享 bearer 服务器认证和 SQLite 持久化。部署负责 TLS、监控、replica 路由与 secret。分布式聊天 lease、跨进程结构化问题恢复、entitlement、observability、Fetch 原生工具 handler 与其他 transport 不属于此最小范围。
