---
description: "从应用后端进入持久 Karaka 进程的带认证 JSON 与 SSE 入口。"
kind: "package-reference"
---

# @karaka-ai/transport-http

[English](README.md) | 中文

## 概述

`@karaka-ai/transport-http` 在 `ctx.webServer` 上挂载应用 Chat API。它通过 `ctx.serverAuth` 认证调用服务器，把该应用身份与可信的租户和用户值组合，再调用 `ctx.sessionController.application`。JSON 路由接收命令并读取历史；SSE 流式输出稳定聊天事件和结构化用户问题。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration"></a>
## 配置

`path` 选择路由前缀，默认为 `/v1`。`maxBodyBytes` 限制 JSON 请求体，默认为 1 MiB。流会在提交 SSE header 前验证聊天 owner，并在客户端断开时中止其 Session follower。每个路由注册、待回答交互和活动流都由插件 effect 所有，并在 dispose 时结束。

<a id="model-experience"></a>
## 模型体验

无，因为本包只传输应用输入并投影 Session 事件，不组装模型请求。

#### KV Cache 影响

无直接影响；Agent 及其 preset 负责请求构造。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **单进程交互状态**——尚未回答的结构化问题不会在 Karaka 进程重启后保留。
- **无分布式接收锁**——一个进程内会串行化同一聊天；多副本部署需要外部路由或协调。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
