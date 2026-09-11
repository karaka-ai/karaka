# Agent Note: 仅保留 JSONL 的第一方 Session 持久化

Status: implemented

[English](2026-08-30-jsonl-only-session-persistence.md) | 中文

## 问题

Karaka 此前选择 SQLite Session provider，并在上游移除该后端时保留了它。2026-09-11，操作者选择 JSONL，并确认没有现有 chat 需要迁移。部署需求结束后继续保留第二种权威格式，会使其 schema、资源、公开导出和跨 provider 测试继续存在。

SQLite Session-query provider 拥有独立、可重建的索引。通用 SQLite domain-KV provider 也独立于 Session 日志；两者均不在本次移除范围内。

## 决策

`@deepseek-ai/dsh-session-persistence-jsonl` 是 `ctx.sessionPersistence` 唯一的第一方实现，Karaka 的内置组合也使用它。Service Definition 和 `PersistenceCoordinator` 保持后端中立。移除权威 SQLite package、schema 资源、registry 条目、公开导出、依赖及后端专属测试。共享持久化消费者测试 JSONL，Windows 原生测试通道继续覆盖 JSONL 持久性。

JSONL header 保留原子的应用/租户/用户 owner 及 fork 谱系。事件保留逻辑顺序与请求标识。Karaka 保留冷态激活修复，在重建 Agent 前加载 preset 投影。真实进程重启及 provider 重新挂载测试覆盖所有权隔离、历史、继承事件和重复请求接收。

新 Session 使用 Karaka home 下的 JSONL 根目录，并采用 provider 默认压缩。旧 `karaka-sessions.sqlite` 文件不会被读取、转换或删除。操作者已确认不需要迁移，因此本次部署切换不提供迁移工具。当前 runtime 不再使用数据库，并不意味着可以丢弃现有数据库文件。

`@deepseek-ai/dsh-session-query-sqlite` 继续作为独立派生数据库上的可选 FTS5 provider；`@deepseek-ai/dsh-storage-sqlite` 继续作为通用 domain-KV provider。

## 考虑过的替代方案

- **保留可选权威 SQLite provider。** 本次部署不采纳，因为没有当前需求，却会保留第二种物理格式和生命周期的维护责任。
- **立即构建离线转换器。** 已确认没有 chat 需要保留的切换不需要它。未来有历史数据库的部署必须在切换前另行验证迁移；本次变更不宣称提供迁移支持。
- **将查询索引作为权威存储。** 不采纳，因为可丢弃的投影不能替代权威 Session header 和事件。

## 后果

Karaka 共享上游 JSONL 持久化路径，同时保留所有权与冷重启行为。SQLite 搜索和 domain-KV 仍可使用。Session 格式迁移和 handle 变更仍是独立工作；移除此后端并不意味着已纳入那些后续协议变更。
