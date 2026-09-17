---
description: "面向应用集成者的 Karaka HTTP 与 SSE 聊天操作、浏览器来源限制及交互投递说明。"
kind: "package-reference"
---
# @karaka-ai/transport-http

[English](README.md) | 中文

## 概述

后端应用可通过经过认证的 JSON 和 SSE 请求创建、恢复及订阅具有所有者限制的聊天。浏览器可使用独立的 JWT 认证端点，且必须明确配置允许的来源。聊天操作沿用 DSH Agent、Session 和持久化服务，Karaka 负责校验应用、租户和用户归属。不得针对同一应用数据存储暴露不受限制的 Host 远程接口。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在应用组合中挂载此插件，并提供服务器认证、身份、Agent、Session、Session 投影、查询、持久化、默认模型选择、LLM 路由、启动就绪通知及共享 Web 服务器。[SDK](package.json) 提供后端请求和事件类型。

独立挂载 `@karaka-ai/transport-http/startup`，并提供启动器的 `appReady`、`appExit` 服务及 Loader。[Karaka profile](../agent/cordis.patch.yml) 让 `webserver` 注入其 `karakaStartup` 服务，因此守卫缺失或加载失败会阻止必需的 Web 服务器启动。DSH 完成启动处理后，此守卫仅在所有已启用的 Loader 条目均处于活动状态时接收 HTTP 和浏览器请求；禁用的条目会被跳过。导入、激活、依赖解析或禁用表达式失败时，入口保持关闭，并请求以退出码 1 执行有时限的关闭。此守卫不会否决 DSH 启动器自身的就绪通知。这是启动检查，而非持续的服务健康监控。

后端 `path` 默认为 `/v1`，`maxBodyBytes` 默认为 1,048,576 字节。每个请求都通过 `serverAuth` 认证；应用身份来自凭证，请求体提供租户和用户标识符。无效凭证返回 401，所有权校验被拒绝时返回 403。应用就绪前请求返回 503。

设置 `browserPath` 以启用浏览器访问，提供非空的 `browserOrigins` 列表，并挂载[浏览器认证](../browser-auth/README.zh.md)。后端与浏览器路径不得重叠。`browserMethods` 选择应用操作，`browserEvents` 选择审批和问题投递；两个列表默认包含所有受支持条目。后端问题投递的 `handleQuestions` 默认为 true。

浏览器安全入口 `./browser` 导出 `createBrowserClient`。调用者需提供 HTTP(S) 服务器来源及可更新的凭证回调；其默认路径为 `/karaka/browser`。各客户端独立拥有凭证、聊天作用域监听器和连接观察器。`reconnect()` 更新连接，`dispose()` 等待连接及回调清理完成。签名中的归属信息控制交互投递，凭证过期时浏览器流关闭。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>所有权与持久化接收</summary>

聊天创建先保留持久化 Karaka 身份，再创建 DSH Agent。发布前的设置过程绑定头部、挂载所选预设并安装模型选择钩子。创建和提示接收只在持久化就绪后确认。恢复过程在激活 Agent 前校验持久化数据，并在设置期间检查重建后的 Session。变更按聊天串行执行。仅供 Host 使用的 [Session 投影](src/application-state.ts) 恢复请求接收记录和模型选择状态，并根据已提交事件更新它们。请求 ID 在聊天生命周期内保留，以拒绝重复接收。

历史查询和先发送快照的流均校验请求中的所有者。取消操作保留收件箱。模型变更追加已有的 DSH 模型选择事件。[应用操作](src/application.ts)、[HTTP 帧处理](src/http.ts)和[浏览器路由](src/browser-routes.ts)负责这些行为。

本包不发布运行时不变量伴随模块：HTTP 请求和监听器没有独立的生命周期事件流；Session 所有权由身份服务检查，持久化序列连续性在订阅投递时强制校验。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 已接收的聊天输入

#### 模型看到的内容

获授权的提示内容作为 `user/message` 内容进入普通 DSH 持久化收件箱。预设提供角色和工具，已有的 DSH 模型选择钩子处理模型变更。应用身份与 HTTP 认证不会添加模型可见文本。

#### Token 影响

接收的用户内容产生正常的模型输入成本。授权、HTTP 帧及重复请求确认不会增加提示词元。

#### KV Cache 影响

新用户输入通过已有 Session 流水线追加。传输元数据不会改变可复用前缀；模型选择和预设变更保留 DSH 自身定义的缓存影响。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

使用者必须考虑以下流式传输和交互限制。

- 临时文本增量共用当前持久化游标，不推进重放位置。已完成的助手消息是权威记录；SDK 没有针对已取消或重试预览的逐次尝试回滚或重置事件。
- 待处理审批和问题仅保存在进程内，重启后不会保留。浏览器端点不实现 DSH 浏览器 Connection 协议。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

无。

</details>
