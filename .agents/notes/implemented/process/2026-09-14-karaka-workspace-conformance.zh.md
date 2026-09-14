# Agent Note: Karaka 工作区规范一致性

Status: implemented

[English](2026-09-14-karaka-workspace-conformance.md) | 中文

## Problem

Karaka 包属于工作区，但独立源码构建不会将它们纳入 DSH 的编译器引用、源码解析、文档目录或行为测试。因此，产物构建通过并不能证明包符合仓库规范。

## Decision

Karaka 使用仓库的[源码导入映射](../../../../tsconfig.base.json)、Host 编译聚合项目以及根打包器。包内编译与打包配置负责额外导出和浏览器入口。独立浏览器模块使用共享 DSH 类型，不合并 Client Cordis Context，因此共用包的编译项目，并单独生成浏览器包。[应用构建命令](../../../../packages/karaka/agent/package.json)委托该项目图执行。这取代了 [CI 基础设施记录](2026-09-14-karaka-ci-build-and-hosted-runners.zh.md)中的独立构建决策；运行器与凭证决策仍相互独立。

包 README、服务文档、不变量判断和行为测试遵循 DSH 包的同一套规则。传输层通过会话投影维护已确认的请求 ID 与模型选择状态，不使用已弃用的同步历史扫描。[Karaka 子系统页面](../../../../docs/subsystems/karaka.zh.md)负责生成的服务文档。编译器引用解析工作区源码导入，无需依赖过时的包声明文件。

## Alternatives considered

**从共享检查中排除 Karaka：**这会留下未检测的集成错误，也不符合工作区成员身份。

**维护第二套编译与文档系统：**这能保持更多上游文件原样，但会重复策略和验证。少量显式源码别名、编译器引用和服务归属条目，既让包特有行为留在包内，也避免重复这些系统。

## Consequences

手写上游实现保持不变；生成的 Cordis API 目录包含已注册的 Karaka 服务。共享配置包含显式 Karaka 注册，重放上游提交时必须保留。包检查不能解决分叉仓库发布策略、启动器分类、CI 进程监督或真实测试凭证缺失；这些问题需要独立证据和决策。本地包覆盖率可以证明所执行的源码行为，但不能证明平台矩阵通过。
