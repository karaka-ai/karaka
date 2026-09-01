---
description: "Karaka 应用边界、持久服务器配置和启动器的包映射。"
kind: "package-group"
---

# karaka/：面向应用的 Karaka 包

[English](README.md) | 中文

## 概述

`karaka/` 组把应用后端连接到持久运行的多 Agent Harness 进程。SDK 负责后端聊天调用和 MCP 工具托管；Cordis 插件负责服务器认证和 HTTP 入口；harness bundle 与 CLI 负责安全的持久服务器组合和启动路径。

## 包

| 包 | 角色 |
|---|---|
| [`sdk/`](sdk/README.zh.md) | 后端聊天客户端与带认证的 MCP 工具主机 |
| [`server-auth/`](server-auth/README.zh.md) | 可替换的应用服务器认证 |
| [`mcp-application/`](mcp-application/README.zh.md) | 带认证的应用 MCP 工具桥接 |
| [`transport-http/`](transport-http/README.zh.md) | 带认证的 JSON 与 SSE 应用入口 |
| [`harness/`](harness/README.zh.md) | 持久 Karaka Cordis bundle |
| [`cli/`](cli/README.zh.md) | Agent 工作区脚手架与启动器 |

边界约定见 [Karaka 应用子系统](../../docs/subsystems/karaka-application.zh.md)，进程流程见[架构](../../docs/architecture.zh.md#karaka-application-runtime)。

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
