---
description: "Authenticated JSON and SSE ingress from application backends to the persistent Karaka process."
kind: "package-reference"
---

# @karaka-ai/transport-http

English | [中文](README.zh.md)

## Summary

`@karaka-ai/transport-http` mounts the application Chat API on `ctx.webServer`. It authenticates the calling server through `ctx.serverAuth`, combines that application identity with trusted tenant and user values, and calls `ctx.sessionController.application`. JSON routes admit commands and read history; SSE streams stable chat events and structured user questions.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

`path` selects the route prefix and defaults to `/v1`. `maxBodyBytes` limits JSON request bodies and defaults to 1 MiB. A stream verifies chat ownership before committing SSE headers and aborts its Session follower when the client disconnects. Every route registration, pending interaction, and active stream is owned by the plugin effect and ends during disposal.

## Model Experience

None, as this package transports application input and projects Session events without assembling model requests.

#### KV Cache effect

No direct effect; the Agent and its preset own request construction.

## Known Limitations and Deferred Work

- **Single-process interaction state** — unanswered structured questions do not survive a Karaka process restart.
- **No distributed admission lock** — one process serializes a chat; deployments with several replicas require external routing or coordination.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>

None.

</details>
