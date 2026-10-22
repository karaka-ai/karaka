---
description: "Process-local application ownership, explicit root restoration, and owner-filtered Session references for Karaka deployments."
kind: "package-reference"
---

# @karaka-ai/identity

English | [中文](README.zh.md)

## Summary

Authorize chats using application, tenant, and user ownership in memory. Restore existing root ownership only after the application verifies access. Inherit ownership through trusted parent headers and limit Session references to verified owners. Restart discards ownership; applications must verify access again before reopening chats.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@karaka-ai/identity` in `cordis.yml` with Sessions and Session persistence. The plugin requires no configuration or local ownership files.

Hold `withChatLock` across reservation, Agent creation or authorized resume, and acknowledgement. Before calling `restore` for an existing root, ingress must verify application authority, chat scope, and allowed preset. Ordinary authorization and owner lookups never adopt unowned Sessions. Bind new Sessions inside Agent setup; `markReady` flushes and verifies persisted headers before acknowledgement. Authorization must precede resume because resume can repair persisted data.

Select `@karaka-ai/identity/session-reference` as the Session reference provider. Both Sessions must have a resolved owner with the same application, tenant, and user. Unowned Sessions cannot supply or receive references. Candidates are filtered before applying the result limit.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [authority service](src/index.ts) retains reserved, bound, or ready records in memory without enumerating persisted Sessions at startup. [Bindings](src/records.ts) compare immutable Session fields without including the physical format version. Conflicting bindings and missing acknowledged data prevent access. A same-owner retry may recreate an unmaterialized attempt; only explicit verified restoration can adopt an existing root.

Tools derive owners from their executing Session and server-written `parentSession` lineage. Cached observations support synchronous catalog selection; execution resolves authority again. Cycles, missing ancestors, and conflicting owners grant no application access. Ordinary DSH Sessions have no application owner.

No invariant companion is published because the authority service checks ownership records against observed Session headers at reservation, binding, authorization, and restoration; no separate diagnostic projection is maintained.

</details>


-----

<a id="further-exploration"></a>
## Further Exploration

- [Session](../../core/session/README.md): immutable headers and event logs.

- [Session references](../../context/session-reference/README.md): reference content and budgets.

- [Server authentication](../server-auth/README.md): authenticated application identities.

-----

<a id="model-experience"></a>
## Model Experience

### Authorization

#### What the model sees

`karakaIdentity` adds no prompt text. The Session reference provider permits owner-authorized context through the original DSH reference renderer; tool consumers use ownership to select available tools.

#### Token effect

Ownership records and checks add no model tokens; admitted reference content retains the DSH reference provider’s token budgets.

#### KV Cache effect

Authority checks do not alter an existing request prefix; authorized reference content and consumer tool selection can change subsequent model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Deployments must account for these constraints.

- Ownership is process-local. Every process and restart requires verified restoration; independent processes cannot detect conflicting owner assignments.
- Retain ancestor logs with child Sessions. Child ownership remains unavailable until the application restores its root. Independent child retention and external subagent-provider identity are unsupported.
- Generic Session query tools retain workspace authorization. Cwd-free application roots have same-session history access; application-wide history search requires an owner-aware consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
