# Agent Note: Shared MCP extensions for Karaka

Status: implemented

English | [中文](2026-09-14-shared-mcp-extensions-for-karaka.zh.md)

## Problem

Karaka needs renewable HTTP credentials, verified invocation ownership, restricted catalogs and strict argument admission. Copying DSH's connection supervisor and rich result conversion to add these operations also duplicates reconnect, teardown and media behavior. Upstream fixes then need replay into two implementations and two sets of inherited tests.

## Decision

The [DSH MCP client](../../../../packages/mcp/mcp-client/README.md#programmatic-extensions) exposes optional programmatic transport and tool extensions through its existing package entry. Default plugin configuration retains its transport, registration and execution behavior. The shared package knows no Karaka application, tenant or user fields.

Tool preparation receives the original MCP descriptor, runs before catalog replacement and preserves public names and remote dispatch identity. Admission failure therefore retains the previous catalog. Metadata resolves for each execution before remote dispatch; a rejected authorization sends no request. Custom registration owns rollback and complete disposal of its published contributions. A custom transport factory creates a fresh transport for each connection attempt, leaving reconnect and closure to the shared supervisor.

Karaka owns authenticated HTTP transport, private catalog registration, inherited policy checks and its small schema-validation wrapper. The wrapper validates supported object schemas during preparation and arguments before supported calls reach the shared executor, preserving local `INVALID_ARGS` classification. Task-required tools retain the shared unsupported-task rejection. Connection supervision, protocol naming, rich result conversion and their inherited tests have one owner in DSH. [Upstream source record](../../../../packages/karaka/mcp-application/UPSTREAM.json) names the three shared implementation files carrying extensions and the local adapters.

The shared public MCP factory comes from [upstream PR #3304](https://github.com/deepseek-ai/deepseek-harness/pull/3304); the source record retains the exact original shared-adoption revision. The factory keeps its two-argument `call(args, signal)` API. Metadata-enabled discovery delegates each execution to that factory, capturing its trusted caller without a global caller variable or a signal-to-owner map. An execution-keyed WeakMap retains the matching delegate until finalization, so original schema, canonical result and image projection rules remain authoritative. Rejection removes that invocation’s delegate; finalization removes the retained delegate and forwards the final policy result unchanged. This cleanup releases projection references, not durable attachment bytes already saved by the factory.

This supersedes only the copied-MCP implementation decision in [Karaka authority](2026-09-12-karaka-authority-over-upstream-runtime.md). Its separate durable identity, unchanged Session formats and per-Agent authorization remain active. The [MCP feature note](../feature/2026-07-07-mcp-client-plugin.md) retains naming, protocol and result-projection rationale. The [workspace conformance note](../process/2026-09-14-karaka-workspace-conformance.md) owns compiler integration and the exact profile-bootstrap launcher classification.

## Alternatives considered

**Keep adapted copies to avoid any upstream implementation edits.** This minimizes touched upstream files but duplicates the runtime and inherited tests. Small generic extensions keep application policy local while giving reconnect and result fixes one implementation to update.

**Move Karaka authentication into the shared MCP plugin.** That makes DSH depend on fork-specific identity and credential services. Generic callbacks preserve ordinary DSH configuration and leave application authority with its owner.

**Validate schemas only during custom registration.** Registration follows disposal of the previous catalog. Rejecting an invalid replacement there loses the working catalog; preparation must finish during discovery instead.

## Testing

The shared [extension tests](../../../../packages/mcp/mcp-client/tests/extensions.spec.ts) exercise default metadata omission, authorization rejection before dispatch, preparation failure retaining a catalog, custom registration rollback and transport disposal. Original DSH MCP tests own ordinary protocol and reconnect behavior. Karaka's [application tests](../../../../packages/karaka/mcp-application/tests/application.spec.ts) exercise authenticated HTTP and scoped policy against the shared runtime; its schema-wrapper tests own local input admission.

## Consequences

Upstream replay must preserve the bounded MCP extension points, their exported types and default-path regressions. Karaka carries fewer runtime copies and tests its own adapters against the shared implementation. Consumers using the programmatic API own namespace coordination, startup failure policy and lifecycle registration; the ordinary Cordis plugin continues owning those duties for its configured use.

Application-local argument rejection and authorization remain distinct from remote failures: only the local checks establish that no request was dispatched. Shared callbacks do not add tenant or user fields to DSH durable formats or configuration.
