---
description: "用于带认证 Karaka 聊天调用，以及在现有应用 HTTP 服务器上托管 MCP 工具的后端 SDK。"
kind: "package-reference"
---

# @karaka/sdk

[English](README.md) | 中文

## 概述

`@karaka/sdk` 是应用后端包。`createKarakaClient()` 调用已运行的 Karaka 服务器；`createKarakaToolHost()` 通过调用方已有的 Node HTTP 路由，把显式注册的应用函数暴露为带认证的无状态 MCP 工具。SDK 不启动 Karaka，也不监听端口。

本包还拥有与 Karaka 服务器 transport 共享的客户端安全 HTTP JSON/SSE schema。它不依赖 Cordis、Agent、Session 或 Harness runtime。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

用 Karaka endpoint 和聊天凭据创建一个客户端，再用 `forUser()` 绑定可信的 `{ tenantId, userId }`。可选的 `path` 默认为 `/v1`，并且必须与 HTTP transport 插件一致。绑定后的客户端可以列出 Agent，并创建、发送、流式读取、读取历史、取消、配置和回复聊天交互。结束流迭代会取消响应体；服务器端 SSE 错误会携带其代码拒绝迭代。

使用 `registerTool(name, { description, inputSchema }, callback)` 注册工具。把 `expressHandler()` 或 `nextHandler()` 挂到应用路由，并在 Karaka 中把同一路由配置成 Streamable HTTP MCP endpoint。回调接收已验证的对象参数和可信的 `{ applicationId, tenantId, userId, chatId, signal }` 上下文。

<a id="model-experience"></a>
## 模型体验

间接地，通过 Karaka 应用 MCP 插件呈现 Agent Preset 选中的已注册工具。

#### KV Cache 影响

改变已选工具的名称、描述或 schema 会改变该 Agent 的工具 schema 请求前缀；聊天客户端操作本身不添加模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅 Node HTTP 适配器**——工具主机支持兼容 Express 的 handler 与 Next.js Pages API 路由；不包含 Fetch 原生路由适配器。
- **一种 HTTP transport**——聊天使用 JSON 和 SSE；其他应用 transport 需要对应的 SDK 与服务器实现。
- **受限的输入 schema 词汇**——`inputSchema` 必须能投影为 DSH 强制执行的对象根 JSON Schema 子集。支持标量类型、对象属性、必填字段、数组、enum/const 与 `oneOf`；字符串长度、数值范围、pattern 和 format 等约束会在 Karaka 连接 MCP endpoint 时被拒绝，并报告对应 schema 路径。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
