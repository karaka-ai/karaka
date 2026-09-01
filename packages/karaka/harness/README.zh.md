---
description: "组合 DSH Agent Presets、SQLite Session、带认证应用入口和远程 MCP 工具的持久 Karaka bundle。"
kind: "package-bundle"
---

# @karaka/harness

[English](README.md) | 中文

## 概述

`@karaka/harness` 是基于 `dsh-base` 的持久 Karaka 服务器 bundle。它组合 Agent Presets、SQLite Session 持久化、Session Controller 所需的 workspace registry、共享 Host Web 服务器、服务器认证和应用 HTTP transport。它也让带认证的应用 MCP bridge 可以解析远程工具 endpoint。应用自有 endpoint 必须放在部署组合中；普通 MCP endpoint 可以放在 Agent Preset 中。其安全默认值禁用本地编码与 shell 工具；每个 Agent 目录提供自己的 Cordis 组合。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

`karaka` profile 通过现有 DSH Loader 挂载此 bundle。在部署的 `karaka.cordis.yml` 中配置应用和带认证的 MCP endpoint；在 `agents/<id>/preset.yml` 与 `agents/<id>/agent.cordis.yml` 中定义每个具名 Agent。

<a id="model-experience"></a>
## 模型体验

间接地，通过每个 Agent Preset 选择的模型、提示词、工具、skill 和 policy 插件。

#### KV Cache 影响

本 bundle 自身不添加文本；改变 Agent 组合可能改变该 Agent 的系统提示词或工具 schema 前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **每次启动一个 Node 进程**——副本数量和负载均衡仍由部署负责。
- **禁用本地编码工具**——Agent 需要显式可信的插件组合才能重新获得文件系统或子进程访问。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
