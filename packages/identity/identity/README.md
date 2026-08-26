# @deepseek-ai/dsh-identity

English | [中文](README.zh.md)

Provider-neutral Service Definition for verified runtime identity. `Identity` registers `ctx.identity`; a Service Provider verifies an opaque credential and returns a deeply immutable `VerifiedIdentity`. The result contains trusted issuer, subject, audience, NumericDate, optional token-id, and claim data. It deliberately does not contain tenant membership, application roles, permissions, or authorization decisions.

## Service API

| API | Contract |
|---|---|
| `ctx.identity.verify(request)` | Verify one opaque bearer credential and return trusted identity claims. The optional `AbortSignal` requests cooperative cancellation. |
| `VerifiedIdentity` | Immutable issuer-local identity and verified JSON claim set. `issuer`, `subject`, audiences, and token id use package-owned branded string types. |
| `IdentityError` | Safe error with a stable `IDENTITY_*` routing code and no raw credential or provider detail. |

The Service Definition owns request, result, and error types. Providers and Consumers depend on this package, never on each other. Authority normalization and resource authorization are separate capability seams because they answer different questions: this service proves who issued a credential and which subject it names; it does not decide what that subject may do.

## Composition

Do not mount the abstract Service Definition as a standalone row. Compose one provider and the Consumers that need it:

```yaml
- name: '@deepseek-ai/dsh-identity-jwks'
  config:
    issuer: 'https://issuer.example'
    audience: 'karaka-api'
    jwksUrl: 'https://issuer.example/.well-known/jwks.json'
    algorithms: ['RS256']
- name: '@deepseek-ai/dsh-identity-http-bearer'
```

## Model Experience

### Verified runtime identity

#### What the model sees

Nothing. `ctx.identity` remains model-hidden runtime context, and this package adds no prompt, tool, message, or request-body content.

#### Token effect

Zero tokens.

#### KV Cache effect

None; identity verification does not change the model-visible prefix.

## Known Limitations and Deferred Work

- **Bearer credentials only** — the first request union contains only `kind: 'bearer'`; another credential family requires an explicit contract extension.
- **No authority mapping** — tenant, user, role, and application-policy normalization belong to a later Service Definition and provider.
- **No authorization decision** — Consumers must call a separate resource-authorization capability before protected work.
