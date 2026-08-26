# identity/ — runtime identity

English | [中文](README.zh.md)

Runtime identity capability family plus the existing anonymous correlation id. Verified identity, application authority normalization, and resource authorization remain separate seams.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |
| [`identity/`](identity/README.md) | Provider-neutral verified-identity Service Definition | `ctx.identity` |
| [`identity-jwks/`](identity-jwks/README.md) | Remote-JWKS JWT Service Provider | registers `ctx.identity` |
| [`identity-http-bearer/`](identity-http-bearer/README.md) | HTTP Authorization Bearer Consumer | `ctx.identityHttpBearer` |

The three-role identity capability is complete only across its Service Definition, Service Provider, and Consumer. A composition mounts the provider and Consumer rows; the abstract Service Definition supplies their shared contract and is not mounted separately.
