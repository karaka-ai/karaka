# Agent Note：重置为 Karaka Cordis 基础层

Status: implemented

[English](2026-08-27-karaka-cordis-foundation.md) | 中文

## 背景

本仓库曾实现包含 227 个 harness 包、多个应用、原生与 Python 分发以及产品专用自动化的完整智能体产品。该依赖图使基础设施 API 难以独立建立：存储、身份、模型、遥测和会话在 SaaS 应用选择提供方之前就已经带有产品假设。

以 vendor 方式引入的 Cordis 层已经提供 Karaka 所需的机制。服务为能力命名，提供方通过插件注册实现，消费者注入服务名，生命周期 effect 在插件卸载时撤销每项贡献。

## 决策

Karaka 只保留 `@karaka/*` 下九个可发布的 Cordis 基础包：Cordis、Cosmokit、Schemastery、Loader、Include、Group、Timer、HMR 和 Logger Console。仓库保留固定的上游归属、记录的本地差异、针对性回归测试、Loader/Include 示例、双语基础文档和手动发布工具。

智能体、工具、模型、存储、身份、会话、用户界面、原生和 SDK 实现均不存在。未来每项应用能力都必须从服务定义开始，再添加提供方和消费者插件，不得让服务 API 耦合到单一厂商。此次重置不为旧包作用域或磁盘格式提供兼容别名。

DeepSeek Harness 文档和活动决策记录作为不参与构建的 legacy 语料保留。已删除的产品源码保存在 Git 历史中。冻结的已归档 Agent Note 由于内容封存规则而保留在原路径，不能移动或编辑。

## 考虑过的替代方案

保留智能体主干能够维持可用行为，但会让旧产品架构继续成为默认起点。只保留原始 Cordis 内核会丢失 Loader、Include、HMR，以及配置驱动应用所需的本地事务性修复。回到未修改的上游源码也会丢失已了解并记录失败模式的修复。

## 影响

在后续插件添加能力前，Karaka 不具备可用的 SaaS 或智能体能力。该阶段采用手动发布，仓库不配置 CI。包消费者必须迁移到 `@karaka/*`，旧包名不再解析。

更小的依赖图让每项新能力都成为明确的架构选择。提供方替换可以改变应用的基础设施，而无需修改消费者；Cordis 只负责组合和生命周期。

## 验证

活动 workspace 包含九个基础包和一个私有示例。类型检查、单元测试、构建后示例执行、文档配对、包元数据验证、publint 和 tarball 创建覆盖保留内容。`vendor/README.md` 链接的测试在不导入已删除 harness 代码的情况下保护本地源码差异。
