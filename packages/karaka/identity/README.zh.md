---
description: "Karaka 部署使用的进程内应用所有权、显式根会话恢复与按所有者筛选的 Session 引用。"
kind: "package-reference"
---

# @karaka-ai/identity

[English](README.md) | 中文

## 概述

使用内存中的应用、租户和用户所有权授权聊天。仅在应用验证访问权限后恢复现有根会话的所有权。通过可信父级头部继承所有权，并将 Session 引用限制为已验证的所有者。重启会清除所有权；应用必须在重新打开聊天前再次验证访问权限。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 `cordis.yml` 中将 `@karaka-ai/identity` 与 Session 和 Session 持久化一同挂载。此插件不需要配置或本地所有权文件。

在预留、Agent 创建或经授权的恢复，以及确认期间持续持有 `withChatLock`。对现有根会话调用 `restore` 前，入口必须验证应用权限、聊天范围和允许的预设。普通授权与所有者查询绝不接管无主 Session。在 Agent 设置过程中绑定新 Session；`markReady` 在确认前刷新并核对已持久化的头部。授权必须早于恢复，因为恢复可能修复持久化数据。

选择 `@karaka-ai/identity/session-reference` 作为 Session 引用提供者。两个 Session 都必须具有已解析的所有者，且应用、租户和用户均相同。无主 Session 不能提供或接收引用。候选项在应用结果数量上限前按所有权筛选。


-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[权限服务](src/index.ts)在内存中保存预留、已绑定或就绪记录，启动时不枚举已持久化的 Session。[绑定](src/records.ts)比较不可变 Session 字段，不包含物理格式版本。绑定冲突和已确认数据缺失会阻止访问。同一所有者可重试尚未落盘的创建尝试；只有显式且经过验证的恢复才能接管现有根会话。

工具从执行中的 Session 和服务器写入的 `parentSession` 谱系推导所有者。缓存观测支持同步目录筛选；执行时会重新解析权限。循环、缺失祖先和所有者冲突均不授予应用访问权限。普通 DSH Session 没有应用所有者。

不发布不变量伴随模块，因为权限服务在预留、绑定、授权和所有权恢复时，将所有权记录与观测到的 Session 头部直接核对；不维护单独的诊断投影。

</details>


-----

<a id="further-exploration"></a>
## 延伸阅读

- [Session](../../core/session/README.zh.md)：不可变头部与事件日志。

- [Session 引用](../../context/session-reference/README.zh.md)：引用内容与预算。

- [服务器身份验证](../server-auth/README.zh.md)：经过验证的应用身份。

-----

<a id="model-experience"></a>
## 模型体验

### 授权

#### 模型看到的内容

`karakaIdentity` 不添加提示文本。Session 引用提供者通过原有 DSH 引用渲染器提供所有者已授权的上下文；工具消费者依据所有权选择可用工具。

#### Token 影响

所有权记录和检查不增加模型 Token；获准的引用内容沿用 DSH 引用提供者的 Token 预算。

#### KV Cache 影响

权限检查不改变已有请求前缀；获授权的引用内容与消费者的工具选择可能改变后续模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

部署时须考虑以下限制。

- 所有权仅限当前进程。每个进程和每次重启均需经过验证的恢复；独立进程无法检测相互冲突的所有者分配。
- 须将祖先日志与子 Session 一同保留。在应用恢复根会话之前，子会话的所有权不可用。不支持独立保留子会话，也不支持外部子 Agent 提供者的身份继承。
- 通用 Session 查询工具保留工作区授权。不带 cwd 的应用根会话可访问本会话历史；应用范围的历史搜索需要识别所有者的消费者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
