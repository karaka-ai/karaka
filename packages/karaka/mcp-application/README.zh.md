---
description: "配置经过认证的应用 MCP 目录、继承式工具限制、模式接收与重连行为。"
kind: "package-reference"
---
# @karaka-ai/mcp-application

[English](README.md) | 中文

## 概述

应用可只向可信归属匹配的 Agent 暴露选定的 MCP 工具。桥接器为每个 HTTP 请求更新凭证，并在分派前校验所有权与当前策略。明确的端点和预设允许列表决定工具是否可见。DSH Tools 继续负责执行、参数错误分类和模型结果处理。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在应用组合中挂载此插件，并提供 Tools、Agent、[身份](../identity/README.zh.md)及[服务器认证](../server-auth/README.zh.md)服务。配置 `applicationId`、稳定的 `serverName` 和 HTTP(S) `url`。公开名称采用 `mcp__<serverName>__<rawName>`；模型命名限制要求调整时使用确定性的规范化结果。

端点的 `allow` 和 `deny` 列表使用公开工具名，默认均为空。Agent 预设还必须挂载带有明确允许列表的 `./tool-policy`。每层祖先允许列表都必须接收该工具，任一拒绝列表均可拒绝它。`mode` 选择原生、PTC 或两种展示方式。预设卸载时撤销工具策略注册。

`headers` 提供静态请求头，`serverAuth` 在每个 HTTP 请求前提供当前授权信息。重定向被拒绝。`toolCallTimeoutMs` 默认为 60,000，`failOnStartupError` 默认为 true。可选的 `reconnect` 控制传输关闭后的恢复：默认启用，初始延迟为 500 毫秒，最大延迟为 30,000 毫秒，每次中断最多允许十次失败尝试。

输入模式必须采用 DSH 支持的以对象为根的 JSON Schema 子集。根 `$schema` 标记被省略，不受支持的输入关键字会导致目录接收失败。本地参数校验在任何 MCP 回调发生前以 `INVALID_ARGS` 拒绝调用；远程失败并不能证明操作没有产生效果。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>作用域目录与连接所有权</summary>

每个端点拥有私有目录。获授权的 Agent 作用域接收准入的定义，调用元数据来自可信 Session 归属。策略变更会刷新作用域注册。发现过程先构建完整的新目录，再替换旧一代；连接清理等待进行中的发现完成并移除其贡献。

本包通过共享的 [DSH MCP 客户端扩展](../../mcp/mcp-client/README.zh.md#programmatic-extensions)复用连接监督、发现和丰富结果转换。Karaka 提供经过认证的 HTTP 传输、经过验证的调用元数据、严格的模式准入和作用域目录注册。[上游来源记录](UPSTREAM.json) 标识共享实现与应用自有适配器。

本包不发布运行时不变量伴随模块：异步目录刷新没有独立的服务器与工具对照快照。执行器在每次分派前重新校验所有权和策略。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 获准的应用工具

#### 模型看到的内容

只有通过端点策略、可信归属及继承的预设策略接收的工具才会出现，并附带服务器提供的描述和受支持的输入模式。凭证与调用归属元数据不会进入工具模式。

#### Token 影响

工具注册期间，可见的名称、描述和模式会增加请求词元。目录刷新替换定义，不会累积副本。

#### KV Cache 影响

未变化的准入目录保留工具定义前缀。目录或策略变更若改变可见定义，可能从首个变化词元起使缓存复用失效。

### 工具结果与参数失败

#### 模型看到的内容

DSH Tools 报告本地 `INVALID_ARGS` 错误，且不会分派 MCP 调用。成功结果保留文本和符合条件的持久化图像；被拒绝的图像及不受支持的富内容块产生文本诊断。MCP 应用错误保留其失败分类。

#### Token 影响

可见结果文本和图像引用保留在历史中，直到压缩。修正后的参数提案产生正常的模型调用成本。原始内联媒体仅保留在供程序化调用者使用的执行结果中。

#### KV Cache 影响

工具结果追加在已有请求前缀之后；本地校验不会新增独立提示或替换前缀。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

桥接器保留以下 MCP 与应用限制。

- 支持 MCP 工具，不支持资源、提示和基于任务的执行。不受支持的输入模式拒绝接收，不受支持的输出模式退回为 JSON 值。
- 启动与发现采用 MCP SDK 超时。HTTP 请求失败使用 SDK 传输恢复机制；监督器在传输关闭时重连。
- 应用领域约束、副作用核算和事务保证仍由回调所有者负责。只有本地参数拒绝才能确认未分派回调。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
