# Karaka 应用边界

[English](karaka-application.md) | 中文

Karaka 应用边界把可信后端服务器连接到持久 Agent Preset。入站聊天认证解析一个 `AuthenticatedApplication { applicationId }`；transport 将其与后端提供的租户和用户标识组合，并把原子 owner 记录在 Session 上。出站 MCP 认证在每次工具请求时为同一应用 id 解析凭据。

默认 provider 为两个方向使用可独立轮换的凭据引用。认证证明调用服务器，而不是终端用户：已认证应用负责提供正确的租户与用户身份。Session Controller 在每个聊天操作上强制执行最终 owner。

完整进程流程见 [Karaka 架构](../architecture.zh.md#karaka-application-runtime)，认证、应用工具 endpoint 和插件加载见 [`@karaka-ai/agent`](../../packages/karaka/agent/README.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxserverauth--serverauth-abstract-seam"></a>

### `ctx.serverAuth` — `ServerAuth` (abstract seam)

Replaceable authentication used for both inbound chat and outbound tool traffic.

```ts cordis-catalog
/**
 * Verify an inbound authorization value.
 * @param authorization - complete inbound Authorization header.
 * @param signal - caller lifetime; implementations must stop credential work when aborted.
 * @returns the authenticated application, or undefined when verification fails.
 */
abstract authenticate( authorization: string | undefined, signal?: AbortSignal, ): Promise<AuthenticatedApplication | undefined>

/**
 * Build outbound authorization for one application's MCP endpoint.
 * @param applicationId - authenticated application identity.
 * @param signal - outbound request lifetime.
 * @returns complete outbound Authorization header.
 */
abstract authorizeTools(applicationId: ApplicationId, signal?: AbortSignal): Promise<string>
```

Source: [`packages/karaka/server-auth/src/index.ts`](../../packages/karaka/server-auth/src/index.ts)
<!-- END GENERATED cordis-surface -->
