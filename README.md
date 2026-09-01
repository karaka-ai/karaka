# Karaka

English | [中文](README.zh.md)

Karaka is a persistent, multi-agent server for application backends. Each named agent is a DeepSeek Harness Agent Preset whose Cordis plugin composition supplies its prompt, tools, skills, model behavior, and other runtime capabilities.

An application backend uses `@karaka/sdk` to authenticate with Karaka, chat with an available agent, and expose application functions as authenticated MCP tools. Karaka runs separately, keeps durable chat state, and invokes only the application tools selected by that agent.

Karaka builds on the open-source [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) developed by [DeepSeek AI](https://deepseek.com). It retains the Harness **everything-is-a-plugin** architecture powered by [Cordis](https://github.com/cordiverse/cordis).

## How it fits

```text
Application backend                         Karaka process
@karaka/sdk chat client  -- HTTP / SSE -->  named Agent Preset
@karaka/sdk MCP tools     <--    MCP    --  selected application tools
```

The application authenticates its users and sends trusted tenant and user identifiers. Karaka authenticates the application server, binds those identifiers to the durable chat, and forwards them when an agent invokes an application tool. Installing the SDK starts no process and opens no port.

## Start here

- [Application SDK](packages/karaka/sdk/README.md) — send chat requests and expose backend functions as tools.
- [Karaka CLI](packages/karaka/cli/README.md) — create an agent workspace and start the persistent server.
- [Karaka harness](packages/karaka/harness/README.md) — inspect the default server composition and security posture.
- [Architecture](docs/architecture.md#karaka-application-runtime) — understand agent definitions, identity, persistence, and process ownership.
- [Karaka packages](packages/karaka/README.md) — browse the complete package family.

## Developer preview

Karaka and its inherited Harness runtime are in _developer preview_ and may make compatibility-breaking changes. Review the [safety notice](SAFETY.md) before running the project.

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
