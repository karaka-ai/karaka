---
description: "Inbound application bearer verification and outbound MCP credential resolution for configuring or debugging server authentication."
kind: "package-reference"
---

# @karaka-ai/server-auth

English | [中文](README.zh.md)

## Summary

Authenticate application servers and authorize their outbound MCP calls with separate credentials. Configure references to secrets, then rotate their values through the credentials provider. Each operation resolves the current value. Ambiguous inbound credentials grant no access.

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

Mount `@karaka-ai/server-auth` in `cordis.yml` alongside a DSH credentials provider. Set `applications` to application records with a unique nonempty `id`, inbound `chatCredential`, and outbound `toolCredential`; the credential fields are references accepted by [DSH credentials](../../credentials/credentials/README.md).

Missing or malformed bearer headers and credentials matching multiple applications return no authenticated identity. Unknown applications and missing outbound credentials reject tool authorization. Provider errors propagate; cancellation rejects the caller’s wait without cancelling provider work.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service and shared-bearer provider](src/index.ts) keep application identity separate from Session data. Equal-length secret comparisons use Node’s timing-safe comparison; credentials are resolved for each request rather than cached.

No invariant companion is published because authentication derives each result directly from the current credential provider response and keeps no independent credential cache.

</details>


-----

<a id="further-exploration"></a>
## Further Exploration

- [Credentials](../../credentials/credentials/README.md): secret references and provider semantics.

- [Identity](../identity/README.md): application ownership.

- [Browser authentication](../browser-auth/README.md): signed user credentials.

-----

<a id="model-experience"></a>
## Model Experience

### Authorization

#### What the model sees

`serverAuth` contributes no model context; its consumers authorize application requests and outbound MCP calls.

#### Token effect

Authentication adds no input tokens or tool descriptions.

#### KV Cache effect

Authentication does not alter the model request prefix or KV-cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Deployments must account for these constraints.

- The shipped provider accepts shared bearer credentials; deployments needing another authentication protocol must supply a `ServerAuth` implementation.
- Cancellation stops waiting for credential resolution; the credentials API does not accept a cancellation signal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
