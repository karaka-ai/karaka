---
description: "Karaka 应用服务器流量的 Cordis 认证约定与共享 bearer provider。"
kind: "package-reference"
---

# @karaka-ai/server-auth

[English](README.md) | 中文

## 概述

`@karaka-ai/server-auth` 定义 `ctx.serverAuth`，并提供默认共享 bearer 实现。它把入站应用聊天凭据验证为 `applicationId`，并解析 Karaka 调用该应用 MCP 工具 endpoint 时使用的出站凭据。凭据值保留在 `ctx.credentials` 中，并在每次操作时解析。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

每个 `applications` 条目包含稳定的 `id`、`chatCredential` 和 `toolCredential`。两个凭据引用可独立轮换。其他 provider 可在同一 service 后实现 `authenticate()` 与 `authorizeTools()`。

<a id="model-experience"></a>
## 模型体验

无，因为认证元数据不会加入提示词、消息或工具 schema。

#### KV Cache 影响

无；凭据解析和验证发生在模型请求之外。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅内置共享 bearer provider**——基于 header 的 OAuth 或 workload identity provider 可以替换它。mTLS 与 transport 层请求签名需要未来扩展 contract，使其能接收 socket 与请求选项。
- **TLS 归部署所有**——生产环境应在 Host Web 服务器之前终止 HTTPS。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
