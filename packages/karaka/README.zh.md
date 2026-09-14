---
description: "Karaka 包组：面向嵌入式智能体的应用身份、认证、浏览器与 HTTP 访问及应用 MCP 工具。"
kind: "package-group"
---

# karaka/ — 应用智能体

[English](README.md) | 中文

## 摘要

Karaka 让应用创建归属明确的会话、认证浏览器和服务端客户端，并向智能体开放选定的应用工具。agent bundle 将这些包与 DSH 的模型、工具、循环和持久化实现组合在一起。下表中的包文档分别说明其配置和访问规则。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包负责应用访问或部署的一部分。

| 包 | 职责 |
|---|---|
| [`agent`](agent/README.zh.md) | 组合并启动 Karaka 应用 profile |
| [`identity`](identity/README.zh.md) | 将持久化会话归属与 DSH Session 日志分开保存 |
| [`server-auth`](server-auth/README.zh.md) | 认证服务端请求并解析应用凭据 |
| [`browser-auth`](browser-auth/README.zh.md) | 按配置的签发者和应用验证浏览器凭据 |
| [`transport-http`](transport-http/README.zh.md) | 向服务端和浏览器客户端提供按归属筛选的会话操作 |
| [`mcp-application`](mcp-application/README.zh.md) | 在端点和 preset 权限范围内开放应用 MCP 工具 |

<a id="related-documentation"></a>
## 相关文档

- [Karaka 子系统](../../docs/subsystems/karaka.zh.md) — 应用权限与集成 API。
- [运行时打包](agent/IMPLEMENTATION.md) — 组装产物和集成测试范围。
- [Harness 架构](../../docs/architecture.zh.md) — 共享运行时及其扩展点。

<a id="dev-note"></a>
## 开发备注

无。
