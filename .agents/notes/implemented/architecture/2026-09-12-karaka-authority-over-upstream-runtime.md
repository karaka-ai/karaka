# Agent Note: Karaka authority over the unchanged upstream runtime

Status: implemented

English | [中文](2026-09-12-karaka-authority-over-upstream-runtime.zh.md)

## Problem

Karaka needs application, tenant and user isolation for persistent chats and application tools. Placing those fields in DSH Session headers forces changes through strict format codecs and consumers. Copying every dependent package makes upstream maintenance larger without proving that any copied implementation needs different behavior.

## Decision

The Karaka application profile reuses DSH Session, Agent, loop, Tools, JSONL, query and model implementations. A distinct identity service stores durable authority outside Session files using original JSON storage/domain APIs. A kernel-held lock admits one authority writer per root. Creation reserves identity, binds the actual unpublished Session during awaited setup, and acknowledges only after authority and Session persistence complete. Cold access authorizes before engine resume. Child authority follows validated persisted parent lineage.

Karaka HTTP operations call the original engine through its public APIs. The profile uses the upstream DSH launcher; its readiness notification starts the independent [Karaka startup guard](../../../../packages/karaka/transport-http/src/startup.ts). The guard requires every enabled Loader entry to be active before admitting backend or browser requests. Failed imports, activation, pending dependencies and throwing disabled expressions keep admission closed and request bounded process exit with code 1. Effective disabled rows remain optional. Webserver injection makes failure of the guard itself fatal through DSH’s existing required-entry policy. The separately maintained SDK consumes these routes without embedding another Session implementation.

The Karaka MCP package owns its application catalog. Connection supervision and rich result conversion use the shared DSH implementation through [programmatic extensions](2026-09-14-shared-mcp-extensions-for-karaka.md), whose decision supersedes the copied-MCP portion of this note. [Provenance](../../../../packages/karaka/mcp-application/UPSTREAM.json) records the shared code and owned adapters. No dependency implementation is copied. Application tools register in each eligible Agent scope, are absent globally, and require both endpoint permission and explicit preset allow, with deny precedence across inherited scopes. Omitted or deny-only policy does not grant application tools; ordinary tool restrictions and presentation remain upstream implementations. Each outgoing request resolves current credentials; each execution obtains trusted identity from the actual Agent. HTTP redirects are rejected for credential-bearing MCP requests.

The MCP bridge admits only supported object-rooted input schemas and validates arguments with the original DSH helpers before dispatch. A local `ToolArgsError`/`INVALID_ARGS` proves no application callback ran, allowing a quota policy to admit a corrected proposal. Remote errors do not establish that an operation had no effect. Local plugins obtain the same tool definitions, error class and authoring types through `@karaka-ai/agent/tools`.

The profile and implementation boundary are described in the [runtime note](../../../../packages/karaka/agent/IMPLEMENTATION.md). This decision adds Karaka behavior and supersedes no active upstream Agent Note; DSH's released format and original plugin contracts remain intact.

## Alternatives considered

**Replace Session and connected consumers.** No required engine change was established. Public setup, persistence and scoped registration APIs support this application flow without a duplicate Session class or copied reverse-dependency tree.

**Add ownership to DSH JSONL headers.** That changes a strict released format and its codec/catalog chain. Separate authority retains upstream formats at the cost of a second durable artifact in backups.

**Use stock MCP configuration for application tools.** Static HTTP headers and ordinary Tools registration do not provide renewable credentials, trusted execution metadata or a private application catalog. The [shared extension decision](2026-09-14-shared-mcp-extensions-for-karaka.md) owns programmatic reuse with these application requirements.

## Consequences

Core engine updates retain original Session, Agent, loop and Tools implementations. Karaka maintains its authority and application adapters; the shared MCP package carries the generic extensions described in the linked decision. Ownership and Session files form one application backup; a Session JSONL file alone does not establish application ownership. Publication spans two files rather than a cross-file transaction, so ordering and recovery are part of the authority contract.

The built local artifact includes the separately maintained CLI, canonical built upstream packages and Karaka adapters. Its installed dependency and required-peer graph uses only internal links, preserving one runtime identity per upstream workspace package without registry re-resolution. Application browser routes require explicit JWT verification and origin configuration; the browser facade supports history, prompt, follow and scoped interactions. Per-preset application tools require explicit opt-in.

The current profile exposes selected Karaka entry points. Plugin selection controls exposure; additional workspace plugins and their explicit user/workspace access integration are outside this release. A separate server is not the default requirement. Worker identity, cross-chat tools, full rendered browser UI and image upload remain outside the executed scenario. Child/reference adapters and broader browser interactions require further evidence; one application flow does not establish full product parity. Other native platforms and registry publication are separate work. The server draft replaces the old fork tree with the selected DSH baseline and this Karaka overlay; it does not claim every old customization was ported. The old fork CI and deployment configuration have not been reconciled with this application profile.

## Testing

Startup guard ordering, nested Loader traversal, effective disabled expressions and ingress readiness were reviewed against source. No startup tests or builds were run under the user's no-tests constraint; runtime startup/shutdown behavior remains unverified.

The sole authorized end-to-end scenario passes after clean installation of the three staged 0.1.2-alpha.4 npm tarballs, launched through the separately built CLI: SDK authentication and chat creation, real DSH model/tool execution, persisted restart, browser-facade history/prompt/follow continuation, and wrong-owner SDK denial. The server tarball contains 501 bundled package names; the local artifact from which it was staged contains 515 canonical packages with no external links. The original DeepSeek provider sends three requests to a deterministic local HTTP model fixture; the separately built SDK hosts the one authenticated MCP tool invocation. This is not a live DeepSeek result. The browser facade runs under Node with an explicit Origin fixture; it does not render the product UI.

Evidence is recorded in `/tmp/karaka-application-flow-jZS1P4/evidence.json` and retained by the updater at `work/reuse-implementation/evidence.json`. Dependency installation, native-addon build, runtime/browser bundles and public declaration emission prepare execution. The [workspace conformance](../process/2026-09-14-karaka-workspace-conformance.md) and [shared MCP extension](2026-09-14-shared-mcp-extensions-for-karaka.md) notes own package integration and shared-runtime verification beyond this artifact scenario. Release artifacts are staged; registry publication is tracked separately. Broader recovery, concurrency, child/worker and browser behavior remain unverified by this scenario.
