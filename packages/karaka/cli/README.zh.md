---
description: "用于创建 Agent 工作区并启动其持久 DSH profile 的 Karaka CLI。"
kind: "package-reference"
---

# @karaka/cli

[English](README.md) | 中文

## 概述

`@karaka/cli` 把工作区创建与应用 SDK 分开。`karaka init` 创建 Cordis 部署 patch 和一个 Agent Preset，且不覆盖已有文件。`karaka start` 使用持久 `karaka` profile 与项目本地 `.karaka` Harness home 启动现有 `dsh` binary。

## 目录

- [命令](#commands)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="commands"></a>
## 命令

- `karaka init --dir <path>` 创建 Agent 工作区；默认路径为 `apps/agents`。
- `karaka start --config <path>` 会准备项目本地 `.karaka` home、让 Karaka bundle 与已安装的运行时依赖对 Agent Preset 可见，然后委托给 `dsh` 启动；默认 patch 为 `karaka.cordis.yml`。

<a id="model-experience"></a>
## 模型体验

无，因为 CLI 只选择 bundle 与 patch，不贡献提示词或工具定义。

#### KV Cache 影响

无直接影响；启动后的 Agent Presets 负责模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅前台进程**——CLI 不负责 daemon、监控副本或配置反向代理。
- **项目本地 Harness home**——当进程本地持久数据需要跨主机替换保留时，运维者必须挂载或备份 `.karaka`。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
