# Karaka

[English](README.md) | 中文

Karaka 是面向应用后端的持久化多 agent（智能体）服务器。每个具名 agent 都是一个 DeepSeek Harness Agent Preset，其 Cordis 插件组合提供提示词、工具、skill（技能）、模型行为和其他运行时能力。

应用后端使用 `@karaka/sdk` 向 Karaka 认证、与可用 agent 聊天，并将应用函数暴露为带认证的 MCP 工具。Karaka 独立运行，保存持久化聊天状态，并且只调用该 agent 选中的应用工具。

Karaka 构建于开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 之上，该项目由 [DeepSeek AI](https://deepseek.com) 开发。Karaka 保留了由 [Cordis](https://github.com/cordiverse/cordis) 驱动的 Harness **一切皆插件**架构。

## 工作方式

```text
Application backend                         Karaka process
@karaka/sdk chat client  -- HTTP / SSE -->  named Agent Preset
@karaka/sdk MCP tools     <--    MCP    --  selected application tools
```

应用负责认证自己的用户，并发送可信的租户与用户标识。Karaka 认证应用服务器，把这些标识绑定到持久化聊天，并在 agent 调用应用工具时转发它们。安装 SDK 不会启动进程或监听端口。

## 从这里开始

- [应用 SDK](packages/karaka/sdk/README.zh.md)——发送聊天请求，并将后端函数暴露为工具。
- [Karaka CLI](packages/karaka/cli/README.zh.md)——创建 agent 工作区并启动持久化服务器。
- [Karaka agent 运行时](packages/karaka/agent/README.zh.md)——查看默认服务器组合与安全策略。
- [架构](docs/architecture.zh.md#karaka-application-runtime)——了解 agent 定义、身份、持久化与进程所有权。
- [Karaka 包](packages/karaka/README.zh.md)——浏览完整包系列。

## 开发者预览

Karaka 及其继承的 Harness 运行时处于_开发者预览_阶段，并且可能进行破坏兼容性的变更。运行项目前，请阅读[安全说明](SAFETY.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

提交变更前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
