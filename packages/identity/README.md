# identity/ — runtime identity

English | [中文](README.zh.md)

Runtime identity capability family plus the existing anonymous correlation id. The identity plugin accepts trusted host ids or verifies HTTP Bearer JWTs; resource authorization remains a separate capability.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |
| [`identity/`](identity/README.md) | Trusted-host normalization and HTTP Bearer/JWKS verification | `ctx.identity` |

The package combines definition, provider, and consumer roles because Karaka currently owns one trusted-host input and one JWT implementation. A composition mounts one concrete row; a provider split remains deferred until another implementation needs independent replacement.
