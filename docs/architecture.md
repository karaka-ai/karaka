# Architecture

English | [中文](architecture.zh.md)

Karaka is a configurable, Cordis-based foundation for composing agentic SaaS runtimes. Stable capability seams define what the runtime can do, provider plugins decide how and where infrastructure work is done, and application configuration selects the product that runs. A backend-mounted tool-host plugin can turn decorated methods on framework-managed services into agent tools without requiring developers to author one plugin per method.

The repository publishes nine packages that form the composition kernel. Seam contracts, providers, and advanced extensions live in separately installable plugins built on that kernel. Authentication, an overall-spend Entitlement seam, provider-neutral Storage with a persistent local provider, an initial Agent Runtime with durable sessions, and setup-YAML process bootstrap exist today. The agent plugin model, tool authoring and hosting APIs, Chat API, subagent coordination, and Transport seam described below are target architecture unless stated otherwise.

## Foundation boundary

`@karaka/cosmokit` supplies small utilities. `@karaka/schemastery` supplies configuration schemas. `@karaka/cordis` owns contexts, services, events, fibers, effects, and dependency tracking.

The composition plugins build on that kernel: Loader imports configured plugins; Include reads YAML or JSON entry lists; Group nests entries; Timer owns disposable scheduling; HMR reloads modules and exact configuration paths; Logger Console renders Cordis logs. Include technically supports JSON, but the normal Karaka contract exposes one setup YAML. JSON and direct Cordis composition are low-level facilities for internals and advanced plugin authors.

Infrastructure capabilities belong above this foundation in first-party, third-party, or private plugins. Karaka may publish contracts, standard agent behavior, and useful providers, but a first-party implementation has no privileged runtime path. Application-owned methods can use Karaka's tool decorator and remain ordinary backend code. The `vendor/` packages remain independent of any particular application, provider, deployment target, or SaaS SDK.

Every configurable or executable runtime behavior must be mounted as a Cordis plugin. Karaka must not introduce a parallel manager, registry, discovery daemon, lifecycle system, or privileged hard-coded behavior. Principals, chats, messages, model responses, and invocation payloads are runtime data rather than plugins; every component that interprets, validates, routes, persists, or acts on that data is a plugin.

## One setup YAML, ordinary agent plugins

The normal developer contract has one **setup YAML** containing everything needed to assemble the runtime: installed seams, providers, transports, credential references, policy, storage, and agent plugin modules. An agent or subagent is an ordinary TypeScript or JavaScript Cordis plugin, not a second YAML document or a special object outside Cordis.

The plugin owns its prompt, logical model and session references, allowed tool IDs, skills, delegation relationships, and any child contributions. Those values may come from versioned files or helper modules, but the agent plugin performs the effect-owned registration. Agents and subagents run through the same Agent Runtime path and never embed endpoints or process counts.

```mermaid
flowchart TB
  Setup["Setup YAML<br/>runtime and providers"]
  Agents["Agent plugin modules<br/>agents and subagents"]
  AgentLoader["Karaka process Loader"]
  AgentGraph["Karaka-process<br/>Cordis graph"]
  Discovery["Authenticated tool-host discovery"]
  ServiceGraphs["Independent backend<br/>tool-host graphs"]

  Setup --> AgentLoader
  Agents -->|referenced by setup| AgentLoader
  AgentLoader --> AgentGraph
  ServiceGraphs --> Discovery
  Discovery --> AgentGraph
```

Setup and agent modules use one composition model: plugins and effect-owned contributions. Each process owns its own Cordis context and graph. An embedded deployment may mount the application tool-host plugin and Agent Runtime in one graph. Independently deployed backends bootstrap their own small tool-host graphs from a framework-specific plugin and application configuration; they do not need to share Karaka's setup YAML or repository. The authenticated manifest and invocation protocols connect those graphs.

The following illustrative partial setup fragment selects providers, discovers remote tool hosts, and mounts agent plugins. Provider names and configuration shapes are planned, not current API:

```yaml
- name: '@karaka/authentication'
- name: '@karaka/authentication/authentication-jwks'
- name: '@karaka/entitlement'
- name: '@company/entitlement-ledger'
- name: '@karaka/storage-postgres'
- name: '@karaka/transport/http'
- name: '@karaka/tool/discovery-kubernetes'
  config:
    selector:
      karaka.ai/tool-host: 'true'
- name: '@karaka/agent-runtime'
- name: './plugins/company-authentication-policy'
- name: './agents/support-agent.js'
- name: './agents/billing-agent.js'
```

Each agent module is a normal plugin whose registrations belong to that plugin's lifecycle:

```ts
import type { Context } from '@karaka/cordis'

export default {
  name: 'support-agent',
  inject: ['agentRuntime', 'agentModels'],
  apply(ctx: Context) {
    ctx.agentRuntime.registerAgent({
      id: 'support',
      prompt: 'You are a helpful support agent.',
      model: 'support-model-policy',
    }, ctx.agentModels)
  },
}
```

Loader imports the agent module exactly like every other configured plugin. Agent Runtime validates and indexes its effect-owned descriptor but does not interpret an agent-specific YAML language or create a parallel lifecycle. Prompt, model, session, tool, skill, delegation, and child-plugin contributions therefore share normal Cordis dependency ordering, isolation, disposal, and replacement. Removing or reloading the agent plugin reverses its registrations. Direct programmatic Cordis composition remains available for Karaka internals, tests, embedded integrations, and advanced plugin authors, but setup YAML is the normal deployment surface.

## Capability seams

Add an infrastructure or shared runtime capability as three independently replaceable roles:

1. A **service definition** owns the stable name and consumer-facing contract.
2. One or more **provider plugins** implement that contract.
3. **Consumer plugins** depend on the service name instead of importing a provider.

For example, a storage contract may be available as `ctx.storage`. One deployment can install a PostgreSQL provider and another an S3 provider while the same artifact, session, and billing consumers continue to use `ctx.storage`.

An application selects providers through its plugin composition. Cordis dependency tracking starts a consumer only when its required services exist. If a provider disappears or is replaced, Cordis disposes the dependent consumer and starts it again against the new implementation.

```mermaid
flowchart LR
  Contract["Stable service contract<br/>ctx.storage"]
  ProviderA["PostgreSQL provider plugin"]
  ProviderB["S3 provider plugin"]
  Consumer["Consumer plugin"]

  ProviderA -->|implements| Contract
  ProviderB -->|implements| Contract
  Consumer -->|injects| Contract
```

The contract must describe the capability, not a provider or consumer. Provider-specific configuration stays with the provider plugin. Consumer-specific workflow stays with the consumer plugin.

Karaka-provided and user-provided plugins use the same contract. Anything a first-party plugin can register, an advanced plugin author must be able to register through the public seam with an ordinary Cordis plugin. Karaka authoring helpers and direct Cordis plugins must receive identical dependency tracking, scoping, effects, disposal, and replacement behavior.

## Top-level seams

Karaka has seven top-level application seams. A seam is an architectural boundary composed from multiple Cordis plugins; it is not necessarily one service or one package. Models, sessions, tools, skills, agents, and subagents are parts of **Agent Runtime**, not peer top-level seams.

| Top-level seam | Responsibility | Example plugin families |
| --- | --- | --- |
| Authentication | Authenticate requests and resolve users, tenants, services, and agents | Provider registry, JWKS verifier, trusted-host identity, user-authored providers and policy |
| Authorization | Decide whether a principal may perform an action on a resource | Contract, policy engines, role or relationship providers, enforcement plugins |
| Entitlement | Track and enforce an account's overall accumulated model spend | Contract, in-memory development provider, durable ledger providers |
| Storage | Store application data independently of a backend | Contract, local SQLite provider, PostgreSQL/S3/GCS providers, private storage providers, storage policy |
| Transport | Expose Karaka's application API without binding it to a wire protocol | Contract, in-process and HTTP adapters, streaming and cancellation plugins |
| Observability | Record operational and audit information | Contract, OpenTelemetry/Datadog exporters, audit and usage plugins |
| Agent Runtime | Run and coordinate model-driven work | Model adapters, sessions, tool registry and tools, skills, agent loop, agent registry, subagent registry and providers |

Each deployment composes the plugins it needs within every seam. Karaka publishes useful defaults as ordinary first-party plugins, while an application can add or replace them through the same Cordis contracts. In particular, a standard agent bundle can compose the default loop, session coordination, tool-call handling, user interaction, delegation, child control, skill resolution, cancellation, and runtime events without hard-coding those behaviors into Agent Runtime. Ordinary backend methods use the tool decorator described below and do not require developers to author one plugin per method.

## Overall-spend entitlement

Entitlement has one narrow meaning in Karaka: whether an overall spend account may continue consuming metered models. `ctx.entitlement` exposes the provider-neutral account status and actual-spend recording contract. It does not understand application plans, subscriptions, features, model-call counts, or per-call budgets.

Amounts are non-negative integers in an explicit unit such as `USD_MICRO` or `CREDIT`; floating-point currency is never used. Model provider plugins own model-specific pricing and report the actual spend of a completed generation. Agent Runtime checks that the selected overall account is not already exhausted before calling a metered model, then records the provider-reported spend. Image, audio, video, cached-token, and text pricing therefore remain model-provider concerns rather than conversions invented by Entitlement.

The current low-level transient Agent Runtime request names the overall entitlement account but carries no amount or call budget. Durable sessions derive that account from trusted identity and stored chat state rather than model-visible input. Because this first slice deliberately has no reservation, one completed call may take accumulated spend past its limit; later calls are rejected. Atomic reservation and settlement may be added later without changing the meaning of entitlement into a per-call agent policy.

`@karaka/entitlement` supplies the service contract. One provider plugin is active in a Cordis graph, while arbitrary account IDs remain runtime data resolved by that provider. `@karaka/entitlement/local` is an ordinary, effect-owned provider for development and tests; it lazily creates accounts with one configured default limit. Its state is process-local and not a production ledger. Durable or billing-backed implementations remain replaceable provider plugins through the same contract.

## Durable storage

`@karaka/storage` exposes one active provider for namespaced, versioned JSON records. Consumers read and create records or replace an expected version; the compare-and-swap rule prevents silent lost updates without making the contract depend on SQL, files, sessions, or another consumer. Provider plugins are effect-owned, while record keys and values remain ordinary runtime data.

`@karaka/storage/default` is an ordinary bundle plugin that mounts the contract and `@karaka/storage/local`, using `./.karaka/storage.sqlite` unless setup overrides the path. Remote SQLite-compatible services remain separate provider plugins because their transport, credentials, and lifecycle differ; provider placement is selected by plugin composition, not a local-or-remote mode inside one plugin.

`@karaka/agent-runtime/session-storage` is an ordinary Agent Runtime consumer plugin: it persists the canonical tenant and user owner, agent ID, overall-entitlement account reference, and model-visible message history. It resolves `currentPrincipal()` for every durable operation and refuses a chat owned by another principal. A resumed turn resolves the stored agent ID against the current Cordis graph; no composition version is stored or pinned.

## Authentication and invocation identity

`ctx.authentication` is a long-lived provider registry and tenant-aware authentication service. An authenticated principal is short-lived invocation data, not a Cordis service and not a plugin mounted for each caller. Karaka resolves the principal at its runtime boundary and carries it through the chat turn internally. Application code and model-visible tool arguments must not choose the effective caller.

Karaka ships two ordinary plugins for the first trust models:

| Plugin | Trust boundary | Result |
| --- | --- | --- |
| `@karaka/authentication/authentication-jwks` | Karaka receives a bearer token and verifies it against preconfigured tenant JWKS policy | Returns a verified provider-neutral identity through `ctx.authentication.authenticate(...)` |
| `@karaka/authentication/authentication-host` | The embedding host has already authenticated the caller and exposes its current principal through a trusted adapter | Resolves a provider-neutral identity with `provider: 'host'` |

The `authentication-host` plugin registers the once-mounted invocation resolver described here. It does not establish a caller-specific Cordis service or require one plugin instance per request.

The host plugin is the common shared-process and local-development path. A single-identity development deployment may select a trusted static assertion from YAML:

```yaml
- name: '@karaka/authentication/authentication-host'
  config:
    tenantId: local
    subject: developer
    claims:
      role: developer
```

This configuration is trusted input. It must never be generated from model output or copied directly from request parameters. As an explicit embedded or custom-integration escape hatch, a multi-user host may programmatically install one adapter that reads the host framework's request-local principal:

```ts
await ctx.plugin(authenticationHost({
  currentPrincipal: () => hostAuthentication.currentPrincipal(),
}))
```

The adapter is mounted once as an ordinary Cordis plugin. This is not a normal third configuration surface. Its callback is illustrative: an integration can use framework request state, asynchronous local storage, or another host mechanism, but it must not use one mutable global principal. Concurrent callers in that process share the Karaka runtime and plugin graph while the host adapter resolves a different principal for each invocation.

Identity alone never permits an action. Authorization plugins must compare the internally carried principal, requested action, and canonical resource ownership. Model-facing tools obtain the acting tenant and subject from the Agent Runtime invocation, scope storage operations to that tenant, and require an explicit cross-user permission before targeting another subject. Giving an agent an identity therefore identifies whose authority it may request; it does not grant arbitrary access to every identity.

## Services and tools

A **service** is a runtime-facing capability exposed through the Cordis context. Plugins use services to cooperate without importing one another's implementations. A top-level seam may use one service or coordinate several internal services and registries.

A **tool** is an operation intentionally exposed to a model inside the Agent Runtime seam. A core Tool plugin will provide an internal service such as `ctx.tools`; it will own model-visible names, schemas, agent allowlists, semantic validation, and cleanup. Tool-host, manifest-bridge, discovery-provider, tool-RPC, and tool-policy implementations are ordinary Cordis plugins in the Tool plugin family. The Tool family owns its language-neutral manifest and invocation protocols because they are part of the tool contract, not Karaka's application-facing Transport seam.

### Tool package boundary

The first-party Tool family will be published as the separately installable `@karaka/tool` package. It is an application-capability package above the nine-package kernel, not a new top-level seam.

The package root exports the metadata-only `tool` decorator and shared TypeScript contracts, schemas, and metadata types. These exports are inert: importing `@karaka/tool` neither mounts behavior nor registers a tool. First-party runtime behavior is exposed through plugin subpaths of the same package. The target naming convention includes `@karaka/tool/core`, framework-specific `@karaka/tool/host-*`, `@karaka/tool/discovery-*`, `@karaka/tool/manifest-bridge`, and `@karaka/tool/policy-*`. Each behavioral subpath exports an ordinary Cordis plugin, and every registration it makes is owned by a reversible effect. The exact list grows with implementations, but first-party Tool behavior must not escape this plugin contract.

Third-party and private Tool-family plugins may use their own package names. They integrate through the same public Tool contracts and Cordis lifecycle; they do not receive a separate registry or extension mechanism. Local handlers and remote tool-host clients are Tool-family plugins behind the same logical invocation contract.

| Property | Service | Tool |
| --- | --- | --- |
| Primary caller | Runtime and plugins | Agent or model |
| Discovery | Stable `ctx.<name>` contract | Registered schema in a tool registry |
| Typical scope | Infrastructure or shared domain capability | Narrow, authorized action |
| Example | `ctx.storage.put(...)` | `save_artifact(...)` |
| Model-visible by default | No | Yes |

Registering `ctx.storage` must not make raw storage methods available to a model. A `save_artifact` tool can validate a narrow input, apply policy, call `ctx.storage`, and return a bounded result. This separation keeps internal authority out of the model-facing surface.

```mermaid
flowchart LR
  Model["Agent / model"] -->|tool call| Tools["ctx.tools service"]
  Tools --> Save["save_artifact tool"]
  Save -->|controlled call| Storage["ctx.storage service"]
  Storage --> Backend["Selected storage provider"]
```

The same pattern applies to SaaS domains, but normal application developers should not write a plugin or setup entry for every method. Karaka will provide a decorator for methods on services already created by the backend framework. The following API is illustrative:

```ts
import { tool } from '@karaka/tool'

class InvoiceService {
  @tool({
    id: 'invoices.refund',
    description: 'Refund an eligible invoice.',
    input: RefundInvoiceInput,
    output: RefundInvoiceOutput,
    permission: 'invoices.refund',
  })
  async refund(input: RefundInvoice) {
    return this.database.transaction(() => this.refundInvoice(input))
  }
}
```

`@tool` will attach metadata only. It is an inert authoring helper, not a second plugin system. Importing a decorated class will not register it or mutate a global registry. A framework-specific application tool-host plugin will enumerate backend-managed instances during application bootstrap, read their tool metadata, bind the methods, and register local execution handlers through reversible Cordis effects. The host plugin owns those effects, so disposal removes the handlers. The decorator must not create another service container, lifecycle, registry, or non-disposable global side channel. A framework with no inspectable container may require one application-level host registration point, but never one YAML entry per method.

In a remote deployment, every application or microservice tool-host plugin will serve a versioned manifest of its bound tools over an authenticated channel. An agent-process discovery bridge plugin will find trusted tool hosts through a static or service-discovery provider plugin such as Kubernetes, Consul, or Cloud Map; authenticate each host; fetch and validate its manifest; and register model-visible descriptors and invocation endpoints in Agent Runtime through reversible effects. The discovery, bridge, and RPC roles remain plugins in the Tool family; there is no separate discovery daemon or lifecycle outside Cordis. The application graph therefore owns handler effects, while the agent graph owns descriptor and client effects. Repositories and source languages do not form the integration boundary: the manifest and invocation protocols must be language-neutral. A shared-process development or embedded deployment may combine both roles in one graph without changing their ownership.

The tool host will expose one manifest operation and one invocation dispatcher for all decorated methods; the decorator will not create one network route per method. Tool RPC authentication has two layers. Service authentication, such as mTLS or a service credential, proves that the call came from an authorized Karaka deployment. A short-lived, signed delegation carries the verified principal and tenant whose authority the invocation may exercise. The model cannot supply or modify either identity. On every call, the application host authenticates the service and delegation, validates the input, applies the tool's declared permission through Authorization, executes the bound method, validates the output, and records the audit event.

A conceptual invocation envelope contains an invocation ID, logical tool ID and version, validated input, deadline, and signed delegation. Credentials and the effective principal are transport metadata, never model-visible tool arguments. The manifest and invocation protocol are shared contracts, while authentication mechanisms remain replaceable providers selected in setup.

The setup YAML will configure one or more tool-host discovery providers, not one entry per method or source repository. Each backend discovers its own decorated methods; Karaka discovers authenticated running hosts and their manifests. Remote execution is the production default for application-owned tools because business logic remains with the service that owns its data, transactions, and authorization. Local execution inside Karaka is reserved for Karaka-owned control capabilities, tests, and explicit embedded deployments. Both placements expose logical tool IDs to Agent Runtime without putting endpoints in agent plugins.

An agent plugin explicitly selects the registered tools it may use in its effect-owned descriptor:

```ts
ctx.agentRuntime.registerAgent({
  id: 'support',
  tools: ['customers.read', 'invoices.refund'],
  // prompt, model, session and other agent policy
}, ctx.agentModels)
```

Discovery makes a tool available to the runtime; it does not grant every agent access. Agent activation must fail if an allowed tool is absent from the verified manifests or its version or schema is incompatible. Agent Runtime validates model arguments before asking the registered tool invocation client to perform the call. The owning backend validates the input again, authorizes the internally carried principal, executes the bound method, and validates its output. Agent Runtime validates the returned output before giving it to the model. Tool IDs must be globally stable, and discovery must reject conflicting owners or incompatible descriptors instead of depending on arrival order. Karaka-native control tools may be contributed by Agent Runtime plugins, but application business tools normally remain remote.

## Chat ownership and application API

Karaka owns the agent, chat, session, model and tool orchestration. Ordinary application code supplies a message and, when continuing an existing chat across a stateless boundary, an opaque chat identifier. It does not construct an identity, invocation context, agent instance, session object, or conversation state.

A future application-facing API should preserve this boundary. The names below are illustrative:

```ts
const chat = await karaka.chat.create()

const first = await chat.send('Help me review this invoice')

const later = await karaka.chat.send({
  chatId: chat.id,
  message: 'Now explain the refund policy',
})
```

The bound `chat.send(message)` and stateless `karaka.chat.send({ chatId, message })` forms invoke the same operation. The chat handle only retains the opaque identifier for the application. Karaka owns the associated identity binding, selected agent, session state, history, and execution metadata.

Creating a chat coordinates the installed seams:

```text
chat.create()
    -> authenticate the current caller
    -> authorize chat creation
    -> resolve the caller's overall entitlement account
    -> select an agent through the installed routing policy
    -> resolve Agent Runtime contributions
    -> create and persist session state and chat ownership
    -> return an opaque chat ID
```

Sending a message restores and enforces that state:

```text
chat.send({ chatId, message })
    -> authenticate the current caller
    -> load the chat
    -> authorize that caller against canonical chat ownership
    -> restore the selected agent and session state
    -> resolve models, tools, skills and delegation policy
    -> check overall spend before each metered model call and record actual spend afterward
    -> execute and persist the turn
    -> return the response
```

A chat ID is a locator, never proof of authority. Karaka must authenticate and authorize every operation so one user cannot gain access by presenting another user's chat ID. One standing agent plugin composition can serve many concurrent callers. Each active chat may own an ephemeral runtime scope joined to that composition, but principals, messages, histories, and durable plugin state remain invocation or session data rather than services mounted once per request.

## Agent Runtime internals

Agent Runtime is one top-level seam composed from model, session, tool, skill, agent, and subagent components. Provider and integration plugins may expose internal Cordis services so these components remain replaceable without becoming top-level Karaka seams.

### Agent plugins and contributions

Developers define every agent and subagent as a named Cordis plugin loaded from setup. Its effect-owned descriptor is standing executable configuration shared by many chats, not a live conversation object. A subagent is another registered agent plugin referenced by logical ID.

References contributed by an agent plugin name logical capabilities or policies, not concrete provider objects or endpoints. Authenticated remote manifests provide logical application-tool names; setup-selected model and session providers satisfy the other references. Replacing OpenAI with DeepSeek, PostgreSQL with another session backend, or one tool-host discovery provider with another therefore does not require changing the agent plugin unless its logical policy changes.

An agent plugin may register its descriptor directly and mount child plugins for additional behavior. The agent fiber owns those effects and children. Removal, replacement, and hot reload therefore use the same dependency and effect lifecycle as every other plugin subtree. Agent Runtime indexes active descriptors and coordinates runs; it does not translate a special definition format into a second lifecycle.

Karaka should ship good defaults as ordinary first-party plugins. A standard agent bundle is itself a Cordis plugin that mounts child plugins for the default agent loop, session coordination, model/tool-call processing, user-interaction capability, subagent delegation and control, skill resolution, cancellation limits, and runtime events. Its final package or export boundary is deliberately not fixed here. Some of these capabilities expose model-facing tools, while others are internal services or events. Applications can use the bundle without configuring every component and can replace a behavior through the same public Cordis seams; the loop must not contain a privileged hard-coded version of a replaceable policy. A resolved-composition inspection command should expose the concrete plugins behind any bundle.

Agent plugins do not implicitly inherit from one another. Reuse comes from ordinary module imports, shared plugin packages, standard bundles, and Cordis parent scopes. A subagent reference declares delegation, not prompt, tool, session, or authority inheritance. Any future inheritance helper must define deterministic merge, cycle, reload, and version behavior without bypassing plugin lifecycle.

Agent routing remains a setup-selected plugin contribution. On `chat.create()`, Karaka asks the installed routing policy to select among active agent descriptors using trusted runtime information such as the authenticated principal, tenant, entitlements, and product configuration. A product may optionally expose an agent choice as an application-level request, but Karaka still authorizes and resolves that request; the application does not construct the agent.

Agent plugins, extensions, routers, tool semantics, model policies, session policies, and delegation semantics all live inside the Agent Runtime seam. They may use internal services such as `ctx.agentRuntime`; they do not become additional top-level seams. The normal deployment surface is setup YAML loading ordinary plugin modules.

Plugins define behavior and capabilities. A principal, chat, message, model response, or tool invocation is runtime data flowing through those plugins, not another plugin. This distinction preserves Cordis composition without misusing service isolation for per-request state.

### Plugin changes and durable chat state

A standing agent plugin composition is process-local executable state; a chat is durable application state. Chat storage records the agent ID, messages, model requests and responses, tool calls and results, turn boundaries, and every plugin-owned fact needed to continue the chat. It does not pin a composition generation or content hash. Essential runtime state cannot live only in an in-memory map, and external effects require stable invocation IDs so recovery does not duplicate work.

On every turn, including after a process restart, Agent Runtime resolves the stored agent ID against the current Cordis graph and loads the durable chat state into that behavior. Replacing or reloading an agent plugin therefore changes subsequent turns while preserving the conversation. Stored data and event formats still need explicit versions and migrations when their schemas change. Exact historical execution is a separate deployment policy that requires retaining an old executable artifact; a chat record cannot preserve code that is no longer deployed.

An agent is a runtime participant with its own conversation state, tools, skills, and authority. A subagent is another registered agent invoked by a parent; it is not a distinct runtime kind or process. The target Agent Runtime delegation path has three layers:

1. A **model-facing tool** accepts a task from the parent agent.
2. An **Agent Runtime delegation policy** resolves the named child, decides conversation inheritance and explicitly granted capabilities, and constructs the complete child invocation.
3. The **normal Agent Runtime path** runs the child exactly as it runs any other selected agent.

```mermaid
flowchart TB
  Parent["Parent agent / model"]
  Tool["Delegation tool<br/>delegate(...) or billing_agent(...)"]
  Service["Agent Runtime delegation<br/>resolve child invocation"]
  Runtime["Normal Agent Runtime path"]
  Child["Child agent"]

  Parent -->|model-visible call| Tool
  Tool -->|start request| Service
  Service -->|resolved child invocation| Runtime
  Runtime --> Child
```

The model-facing API can be one generic tool with an agent selector or several domain-specific tools. Both forms resolve a registered agent ID and enter the same Agent Runtime path used by an application-started chat.

Control and reporting are explicit capabilities. Operations such as sending a follow-up, interrupting a child, listing children, or reporting a result should be separate tools or service methods with their own policy. Parent and child must not communicate through hidden shared mutable state.

Conversation inheritance, runtime composition, and authority are independent decisions owned by Agent Runtime and its delegation policy. The policy may fork the parent conversation or start with a fresh prompt. It constructs a child invocation containing only the context and capabilities explicitly granted to that child, then calls the same internal run path used for any agent. Transport is not involved in an in-process parent-to-child call.

## Transport is below the application API

Agent Runtime owns chats, agents, sessions, and orchestration. Transport exposes that application API without teaching Agent Runtime about HTTP or another wire protocol. A Transport plugin adapts authenticated requests, responses, streaming, cancellation, deadlines, and protocol errors to the internal Chat API. It does not define agents, run subagents differently, choose process counts, or own durable chat state.

```mermaid
flowchart LR
  Application["Application backend"]
  Transport["Transport plugin<br/>in-process or HTTP"]
  Chat["Karaka Chat API"]
  Runtime["Agent Runtime"]

  Application --> Transport
  Transport --> Chat
  Chat --> Runtime
```

An in-process adapter can call the same Chat API directly for embedded deployments. An HTTP adapter opens the network server for a standalone Karaka process. Transport does not replace Authentication or Authorization: every adapter must establish the trusted invocation boundary before calling the Chat API.

### Running Karaka and scaling agents

`karaka start --config karaka.yaml` starts one persistent Karaka process from a top-level Loader entry list. The thin `@karaka/cli` process host creates the root Cordis context, mounts Loader and Include from the composition kernel, waits for the configured plugin graph to settle, and disposes the graph on `SIGINT` or `SIGTERM`. It does not own application behavior: setup-selected plugins provide the future Chat API, transports, seams, providers, and agents.

One process mounts many standing agent plugins. An agent plugin is not a process, so adding support, billing, research, or reporting does not require another server. Each chat resolves one active plugin descriptor and carries separate principal, session, history, and turn state. A subagent is another registered agent and runs through the same runtime path.

```mermaid
flowchart LR
  Frontend["Frontend"] --> Application["Application backends<br/>public APIs and decorated methods"]
  Application -->|"chat requests"| Karaka["Persistent Karaka server<br/>Chat API and Agent Runtime"]
  Karaka -->|"authenticated tool RPC"| Invoice["Invoice-service tool host"]
  Karaka -->|"authenticated tool RPC"| Customer["Customer-service tool host"]
  Karaka --> Support["support agent plugin"]
  Karaka --> Billing["billing agent plugin"]
  Karaka --> Research["research agent plugin"]
```

The baseline production topology therefore has existing application services and one Karaka server. Every application deployment contains its decorated methods and a small tool-host plugin; the Karaka deployment contains an application-facing Transport plugin, Agent Runtime, agent plugins, model provider plugins, and Tool discovery and RPC plugins. Neither deployment absorbs the other's implementation. Karaka-native control capabilities may run locally as first-party plugins, but application business operations remain in the services that own their data and authorization.

For a microservice product, a small Karaka deployment project is the recommended assembly point. It contains the setup YAML, agent plugin modules, prompts, package manifest and lockfile, and optional local agent-side plugin source. Agent-side plugins owned by other repositories are published or otherwise installed into this deployment artifact. Microservice repositories keep their backend code, decorators, and tool-host plugin. The repository name and directory layout are conventions, not runtime contracts; a smaller or embedded product may keep the same files under an application directory.

Tool discovery follows deployment state rather than repository layout. Each service discovers decorated methods on its own framework-managed instances and publishes an authenticated, versioned manifest. A setup-selected discovery plugin watches trusted service records, fetches manifests, groups compatible replicas, and contributes descriptors and tool invocation endpoints through effects. Adding a method does not require a central setup row, but an agent must still name the logical tool in its allowlist before the model can request it.

Capacity scaling uses multiple identical Karaka replicas behind the deployment platform's load balancer. Every replica loads the same versioned setup and agent plugins. Chat ownership, history, session state, and execution metadata must live in shared durable Storage rather than process memory so any replica can continue a chat. Replica count belongs to Docker, Kubernetes, ECS, systemd, or another deployment system; agent plugins never define process count.

Additional worker roles are deferred until Karaka has a concrete need such as untrusted sandbox work, durable background work, or self-hosted inference. They do not change the rule that agents and subagents share one Agent Runtime contract, and they do not create a process per agent.

## Application and extension APIs

A future Karaka code API has two deliberately different purposes:

1. The application-facing Chat API provides simple imperative operations such as creating a chat and sending a message. Karaka performs the cross-seam orchestration behind that facade.
2. The `@tool` decorator marks methods on backend-managed application services for that backend's installed tool host to register.

These APIs do not form another Karaka definition format. Setup remains in one setup YAML, and agents and subagents remain ordinary Cordis plugin modules loaded by it. A backend's framework bootstrap and ordinary deployment configuration install its tool host but do not define agents. Agent authors use normal plugin effects rather than a parallel `defineAgent` system.

A remote deployment uses two role-specific plugins from the Tool family. Each backend bootstraps an application tool-host plugin that turns decorated metadata into Cordis-owned invocation handlers. Karaka's setup selects a discovery-bridge plugin that turns verified manifests into Cordis-owned Agent Runtime descriptors and Tool-family clients. Each plugin is mounted once in its process and uses that process's service container, registries, effects, scopes, and dependency ordering. A shared-process deployment may mount both roles in one graph.

Conceptually:

```text
@tool metadata on a backend-managed method
        |
        v
application tool-host plugin
        |
        v
reversible tool invocation handler effects

authenticated, verified manifest
        |
        v
agent bridge plugin
        |
        v
reversible Agent Runtime descriptor effects
```

Advanced developers can author ordinary Cordis plugins to add or replace services, providers, policies, registries, and agent behavior. Agent-side plugin modules must be installed in the Karaka deployment artifact and referenced by setup YAML; backend tool implementations stay in their owning application artifact. Direct programmatic composition is reserved for internals, tests, embedded plugin integrations that require runtime values, and custom plugin authors.

The code API must not create parallel storage, authentication, Agent Runtime, lifecycle, tool, or plugin registries. In each process, the Chat API and tool-host plugins delegate to services and contributions in that process's Cordis graph; they do not own hidden registries or permanent global registrations. Two composition systems would duplicate dependency ordering, scoping, cleanup, and hot replacement, and would make Cordis lifecycle guarantees stop at the code API boundary.

Plugin authors can replace a provider, add a definition extension, install a policy, or use Cordis directly without leaving the architecture. Ordinary application request code should not see `ctx`, provider names, authentication assertions, invocation envelopes, session objects, or Cordis scopes.

## Ownership and scope

Every service registration, agent descriptor, tool definition, provider entry, listener, child plugin, and scheduled resource is an effect owned by its contributing plugin. Disposing an agent plugin must dispose its child plugins and reverse every contribution. Registries must not retain disposed entries or children.

Use Cordis service isolation for plugin-graph composition, including a standing agent subtree that needs a distinct implementation or registry view. A live chat may temporarily join that composition through an owned runtime scope, but service isolation must not represent the durable request, principal, message, or chat state. That state is loaded from Storage and carried internally through the turn path. Scope narrows service resolution; it does not establish or copy authority automatically. Policies should be attached at the service or invocation boundary they govern so every consumer, including a model-facing tool, passes through the same enforcement point.

The Loader and Include modifications recorded in [vendor/README.md](../vendor/README.md) preserve transactional updates so a rejected configuration does not destroy the active tree.

## Design rules

- Keep one composition system: Cordis.
- Implement every configurable or executable runtime behavior as a Cordis plugin; do not add parallel lifecycle, registry, or discovery systems.
- Use one Karaka deployment specification and one Cordis graph per process; connect independently deployed backend graphs through authenticated protocols rather than shared configuration.
- Expose one normal deployment surface: setup YAML loading ordinary Cordis plugins.
- Put runtime assembly, providers, transports, policy, and agent plugin modules in setup YAML.
- Implement every agent and subagent as a normal effect-owned Cordis plugin, not a special YAML definition or parallel object lifecycle.
- Make ordinary providers addressable as plugin modules with serializable setup configuration.
- Give first-party, third-party, and private plugins the same public extension path.
- Name services after capabilities, not vendors.
- Keep service contracts independent of providers and consumers.
- Keep models, sessions, tools, skills, agents, and subagents inside the Agent Runtime seam.
- Publish the first-party Tool family as the separate `@karaka/tool` package: keep inert authoring contracts at its root and expose runtime behavior as Cordis plugin subpaths.
- Let applications create chats and send messages without constructing identities, sessions, agents, or invocation contexts.
- Treat a chat ID as an opaque locator and authenticate and authorize every chat operation.
- Let each agent plugin own its descriptor, child plugins, and contributions through one reversible Cordis lifecycle.
- Ship useful default agent behavior as replaceable first-party plugins and an inspectable standard bundle that is itself a plugin mounting child plugins; do not hard-code replaceable policy in the agent loop.
- Treat subagent references as delegation rather than implicit definition, prompt, tool, session, or authority inheritance.
- Persist every chat and plugin-owned fact needed to continue it, but resolve behavior from the current Cordis plugin graph rather than pinning a stored composition version.
- Keep principals, chats, messages, responses, and invocations as runtime data rather than Cordis plugins or services.
- Expose model actions through narrow tools; do not expose whole services implicitly.
- Let methods on backend-managed application services become tools through `@tool`, without per-method YAML or authored plugins.
- Make decorators metadata-only; importing application code must not mutate a registry.
- Mount one tool-host plugin from the Tool plugin family during each backend's bootstrap, enumerate its managed instances, bind decorated methods, and register them through reversible Cordis effects.
- Discover remote tool hosts through setup-selected static or service-discovery plugins, then consume authenticated, versioned, schema-verified manifests and fail agent activation when required tools are missing or incompatible.
- Group tool host, discovery, manifest-bridge, RPC, and policy implementations in the Tool plugin family; keep Tool as an Agent Runtime component rather than a top-level seam.
- Configure tool-host discovery rather than individual methods or source repositories; keep production application tools remote and reserve local execution for Karaka-owned controls, tests, and explicit embedded use.
- Expose decorated application methods through one authenticated manifest and invocation dispatcher per tool host, not one route or setup entry per method.
- Authenticate both the Karaka service and the short-lived delegated principal on every remote tool invocation; never accept authority from model arguments.
- Keep tool registration separate from the application service or method a tool consumes.
- Resolve subagent conversation, context, capability, credential, and authority inheritance in Agent Runtime, then run the child through the same Agent Runtime path as any other agent.
- Treat agents and subagents as standing plugin compositions in a shared runtime, not as processes.
- Start with one persistent Karaka server, scale with identical replicas and shared durable state, and add specialized workers only for placement or isolation.
- Keep replica count in the deployment platform rather than agent plugins.
- Specify context, tool, credential, and authority inheritance independently.
- Select providers in application composition, not in capability consumers.
- Register every contribution as a reversible Cordis effect.
- Keep product behavior out of the nine-package kernel; use backend-owned decorated methods for business operations and agent-side plugins for advanced orchestration behavior.
