---
description: "用于带认证 Karaka 聊天调用，以及在现有应用 HTTP 服务器上托管 MCP 工具的后端库。"
kind: "package-library"
---

# @karaka/sdk

[English](README.md) | 中文

## 概述

`@karaka/sdk` 让应用后端可以与运行中 Karaka 服务器里的 agent（智能体）聊天，并将应用函数暴露为带认证的 MCP 工具。`createKarakaClient()` 负责出站 JSON/SSE 调用；`createKarakaToolHost()` 负责显式工具注册表以及用于现有 Node HTTP 路由的 handler。SDK 不启动进程、不监听端口，也不依赖 Cordis、Agent、Session 或 Harness 运行时。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@karaka/sdk` 和 `zod` 声明为应用依赖，然后在已经认证用户并拥有业务操作的后端中导入 SDK。通过 `@karaka/cli` 单独运行 Karaka 服务器；不要在 `cordis.yml` 中挂载 SDK。

### 与 agent 聊天

创建一个部署客户端，再为每个后端请求绑定可信的租户与用户身份：

```ts
import { createKarakaClient } from '@karaka/sdk'

const karaka = createKarakaClient({
  endpoint: process.env.KARAKA_ENDPOINT!,
  chatToken: () => process.env.KARAKA_CHAT_TOKEN!,
})

const user = karaka.forUser({ tenantId: 'tenant-1', userId: 'user-1' })
const chat = await user.chats.create({ agentId: 'support' })

await user.chats.send({ chatId: chat.chatId, content: 'Help me with an invoice' })

for await (const event of user.chats.stream({ chatId: chat.chatId })) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
  if (event.type === 'turn-end') break
}
```

在创建聊天前，使用 `agents.list()` 发现可用 agent。绑定后的客户端还可以读取历史记录、取消轮次、选择模型和回复结构化交互。可选的客户端 `path` 默认为 `/v1`，并且必须与 Karaka HTTP transport 一致。

### 暴露应用工具

显式注册每个可调用函数，并导出 handler，供应用服务器挂载到自己的路由：

```ts
import { createKarakaToolHost } from '@karaka/sdk'
import { z } from 'zod'

const echoInput = z.object({ text: z.string() }).strict()
const toolHost = createKarakaToolHost({
  verifyToken: () => process.env.KARAKA_TOOL_TOKEN!,
})

toolHost.registerTool('support_echo', {
  description: 'Echo text for support diagnostics',
  inputSchema: echoInput,
}, (input, context) => {
  const { text } = echoInput.parse(input)
  return { content: [{ type: 'text', text: `${context.userId}: ${text}` }] }
})

export const karakaMcpHandler = toolHost.expressHandler()
```

把 `karakaMcpHandler` 挂载到应用路由，并在 Karaka 中将该路由配置为 Streamable HTTP MCP endpoint。Karaka 在发现和调用前执行认证，回调会接收可信的 `{ applicationId, tenantId, userId, chatId, signal }` 上下文。回调仍必须执行应用的业务授权。应用关闭时调用 `toolHost.close()`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部机制——点击展开</summary>

客户端在返回每个 JSON 响应和 SSE 事件前进行验证。`forUser()` 创建身份绑定视图，而不保存进程全局的当前用户。工具主机认证每个 MCP 请求，为该请求创建隔离的无状态 MCP 服务器，验证对象根 Zod 输入，并在模型生成的参数之外提供调用身份。

| 文件 | 职责 |
|---|---|
| [`src/client.ts`](src/client.ts) | 带认证聊天客户端与 SSE 解析 |
| [`src/tools.ts`](src/tools.ts) | 工具注册表、服务器认证与 Node HTTP handler |
| [`src/protocol.ts`](src/protocol.ts) | 与服务器 transport 共享、经过运行时验证的 JSON/SSE 协议 |
| [`src/types.ts`](src/types.ts) | 公共工具与身份类型 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Karaka 概述](../../../README.zh.md)——了解应用与服务器进程。
- [Karaka 包导航](../README.zh.md)——查找与 SDK 配套的服务器端包。
- [应用运行时架构](../../../docs/architecture.zh.md#karaka-application-runtime)——跟踪身份、聊天与工具流量如何跨越进程。
- [服务器认证](../server-auth/README.zh.md)——配置两个方向使用的凭据。
- [应用 MCP 桥接](../mcp-application/README.zh.md)——为 Agent Preset 选择 SDK 托管的工具。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 Karaka 应用 MCP 插件呈现 Agent Preset 选中的已注册工具。

#### KV Cache 影响

改变已选工具的名称、描述或 schema 会改变该 agent 的工具 schema 请求前缀；聊天客户端操作本身不添加模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅 Node HTTP 适配器**——工具主机支持兼容 Express 的 handler 与 Next.js Pages API 路由；不包含 Fetch 原生路由适配器。
- **一种 HTTP transport**——聊天使用 JSON 和 SSE；其他应用 transport 需要对应的 SDK 与服务器实现。
- **受限的输入 schema 词汇**——`inputSchema` 必须能投影为 DSH 强制执行的对象根 JSON Schema 子集。支持标量类型、对象属性、必填字段、数组、enum/const 与 `oneOf`；字符串长度、数值范围、pattern 和 format 等约束会在 Karaka 连接 MCP endpoint 时被拒绝，并报告对应 schema 路径。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>

无。

</details>
