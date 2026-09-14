# Karaka

[English](README.md) | 中文

Karaka 是用于向应用添加持久化 agent（智能体）的自托管服务器。将后端或浏览器前端连接到具名 agent，流式接收响应，并让 agent 将选定的应用函数作为工具调用。

每个具名 agent 都是一个 Agent Preset：通过 Cordis 插件组合定义提示词、工具、skill（技能）与模型行为。Karaka 作为独立进程运行并保存持久化聊天状态；应用负责用户认证与业务授权。

## Karaka 提供的功能

- 绑定应用、租户与用户的持久化聊天。
- 拥有独立提示词、模型行为、skill 和允许工具的 Agent Preset。
- 用于聊天流与托管带认证 MCP 工具的后端 SDK。
- 使用应用后端所签发限时凭证的浏览器客户端。
- 由 Karaka CLI 启动、基于 profile 的 Agent 运行时。

## 工作方式

```text
Application backend                         Karaka process
@karaka-ai/sdk chat client  -- HTTP / SSE -->  named Agent Preset
@karaka-ai/sdk MCP tools     <--    MCP    --  selected application tools

Browser frontend                            Karaka process
@karaka-ai/agent/browser    -- HTTP / SSE -->  authenticated chat and events
```

后端集成使用 `@karaka-ai/sdk` 通过 HTTP/SSE（Server-Sent Events）聊天，并在应用现有的 HTTP 服务器上托管带认证的 MCP 工具。后端提供可信的租户与用户标识。Karaka 将这些标识绑定到聊天并转发给工具回调，由应用执行业务授权。安装 SDK 不会启动进程或监听端口。

浏览器集成使用 `@karaka-ai/agent/browser`，凭证由应用后端签发并设有有效期。每个凭证绑定应用、租户与用户身份；浏览器请求不能选择其他身份。认证与服务器配置详见[浏览器客户端设置](packages/karaka/transport-http)。

<a id="run"></a>
## 从这里开始

1. 使用 Karaka CLI（命令行界面）[创建 agent 工作区](https://github.com/karaka-ai/karaka-cli)。
2. [配置运行时](packages/karaka/agent)与各 agent 的插件，然后启动服务器。
3. 连接[应用后端](https://github.com/karaka-ai/karaka-sdk)或[浏览器前端](packages/karaka/transport-http)。
4. [暴露应用工具](https://github.com/karaka-ai/karaka-sdk)，并[选择各 agent 可用的工具](packages/karaka/mcp-application)。

组合、构建与部署限制详见[运行时实现指南](packages/karaka/agent/IMPLEMENTATION.md)。CLI 与 SDK 分别在独立仓库中维护。

## 技术基础

Karaka 构建于开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上，该项目由 [DeepSeek AI](https://deepseek.com) 开发，并保留由 [Cordis](https://github.com/cordiverse/cordis) 驱动的**一切皆插件**架构。Karaka 拥有自己的 `@karaka-ai/*` 包和 `karaka` CLI。

## 开发者预览

Karaka 及其继承的 Harness 运行时处于_开发者预览_阶段，并且可能进行破坏兼容性的变更。运行项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run-from-source"></a>
## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

提交变更前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
