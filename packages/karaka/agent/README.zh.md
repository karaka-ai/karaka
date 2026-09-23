---
description: "Karaka 应用 profile、启动器以及公开的工具和浏览器入口，供使用 DSH 运行时的部署查阅。"
kind: "package-bundle"
---

# @karaka-ai/agent

[English](README.md) | 中文

## 概述

Karaka 提供归属应用的会话，并支持经过认证的服务端和浏览器访问。其应用 profile 将 DSH 智能体运行时与 Karaka 身份、认证、HTTP 和 MCP 包组合在一起。独立发布的 Karaka CLI 启动此 profile；部署补丁选择应用凭据和工具访问权限。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Karaka CLI 启动此包的 `karaka-agent` 可执行文件。该文件准备 `karaka` profile，再以 `--profile karaka` 启动同一安装中的 DSH CLI。可选的 `--config <path>` 参数向 DSH 提供 Cordis 补丁。数据目录优先采用 `KARAKA_HOME`，其次为 `DSH_HOME`，否则使用工作目录下的 `.karaka`。现有 profile 清单和补丁会保留。不包含此 bundle 或链接到其他安装的 profile 会被拒绝。

### 配置应用

[bundle 补丁](cordis.patch.yml) 组合完整应用，而非扩展 `dsh-base`。应用记录来自 `KARAKA_APPLICATIONS`；其凭据引用由 [server-auth](../server-auth/README.zh.md) 解析。DeepSeek 提供方通过共享的[凭据提供方](../../credentials/credentials-local/README.zh.md) 解析 `DEEPSEEK_API_KEY` 和端点。`KARAKA_MODEL` 选择默认模型。bundle 补丁中的声明式 `application` preset 通过 `KARAKA_PRESET_TOOL_ALLOW` 控制可用的应用工具。部署方可在 profile 补丁中添加或替换 `@deepseek-ai/dsh-agent-preset` 配置行。

`KARAKA_MCP_URL` 启用[应用 MCP 桥接](../mcp-application/README.zh.md)。端点允许/拒绝设置与 preset 权限共同约束工具。`KARAKA_BROWSER_AUTH` 启用[浏览器认证](../browser-auth/README.zh.md)；还必须通过 `KARAKA_BROWSER_ORIGINS` 配置浏览器来源。[HTTP 传输](../transport-http/README.zh.md) 定义公开路由和归属规则。

此 profile 显式禁用 `session-log-deepseek` 插件向请求附加 `dsh_session_log` 的功能。普通模型请求和本地 JSONL 持久化保持不变。部署方可在自己的 profile 补丁中，将该配置项的 `config.enabled` 设为 `true` 以启用此功能。

### 编写工具和浏览器客户端

工具插件从 `@karaka-ai/agent/tools` 导入 `defineTool`、`ToolArgsError` 及其编写类型。此入口重新导出服务端使用的 DSH 定义，保持运行时身份一致。它既不挂载插件，也不授予工具访问权限。preset 配置 `@karaka-ai/agent/tool-policy`；浏览器客户端导入 `@karaka-ai/agent/browser`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

清单中的 `dsh.bundle.patch` 指定完整的 profile 组合。[Profile 初始化](src/profile.ts) 保留现有部署文件，并要求包链接解析到选定的安装。[可执行文件](src/bin.ts) 将执行和信号交给 DSH。[打包参考](IMPLEMENTATION.md) 说明产物组装和集成测试范围。

此包不发布运行时 invariant companion：它提供组合和重新导出，各个组合插件负责自身的可变状态与不变量。Profile 文件和安装链接检查在 DSH 子进程启动前执行。

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

- [Karaka 包地图](../README.zh.md) — 应用集成职责。
- [Karaka 子系统](../../../docs/subsystems/karaka.zh.md) — 权限与集成 API。
- [应用启动](../../boot/app-boot/README.zh.md) — profile 组合与补丁顺序。
- [工具定义](../../core/tools/README.zh.md) — 工具注册、执行与呈现。

-----

<a id="model-experience"></a>
## 模型体验

### 应用系统提示

#### 模型看到什么

Profile 关闭默认的 Harness 身份与运行时上下文章节，并通过 `dsh-system-prompt` 提供以下 persona 前缀；`KARAKA_SYSTEM_PROMPT` 可替换它。组合的 preset 和工具负责其他模型上下文。

##### 默认应用 persona

```markdown
You are a helpful assistant. Use application tools when they can answer the request.
```

#### Token 影响

Persona 前缀以渲染后的文本形式进入系统消息。工具模式和结果按所选工具贡献 token；公开的重新导出模块不增加 token。

#### KV Cache 影响

Persona 文本参与请求前缀。改变它或选定的工具模式可能影响前缀缓存复用；DSH 的 system-prompt 和 tools 包负责请求组装。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 暂存的 npm 运行时面向使用 glibc 的 Linux x64；其他部署平台需要单独验证产物。
- 部署补丁必须使用当前 profile 的插件标识符和配置字段。
- Profile 初始化拒绝指向其他安装的现有链接；更新该链接属于部署操作。
- tools 入口不提供旧插件别名或 Session 归属字段；Karaka identity 负责应用权限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
