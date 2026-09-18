# Karaka 应用访问

[English](karaka.md) | 中文

Karaka 应用通过 DSH 配置档案验证用户身份、保留对话归属并提供应用工具。[包组文档](../../packages/karaka/README.zh.md)说明安装方法与包的组合方式。

## 归属与凭证

[身份模块](../../packages/karaka/identity/README.zh.md)将每个聊天绑定到应用、租户和用户。调用方恢复聊天前，持久化归属记录必须与会话头一致。[服务器认证](../../packages/karaka/server-auth/README.zh.md)通过已配置的凭证提供方解析服务器凭证；[浏览器认证](../../packages/karaka/browser-auth/README.zh.md)在传输层构造归属身份前验证签名用户凭证。

可信归属类型 [`ApplicationOwner`](../../packages/karaka/identity/src/owner.ts)组合带品牌的 `ApplicationId`、`TenantId` 和 `UserId` 值。[`AuthenticatedApplication`](../../packages/karaka/server-auth/src/index.ts)标识凭证匹配的服务器。[`BrowserCaller`](../../packages/karaka/browser-auth/src/index.ts)包含签名用户归属和以毫秒表示的令牌到期时间；传输层在到期时终止访问。

## 聊天与工具

[HTTP 传输](../../packages/karaka/transport-http/README.zh.md)使用这些可信归属身份执行聊天操作与浏览器交互。DSH Agent 与会话持久化负责执行和记录历史。[MCP 应用桥接](../../packages/karaka/mcp-application/README.zh.md)通过应用作用域策略准入工具，并在远程分发前验证工具参数。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkarakabrowserauth--browserauthentication"></a>

### `ctx.karakaBrowserAuth` — `BrowserAuthentication`

Verifies signed browser credentials without storing tokens or signing keys.

```ts cordis-catalog
/**
 * Verify signature, issuer, audience, owner claims, age, and issued lifetime.
 * @param credential - Complete compact JWT supplied by the browser.
 * @returns The signed owner and expiry, or undefined for invalid credentials.
 * @throws Errors unrelated to JWT validation.
 */
async authenticate(credential: string): Promise<BrowserCaller | undefined>
```

Source: [`packages/karaka/browser-auth/src/index.ts`](../../packages/karaka/browser-auth/src/index.ts)

<a id="ctxkarakaidentity--karakaidentity"></a>

### `ctx.karakaIdentity` — `KarakaIdentity`

A single process owns authority records for this root. Application ingress serializes complete create/admit operations through withChatLock. No ownership is inferred from request-supplied lineage or written into a DSH Session.

```ts cordis-catalog
/**
 * Validate materialized roots before routes and background tools become available.
 * @returns Resolution after existing original headers have warmed lineage lookup.
 */
async initialize(): Promise<void>

/**
 * Serialize one complete controller operation, including original engine calls.
 * @param id - Chat being changed.
 * @param operation - Non-reentrant operation.
 * @returns The operation's result after preceding operations have settled.
 */
async withChatLock<T>(id: SessionId, operation: () => Promise<T>): Promise<T>

/**
 * Reserve creation or authorize an existing root. Call inside withChatLock.
 * @param id - Caller-selected chat identity.
 * @param owner - Authenticated owner.
 * @returns Whether the controller must create or reuse the original Session.
 */
async reserve(id: SessionId, owner: ApplicationOwner): Promise<'create' | 'existing'>

/**
 * Bind the actual unpublished Session during the original Agent setup callback.
 * @param session - Original factory-created Session.
 * @param owner - Reserved owner.
 * @returns Resolution only after the immutable source binding is durable.
 */
async bind(session: Session, owner: ApplicationOwner): Promise<void>

/**
 * Complete creation only after original JSONL flush and durable authority agree.
 * @param session - Published original Session.
 * @param owner - Authenticated owner.
 * @returns Resolution after the application can acknowledge this chat.
 */
async markReady(session: Session, owner: ApplicationOwner): Promise<void>

/**
 * Authorize using read-only observation before calling original agents.resume.
 * @param id - Requested chat.
 * @param owner - Authenticated owner.
 * @returns Its observed original header; missing and foreign chats are denied.
 */
async authorize(id: SessionId, owner: ApplicationOwner): Promise<SessionHeader>

/**
 * Check the exact live or unpublished restored Session before an operation.
 * @param session - Original Session.
 * @param owner - Authenticated owner.
 * @returns Resolution after immutable binding and lineage checks.
 */
async authorizeSession(session: Session, owner: ApplicationOwner): Promise<void>

/**
 * Resolve trusted identity for tool execution, including background child Agents.
 * @param session - Executing original Session, never request-supplied metadata.
 * @returns Its root authority owner, or undefined for an ordinary DSH Session.
 */
async ownerOf(session: Session): Promise<ApplicationOwner | undefined>

/**
 * Observe a cold or live Session's owner without activating or repairing it.
 * @param id - Original Session identity selected by an authorized consumer.
 * @returns Its application owner, or undefined for missing/unowned Sessions.
 */
async ownerOfId(id: SessionId): Promise<ApplicationOwner | undefined>

/**
 * Synchronous catalog lookup from validated authority and runtime/persisted lineage.
 * Execution must still call ownerOf; an unresolved catalog grants no tools.
 * @param session - Original Session being composed or published.
 * @returns Known owner, or undefined when lineage has not been observed.
 */
ownerOfCached(session: Session): ApplicationOwner | undefined

/**
 * Reject new authority calls, await admitted operations settling, and close storage.
 * @returns Resolution after admitted operations settle and authority storage closes.
 */
async close(): Promise<void>
```

Types: [Session](session.zh.md) · [SessionHeader](persistence.zh.md) · [SessionId](core.zh.md)

Source: [`packages/karaka/identity/src/index.ts`](../../packages/karaka/identity/src/index.ts)

<a id="ctxkarakastartup--karakastartup"></a>

### `ctx.karakaStartup` — `KarakaStartup`

Application admission verdict; false before startup validation and during disposal.

Source: [`packages/karaka/transport-http/src/startup.ts`](../../packages/karaka/transport-http/src/startup.ts)

<a id="ctxserverauth--serverauth-abstract-seam"></a>

### `ctx.serverAuth` — `ServerAuth` (abstract seam)

Replaceable authentication used for both inbound chat and outbound tool traffic.

```ts cordis-catalog
/**
 * Verify an inbound authorization value.
 * @param authorization - complete inbound Authorization header.
 * @param signal - caller lifetime; aborting rejects the wait even if credential resolution continues.
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
