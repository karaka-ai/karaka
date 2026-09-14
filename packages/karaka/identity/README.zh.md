---
description: "Karaka 部署使用的持久化应用所有权、Session 谱系授权与按所有者筛选的引用。"
kind: "package-reference"
---

# @karaka-ai/identity

[English](README.md) | 中文

## 概述

在聊天创建与重启后持久保留应用、租户和用户所有权。在恢复 DSH Session 前授权聊天，并通过可信父级头部继承所有权。将 Session 引用限制为同一所有者。备份时一并保留权限记录、Session 日志及其祖先日志。

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

在 `cordis.yml` 中将 `@karaka-ai/identity` 与 DSH 存储、Session 和 Session 持久化一同挂载。将 `root` 配置为此服务器权限记录专用的绝对路径。备份时须将此目录与 JSONL 存储一同保留。

在预留、Agent 创建或经授权的恢复，以及确认期间持续持有 `withChatLock`。在 Agent 设置过程中绑定实际尚未发布的 Session；`markReady` 先刷新 Session 数据，再记录就绪状态。授权必须早于恢复，因为恢复可能修复持久化数据。

选择 `@karaka-ai/identity/session-reference` 作为 Session 引用提供者。应用 Agent 只能引用同一应用、租户和用户的聊天；普通 DSH Agent 不能引用应用聊天。候选项在应用结果数量上限前按所有权筛选。


-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[权限服务](src/index.ts)在 DSH JSON 存储域中保存预留、已绑定或就绪记录。[绑定](src/records.ts)比较不可变 Session 字段，不包含物理格式版本。权限损坏、绑定冲突和已确认数据缺失会阻止访问或启动。同一所有者可重试尚未落盘的创建尝试，但不能接管已有的无主日志。

工具从执行中的 Session 和服务器写入的 `parentSession` 谱系推导所有者。缓存观测支持同步目录筛选；执行时会重新解析权限。循环、缺失祖先和所有者冲突均不授予应用访问权限。普通 DSH Session 没有应用所有者。

不发布不变量伴随模块，因为权限服务在预留、绑定、授权和恢复时，将持久化记录与观测到的 Session 头部直接核对；不维护单独的诊断投影。

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

- 独占写入锁依赖原生 POSIX flock，支持 Linux/macOS。不支持 Windows 权限存储锁，也不提供无锁回退。须保留永久锁文件。
- 所有访问权限目录的进程必须使用此插件。一并保留权限文件与祖先日志；单独备份子日志无法重建所有权。不支持独立保留子会话，也不支持外部子 Agent 提供者的身份继承。
- 通用 Session 查询工具保留工作区授权。不带 cwd 的应用根会话可访问本会话历史；应用范围的历史搜索需要识别所有者的消费者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
