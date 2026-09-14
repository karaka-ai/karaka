# Agent Note: Karaka 使用共享 MCP 扩展

Status: implemented

[English](2026-09-14-shared-mcp-extensions-for-karaka.md) | 中文

## Problem

Karaka 需要可更新的 HTTP 凭据、经过验证的调用归属、受限目录和严格参数准入。为增加这些操作而复制 DSH 的连接监督器和丰富结果转换，也会重复重连、清理和媒体行为。上游修复随后必须重放到两份实现和两套继承测试中。

## Decision

[DSH MCP 客户端](../../../../packages/mcp/mcp-client/README.zh.md#programmatic-extensions)通过现有包入口暴露可选的程序化传输和工具扩展。默认插件配置保留其传输、注册和执行行为。共享包不认识 Karaka 的应用、租户或用户字段。

工具准备接收原始 MCP 描述，在目录替换前执行，并保留公开名称和远程分派身份。因此，准入失败保留上一份目录。元数据在每次执行时、远程分派前解析；授权拒绝不会发出请求。自定义注册负责回滚及其发布贡献的完整清理。自定义传输工厂为每次连接尝试创建新传输，重连与关闭仍由共享监督器负责。

Karaka 负责经过认证的 HTTP 传输、私有目录注册、继承策略检查及小型模式验证包装器。包装器在准备阶段验证受支持的对象模式，在受支持调用进入共享执行器前验证参数，保留本地 `INVALID_ARGS` 分类。要求任务扩展的工具保留共享实现中不支持任务的拒绝行为。连接监督、协议命名、丰富结果转换及其继承测试在 DSH 中只有一个维护者。[来源记录](../../../../packages/karaka/mcp-application/UPSTREAM.json)列出承载扩展的三个共享实现文件和本地适配器。

本决策仅取代 [Karaka 权限归属](2026-09-12-karaka-authority-over-upstream-runtime.zh.md)中复制 MCP 实现的决定。其独立持久身份、不变的 Session 格式和各 Agent 授权仍然有效。[MCP 功能记录](../feature/2026-07-07-mcp-client-plugin.zh.md)保留命名、协议和结果投影的理由。[工作区规范一致性记录](../process/2026-09-14-karaka-workspace-conformance.zh.md)负责编译器集成和精确的配置引导启动器分类。

## Alternatives considered

**保留改写副本，以避免任何上游实现改动。** 这能减少触及的上游文件，却重复运行时和继承测试。小型通用扩展让应用策略留在本地，同时让重连和结果修复只需更新一份实现。

**将 Karaka 认证移入共享 MCP 插件。** 这会使 DSH 依赖分叉特有的身份和凭据服务。通用回调保留普通 DSH 配置，并让应用归属继续由其维护者负责。

**只在自定义注册阶段验证模式。** 注册发生在旧目录清理之后。此时拒绝无效替代目录会失去可用目录；准备必须在发现阶段完成。

## Testing

共享[扩展测试](../../../../packages/mcp/mcp-client/tests/extensions.spec.ts)覆盖默认不携带元数据、分派前授权拒绝、准备失败保留目录、自定义注册回滚及传输清理。原有 DSH MCP 测试负责普通协议和重连行为。Karaka 的[应用测试](../../../../packages/karaka/mcp-application/tests/application.spec.ts)针对共享运行时验证经过认证的 HTTP 和作用域策略；其模式包装器测试负责本地输入准入。

## Consequences

上游重放必须保留有限的 MCP 扩展点、导出类型和默认行为回归测试。Karaka 维护更少的运行时副本，并针对共享实现测试自身适配器。程序化 API 的消费者负责命名空间协调、启动失败策略和生命周期注册；普通 Cordis 插件仍为其配置式用法承担这些责任。

应用本地参数拒绝和授权仍区别于远程失败：只有本地检查能证明尚未分派请求。共享回调不会向 DSH 持久格式或配置增加租户或用户字段。
