---
description: "Cordis authentication contract and shared-bearer provider for Karaka application-server traffic."
kind: "package-reference"
---

# @karaka-ai/server-auth

English | [中文](README.zh.md)

## Summary

`@karaka-ai/server-auth` defines `ctx.serverAuth` and provides the default shared-bearer implementation. It verifies inbound application chat credentials into an `applicationId` and resolves the outbound credential used when Karaka calls that application's MCP tool endpoint. Credential values remain in `ctx.credentials` and are resolved for each operation.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

Each `applications` row has a stable `id`, `chatCredential`, and `toolCredential`. The two credential references rotate independently. Alternative providers implement `authenticate()` and `authorizeTools()` behind the same service.

## Model Experience

None, as authentication metadata is not added to prompts, messages, or tool schemas.

#### KV Cache effect

None; credential resolution and verification occur outside model requests.

## Known Limitations and Deferred Work

- **Shared bearer is the only bundled provider** — header-based OAuth or workload-identity providers can replace it. mTLS and transport-level request signing need a future contract that receives socket and request options.
- **TLS is deployment-owned** — terminate HTTPS before the Host web server in production.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
