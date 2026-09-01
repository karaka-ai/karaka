---
description: "Karaka Agent Preset 对应用自有 MCP 工具进行带认证发现与调用。"
kind: "package-reference"
---

# @karaka/mcp-application

[English](README.md) | 中文

## 概述

`@karaka/mcp-application` 将 Karaka 连接到一个应用的 Streamable HTTP MCP endpoint。它通过 `ctx.serverAuth` 解析出站 authorization，仅公开 Agent Preset 明确选择的工具，并随每次调用转发执行 Session 的应用、租户、用户和 chat 标识。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

在部署 composition 中为每个应用工具 endpoint 挂载一行。`applicationId` 必须匹配已配置的 `ctx.serverAuth` 应用；其余字段是通用 Streamable HTTP MCP 设置。

```yaml
- id: billing-tools
  name: '@karaka/mcp-application'
  config:
    serverName: billing
    url: https://billing.internal/mcp
    applicationId: billing
```

Agent Preset 通过现有工具 `allow` 列表选择具体限定名称。工具对其他应用和未选择它的 preset 保持隐藏。

<a id="model-experience"></a>
## 模型体验

间接产生影响，通过活动 Agent Preset 明确选择的已发现 MCP 工具 schema。

#### KV Cache 影响

所选 schema 会扩展模型请求前缀；远端工具 generation 变化可能使该前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅 Streamable HTTP**——应用工具 endpoint 不能使用通用 MCP client 的 stdio transport。
- **仅应用自有 Session**——缺少匹配 Session owner metadata 的调用会在 MCP 调用前失败。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
