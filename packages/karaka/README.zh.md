---
description: "Karaka 后端 SDK、自包含 Agent runtime 和启动器的包映射。"
kind: "package-group"
---

# karaka/：面向应用的 Karaka 包

[English](README.md) | 中文

## 概述

`karaka/` 组把应用后端连接到持久运行的 Karaka Agent 进程。SDK 负责后端聊天调用和 MCP 工具托管，Agent 包负责完整服务器 runtime，CLI 创建并启动 Agent 项目。

## 包

| 包 | 角色 |
|---|---|
| [`sdk/`](sdk/README.zh.md) | 后端聊天客户端与带认证的 MCP 工具主机 |
| [`agent/`](agent/README.zh.md) | 自包含 Cordis Agent runtime 和应用服务器 |
| [`cli/`](cli/README.zh.md) | Agent 项目脚手架与启动器 |

服务器认证、HTTP transport 和应用 MCP bridge 是 Agent 的内部模块，不单独发布。集成约定见 [Karaka 应用子系统](../../docs/subsystems/karaka-application.zh.md)，进程流程见[架构](../../docs/architecture.zh.md#karaka-application-runtime)。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
