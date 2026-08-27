# @deepseek-ai/dsh-identity

English | [中文](README.zh.md)

Concrete runtime identity plugin for trusted same-process host calls and HTTP Bearer JWTs. One package registers `ctx.identity`, normalizes both inputs into a deeply immutable `ResolvedIdentity`, and includes strict Authorization parsing plus maintained `jose` remote-JWKS verification when configured.

## Service API

| API | Contract |
|---|---|
| `ctx.identity.resolve({ kind: 'trusted', userId, tenantId? })` | Accept application-owned branded ids from typed trusted host code, detach them into a new frozen result, and perform no hostile-input validation. |
| `ctx.identity.resolve({ kind: 'http-bearer', authorization, signal? })` | Parse exactly one Bearer value and verify its JWT through the configured issuer, audience, algorithms, and remote JWKS; cancellation settles this caller while a shared key fetch may continue for the process-local cache. |
| `ResolvedIdentity` | Discriminated immutable result with `source`, branded `userId`, optional branded `tenantId`, and verified JWT facts only on HTTP results. |
| `IdentityError` | Safe error with a stable `IDENTITY_*` routing code and no raw credential or provider detail. |

Trusted host code brands its application-owned ids before resolution:

```ts
const identity = await ctx.identity.resolve({
  kind: 'trusted',
  userId: IdentityUserId(session.user.id),
  tenantId: IdentityTenantId(activeWorkspace.id),
})
```

The trusted path needs no JWT setup. It is appropriate only when the caller and Karaka share one trusted server process; never forward browser-supplied ids through this path.

## JWT configuration

The optional `jwt` block enables HTTP Bearer resolution:

```yaml
- name: '@deepseek-ai/dsh-identity'
  config:
    jwt:
      issuer: 'https://issuer.example'
      audience: 'karaka-api'
      jwksUrl: 'https://issuer.example/.well-known/jwks.json'
      algorithms: ['RS256']
      tenantIdClaim: 'tenant_id'
      timeoutMs: 5000
      cooldownMs: 30000
      cacheMaxAgeMs: 600000
      clockToleranceSeconds: 0
      additionalRequiredClaims: []
```

`issuer`, `audience`, `jwksUrl`, and `algorithms` are required inside `jwt`. HTTPS is required except for loopback HTTP in local development; URLs with credentials or fragments fail at plugin load. Request, refresh-cooldown, cache-age, and clock-tolerance policy remain deployment configuration with the shown defaults.

JWT `sub` becomes `userId`. When `tenantIdClaim` is configured, that claim becomes required and must contain a non-empty string that becomes `tenantId`. A verified tenant claim is signed identity input, not a resource-authorization decision; protected services must still enforce ownership and permissions separately.

HTTP Bearer resolution without `jwt` fails with `IDENTITY_VERIFICATION_UNAVAILABLE`. Invalid signatures or claims fail with `IDENTITY_CREDENTIAL_INVALID`; remote key retrieval, malformed key data, and timeouts fail with `IDENTITY_VERIFICATION_UNAVAILABLE`; caller cancellation fails promptly with `IDENTITY_VERIFICATION_ABORTED`, while an in-flight shared key fetch may finish and populate the process-local cache.

## Model Experience

### Normalized runtime identity

#### What the model sees

Nothing. `ctx.identity` remains model-hidden runtime context, and this package adds no prompt, tool, message, or request-body content.

#### Token effect

Zero tokens.

#### KV Cache effect

None; identity resolution does not change the model-visible prefix.

## Known Limitations and Deferred Work

- **One JWT issuer per plugin scope** — deployments serving several issuers mount isolated plugin instances or add a provider seam after a second implementation proves the need.
- **Process-local JWKS cache** — configuration or key-fetch policy changes require plugin reload, and worker instances do not share fetched keys.
- **No authorization decision** — roles, permissions, resource ownership, and session guards belong to separate plugins.
