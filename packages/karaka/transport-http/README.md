---
description: "Authenticated Karaka HTTP and SSE chat operations, browser origins, and interaction delivery for application integrators."
kind: "package-reference"
---
# @karaka-ai/transport-http

English | [中文](README.zh.md)

## Summary

Backend applications can create, resume and follow owner-scoped chats through authenticated JSON and SSE requests. Browsers can use a separate JWT-authenticated endpoint with explicit allowed origins. Chat operations retain DSH Agents, Sessions and persistence, while Karaka checks application, tenant and user ownership. Do not expose unrestricted Host remotes against the same application data store.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in the application composition with server authentication, identity, Agents, Sessions, Session projections, queries, persistence, default-model selection, LLM routing, launcher readiness and the shared web server. The [SDK](package.json) supplies the backend request and event types.

Mount `@karaka-ai/transport-http/startup` independently with the launcher's `appReady` and `appExit` services and the Loader. The [Karaka profile](../agent/cordis.patch.yml) makes `webserver` inject its `karakaStartup` service, so a missing or failed guard prevents the required web server from starting. After DSH settles startup, this guard admits HTTP and browser requests only if every enabled Loader entry is active; disabled rows are skipped. Failed imports, activation, unresolved dependencies or disabled expressions keep ingress closed and request bounded exit with code 1. DSH launcher readiness itself is not vetoed. This is a startup check, not continuous service-health monitoring.

The backend `path` defaults to `/v1`, and `maxBodyBytes` defaults to 1,048,576 bytes. Each request authenticates through `serverAuth`; the application identity comes from the credential, while the body supplies tenant and user identifiers. Invalid credentials return 401; rejected ownership returns 403. Requests return 503 until application readiness.

Set `browserPath` to mount browser access, provide a nonempty `browserOrigins` list, and mount [browser authentication](../browser-auth/README.md). Backend and browser paths must be disjoint. `browserMethods` selects application operations; `browserEvents` selects approval and question delivery. Both lists default to all supported entries. `handleQuestions` defaults to true for backend question delivery.

The browser-safe `./browser` entry exports `createBrowserClient`. Supply an HTTP(S) server origin and a renewable credential callback; its default path is `/karaka/browser`. Clients own their credentials, chat-scoped listeners and connection observers. `reconnect()` renews the connection; `dispose()` waits for connection and callback teardown. Signed ownership controls interaction delivery, and browser streams close when credentials expire.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Ownership and durable admission</summary>

Chat creation reserves durable Karaka identity before creating a DSH Agent. Unpublished setup binds its header, mounts the selected preset and installs model-selection hooks. Creation and prompt admission acknowledge only after durable readiness. Resume authorizes persisted data before activating the Agent and checks its reconstructed Session during setup. Mutations serialize per chat. A host-only [Session projection](src/application-state.ts) restores request receipts and model-selection state and updates them from committed events. Request IDs remain retained for the chat lifetime to reject duplicate admission.

History and snapshot-first streams authorize the requested owner. Cancellation retains the inbox. Model changes append the existing DSH model-selection event. [Application operations](src/application.ts), [HTTP framing](src/http.ts), and [browser routes](src/browser-routes.ts) own these behaviors.

No runtime invariant companion is published: HTTP requests and listeners have no independent lifecycle event stream; Session ownership is checked by the identity service, and durable sequence continuity is enforced during follow delivery.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Admitted chat input

#### What the model sees

Authorized prompt content enters the normal DSH durable inbox as `user/message` content. Presets supply persona and tools; existing DSH model-selection hooks supply model changes. Application identity and HTTP authentication add no model-visible text.

#### Token effect

Admitted user content incurs its normal model-input cost. Authorization, HTTP framing and duplicate request acknowledgments add no prompt tokens.

#### KV Cache effect

New user input appends through the existing Session pipeline. Transport metadata does not change the reusable prefix; model selection and preset changes retain their DSH-owned cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Consumers must account for these streaming and interaction limits.

- Transient text deltas share the current durable cursor and do not advance replay position. Settled assistant messages are authoritative; the SDK has no per-attempt rollback/reset event for cancelled or retried previews.
- Pending approvals and questions are process-local and do not survive restart. The browser endpoint does not implement the DSH browser Connection protocol.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
