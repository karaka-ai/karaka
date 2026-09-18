# Karaka application access

English | [中文](karaka.zh.md)

Karaka applications authenticate users, retain ownership of conversations, and expose application tools through DSH profiles. The [package group](../../packages/karaka/README.md) describes installation and package composition.

## Ownership and credentials

[Identity](../../packages/karaka/identity/README.md) binds each chat to an application, tenant and user. Durable ownership records and the session header must agree before a caller can resume the chat. [Server authentication](../../packages/karaka/server-auth/README.md) resolves server credentials through the configured credential provider; [browser authentication](../../packages/karaka/browser-auth/README.md) verifies signed user credentials before the transport constructs an owner.

The trusted owner type, [`ApplicationOwner`](../../packages/karaka/identity/src/owner.ts), combines branded `ApplicationId`, `TenantId` and `UserId` values. [`AuthenticatedApplication`](../../packages/karaka/server-auth/src/index.ts) identifies the server whose credential matched. [`BrowserCaller`](../../packages/karaka/browser-auth/src/index.ts) adds the signed user owner and token expiration in milliseconds; the transport ends access at that expiration.

## Chat and tools

[HTTP transport](../../packages/karaka/transport-http/README.md) uses those trusted owners for chat operations and browser interactions. DSH Agents and session persistence own execution and recorded history. The [MCP application bridge](../../packages/karaka/mcp-application/README.md) admits tools through application-scoped policy and validates their arguments before remote dispatch.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.md) · [SessionHeader](persistence.md) · [SessionId](core.md)

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
