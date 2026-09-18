---
description: "通过共享工具、显式服务器选择和 agent 作用域访问，按需发现与读取 MCP 资源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

[English](README.md) | 中文

## 概述

`dsh-mcp-resources` 让模型发现和读取已配置 MCP 服务器提供的文档。当 MCP 服务器提供资源或 URI 模板时可选择本包，包括不提供工具的服务器。三个共享工具要求显式指定服务器名称，并且仅在调用时读取内容。资源文本进入对话历史；二进制载荷仍可供程序化调用方访问，并以说明文字呈现给模型。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在模型需要访问资源的 [MCP 客户端](../mcp-client/README.zh.md)配置项旁挂载本包一次。

### 最小配置

组合必须已提供工具注册表。添加以下服务配置行；每个 MCP 客户端配置项自行提供服务器配置。

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

本包没有配置字段。挂载后会添加三个共享工具；每个 MCP 客户端提供对其已配置服务器的访问。未挂载本包时，资源工具不可用。

### 发现与读取

挂载系统提示词组装服务时，提示词列出调用 agent 可见的服务器名称。将其中一个名称作为 `server` 调用 `list_mcp_resources` 或 `list_mcp_resource_templates`。未提供游标时，MCP SDK 收集服务器的全部分页；显式提供游标时返回一页；将其中的 `nextCursor` 原样作为 `cursor` 传入，以请求下一页。使用相同的 `server` 名称和显式 `uri`，通过 `read_mcp_resource` 读取已列出的 URI 或展开后的模板。

每个操作都在调用 agent 的作用域中解析服务器。缺少服务器参数或服务器不可用时，会在派发前失败。连接所有者负责请求取消、超时与恢复；失败的请求仍表现为失败的工具调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

作用域注册表将连接所有者提供的操作接入一组共享工具，并向可选的系统提示词装配提供调用方可见的服务器名称。注册遵循 Cordis effect 生命周期，因此释放提供方会移除该注册，并显露任何同名的继承提供方。作用域解析发生在执行期间，早于提供方收到请求。

规范结果为程序化调用方保留完整 JSON。纯文本渲染器添加服务器归属信息，并将字符串值的 `blob` 字段替换为说明其 base64 长度的文字；URI、MIME 类型与文本字段仍保留在渲染后的 JSON 中。工具流水线负责记录结果。服务器指令归 MCP 客户端及其已记录的系统提示词段落所有。

| 源码 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 作用域提供方选择与服务器名称提示词上下文 |
| [`src/tools.ts`](src/tools.ts) | 共享资源操作与参数 schema |
| [`src/render.ts`](src/render.ts) | 带归属信息且不内联二进制载荷的文本投影 |

不发布 `./invariant` 配套入口：注册表没有暴露可能与提供方选择产生分歧的独立观测值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍服务器配置、执行机制与资源访问决策。

- [MCP 客户端](../mcp-client/README.zh.md)——服务器传输、指令与连接生命周期。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——规范值与模型可见结果。
- [资源与指令决策](../../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.zh.md)——作用域、按需访问及未纳入的机制。

-----

<a id="model-experience"></a>
## 模型体验

### 共享资源工具

#### 模型看到什么

[生成的工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-mcp-resources)定义了所有已配置服务器共享的三个工具。服务器连接或断开时，工具名称和 schema 不变；执行仍要求存在调用方可见的提供方。挂载系统提示词装配且存在可见提供方时，`MCP resource servers` 段落显示 `Use list_mcp_resources, list_mcp_resource_templates, or read_mcp_resource with one of these names as the server argument: <JSON array>.` 名称来自同一作用域注册表，包括既没有工具也没有指令的服务器。注册表为空时不贡献该段落。

#### Token 影响

挂载期间，三个定义带来固定的 schema 开销。服务器名称段落存在时，会添加按序排列的调用方可见名称 JSON 列表；资源列表和文档仅在操作返回后增加内容。

#### KV Cache 影响

定义形成稳定的重复前缀。挂载、卸载或更改这些工具可能替换请求中较早的 token。调用方可见的名称集合变化时，会更新服务器名称段及其可复用的提示词前缀；替换同名提供方不会改变该文本。

### 资源结果

#### 模型看到什么

成功结果以 `MCP server: <server>` 开头，随后是换行和返回的 JSON。每个字符串值的 `blob` 都变为 `[binary resource: <length> base64 characters; available to programmatic callers]`。服务器提供的文本、元数据与续传游标仍然可见。

#### Token 影响

渲染后的结果向工具历史添加文本。二进制说明文字替代载荷的 base64 token 开销；本包不设置额外的文本大小限制。

#### KV Cache 影响

每个结果追加到历史中，不改写此前的结果。后续读取可以返回已变化的服务器内容并追加不同结果；本包不会刷新此前已记录的内容。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

资源访问由显式调用按需发起。

- 不支持资源订阅与更新通知；再次调用列表或读取工具以获取当前内容。
- 二进制资源不会投影为原生图片或音频。程序化调用方保留其规范 base64 值。
- 调用方必须提供服务器名称。共享工具不会聚合不同服务器；分页遵循 MCP SDK。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
