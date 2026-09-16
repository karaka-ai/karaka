---
description: "Durable application ownership, Session lineage authorization, and owner-filtered references for Karaka deployments."
kind: "package-reference"
---

# @karaka-ai/identity

English | [中文](README.zh.md)

## Summary

Keep application, tenant, and user ownership durable across chat creation and restart. Authorize a chat before resuming its DSH Session, and inherit ownership through trusted parent headers. Filter Session references to the same owner. Back up authority records together with Session logs and their ancestors.

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

Mount `@karaka-ai/identity` in `cordis.yml` with DSH storage, Sessions, and Session persistence. Configure an absolute `root` dedicated to this server’s authority records. Preserve this directory alongside the JSONL store in backups.

Hold `withChatLock` across reservation, Agent creation or authorized resume, and acknowledgement. Bind the actual unpublished Session inside Agent setup; `markReady` flushes Session data before recording readiness. Authorization must precede resume because resume can repair persisted data.

Select `@karaka-ai/identity/session-reference` as the Session reference provider. Application Agents can reference only the same application, tenant, and user; ordinary DSH Agents cannot reference application chats. Candidates are filtered before applying the result limit.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [authority service](src/index.ts) stores reserved, bound, or ready records in the DSH JSON storage domain. [Bindings](src/records.ts) compare immutable Session fields without including the physical format version. Corrupt authority, conflicting bindings, and missing acknowledged data prevent access or startup. A same-owner retry may recreate an unmaterialized attempt, but cannot adopt an existing unowned log.

Tools derive owners from their executing Session and server-written `parentSession` lineage. Cached observations support synchronous catalog selection; execution resolves authority again. Cycles, missing ancestors, and conflicting owners grant no application access. Ordinary DSH Sessions have no application owner.

No invariant companion is published because the authority service checks durable records against observed Session headers at reservation, binding, authorization, and recovery; no separate diagnostic projection is maintained.

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

- The exclusive writer lock requires native POSIX flock and supports Linux/macOS. Windows authority locking is unsupported; no unlocked fallback is provided. Keep the permanent lock file intact.
- All processes accessing an authority directory must use this plugin. Preserve the authority file and ancestor logs together; isolated child-log backups cannot reconstruct ownership. Independent child retention and external subagent-provider identity are unsupported.
- Generic Session query tools retain workspace authorization. Cwd-free application roots have same-session history access; application-wide history search requires an owner-aware consumer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
