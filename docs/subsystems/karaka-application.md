# Karaka Application Boundary

English | [中文](karaka-application.zh.md)

The Karaka application boundary connects a trusted backend server to persistent Agent Presets. Inbound chat authentication resolves one `AuthenticatedApplication { applicationId }`; the transport combines it with backend-supplied tenant and user identifiers and records the atomic owner on the Session. Outbound MCP authentication resolves a credential for the same application id on every tool request.

The default provider uses independently rotatable credential references for the two directions. Authentication proves the calling server, not the end user: the authenticated application is responsible for supplying correct tenant and user identity. Session Controller enforces the resulting owner on every chat operation.

See the [Karaka architecture](../architecture.md#karaka-application-runtime) for the complete process flow and [`@karaka-ai/agent`](../../packages/karaka/agent/README.md) for authentication, application tool endpoints, and plugin loading.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
