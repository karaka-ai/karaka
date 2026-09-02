# Agent Note: Karaka 交付单个自包含 Agent runtime 包

Status: implemented

[English](2026-09-02-karaka-agent-runtime-package.md) | 中文

## 问题

Karaka 需要本仓库开发的 Cordis Agent 架构、Agent Preset、模型 adapter、工具、持久 Session、应用认证和 HTTP transport。如果部署必须把实现安装并版本管理为许多 `@deepseek-ai/dsh-*` 包，DSH 就会成为 Karaka 的公开产品标识，内部模块图也会变成由用户管理的发布图。

应用后端与 Agent 进程具有不同生命周期。后端代码需要 client 和应用工具 host，而 Agent 进程需要完整 runtime 与小型 launcher。当独立发布没有价值时，应用专用 Cordis 插件必须能够留在服务器仓库中。

## 决策

Karaka 发布三个包。`@karaka-ai/sdk` 是后端 client 和应用 MCP 工具 host。`@karaka-ai/agent` 是完整的持久 Agent 服务器。`@karaka-ai/cli` 创建项目并启动同版本 Agent executable。Karaka 不单独发布 harness、server、authentication、transport 或 MCP bridge 包。

仓库保留聚焦的内部 workspace 用于开发和测试。`@karaka-ai/agent` 构建会静态包含它使用的生产 DSH 与 Karaka 模块；这些 workspace 包是构建时输入，而不是 consumer runtime dependency。当嵌入会破坏 native 安装、singleton identity 或上游 asset 加载时，普通第三方 library 继续作为包 dependency。

Agent 拥有进程 entry、基础 Cordis 组合、Karaka overlay、runtime asset 和内置插件 registry。公开配置名称使用 `@karaka-ai/agent/*`。Loader 从内置 registry 解析这些精确名称，从声明名称的文件解析相对名称，并从 Agent 项目解析其他 bare name。因此，应用专用插件可以位于服务器仓库中并通过 `./` 或 `../` 加载；可复用插件可以保留为普通已安装 dependency。

每个内置插件名称也是公开 Node 子路径，并具有原始具名导出与默认导出。仅含约定的 Service Definition 模块使用相同的扁平 DSH 派生名称，但不成为 Loader 插件。Agent 构建通过一个共享 runtime 图输出 Loader 与公开 entry；公开 declaration facade 共用一棵私有 declaration tree，其中跨 package 引用为相对路径、加载各包自有的 declaration augmentation 且不含 DSH package 名称。构建会从 package manifest 定位 workspace declaration entry，因此干净 checkout 在生成公开 entry 前不需要已存在的 workspace JavaScript bundle。Agent 项目直接依赖 `@karaka-ai/agent`，因此本地 `plugins/*.js` 文件和可复用包针对 Loader 挂载的相同 service identity 进行编译。

一个 Agent 定义仍是一个 Agent Preset 目录。`preset.yml` 拥有发现 metadata，`agent.cordis.yml` 拥有行为插件组合。每个 chat 在该 preset 的常驻世代中创建或恢复独立 Agent 与持久 Session。组合改变时会启动另一个世代，而不会替换已加入 chat 使用的实例。

每个应用 chat Session 在其持久 header 中保留一个原子 `{ applicationId, tenantId, userId }` owner。SDK 发送认证 chat 请求，并把显式注册的后端 callback 暴露为已认证的 Streamable HTTP MCP 工具。认证、HTTP/SSE ingress 和应用 MCP client 是 Agent 内部模块，但仍是可替换的 Cordis service 与插件。

`karaka start` 解析 `@karaka-ai/agent/bin`，向其提供绝对部署 patch，并提供项目私有的 Karaka home。Agent 拥有 boot 和优雅进程 teardown。CLI 与 SDK 都不解析或启动 `dsh` 包，公开 contract 也不包含 programmatic Agent boot API。

## 考虑过的替代方案

**发布每个 DSH 与 Karaka workspace 包。** 这保留 npm 包边界，但会让应用运维者安装并协调内部实现图，并把 DeepSeek Harness 命名暴露为 Karaka 的 runtime contract。

**保留 `@karaka-ai/harness` 作为薄 DSH profile。** 这减少构建工作，但部署时需要 DSH launcher 和所有修改过的插件包，使 Karaka 仍是另一个已安装产品之上的配置。

**把完整 runtime 放入 `@karaka-ai/cli`。** 这会让命令包拥有服务器实现，并让 Agent 扩展无法在不依赖 CLI 关注点的情况下依赖稳定 runtime 包。

**把 Agent 嵌入每个应用后端。** 这会把请求 worker 与模型 turn 生命周期耦合，在服务之间复制 runtime，并阻止一个持久 Agent 部署服务多个后端。

**定义 Karaka 专用 Agent schema 并重写 loop。** 这会复制 ReactLoopAgent、scoped registry、Session durability、Agent Preset 和 Cordis disposal。Karaka 改变分发方式与公开模块名称，同时保留这些实现和 extension point。

**把业务函数导入 Agent 进程。** 这会让 Agent 部署携带应用代码和凭据。已认证 MCP 保持应用作为执行 owner，并允许工具发现保持动态。

**复用本地 SDK JSON-RPC lifecycle。** 该协议拥有一个 child process 和本地 byte stream。Karaka 需要独立于 caller 的持久服务器、持久应用 owner 和可重连 HTTP streaming。

## 后果

Karaka 部署安装一个公开 runtime 标识，并可添加私有插件而无需发布它们。向内置 Loader registry 添加受支持的 DSH 模块时，也会添加其匹配的公开子路径；仅含约定的 entry 保持显式审计列表。内置构建必须保持动态模块加载、native asset、worker entry、declaration 和共享 Cordis instance 完整；clean packed-install test 负责此风险。内部 workspace 继续供 DSH 开发使用，但改变其模块图不要求对应的 Karaka 包图。SQLite 持久化 chat owner 和事件；待处理的结构化问题仍保留在进程内。TLS、副本数、跨副本路由和 supervision 仍由部署负责。
