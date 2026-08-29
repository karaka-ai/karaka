# Authentication

English | [中文](README.zh.md)

`@karaka/authentication` is Karaka's Authentication seam. The package root provides the provider-neutral `ctx.authentication` service, tenant router, current-principal resolver, and identity contract. Two built-in plugin subpaths establish identities in different trust models:

- `@karaka/authentication/authentication-jwks` verifies bearer tokens through configured tenant JWKS endpoints.
- `@karaka/authentication/authentication-host` accepts an identity assertion from a trusted embedding application.

Authentication establishes an identity. It does not make authorization, entitlement, or session decisions.

## Trusted-host development

The host plugin is the shortest path for local development and embedded applications whose host has already authenticated the caller:

```yaml
- name: '@karaka/authentication'
- name: '@karaka/authentication/authentication-host'
  config:
    tenantId: local
    subject: developer
    claims:
      role: developer
```

This makes `await ctx.authentication.currentPrincipal()` return the configured identity with `provider: 'host'`. The configuration is a trust assertion, not evidence that Karaka verifies. Only trusted deployment configuration or trusted host code may supply it; never populate it directly from model output, request parameters, or other untrusted input.

The static YAML form is intended for a single local identity. A shared-process host instead mounts one adapter that reads its request-local state:

```ts
import { authenticationHost } from '@karaka/authentication/authentication-host'

await ctx.plugin(authenticationHost({
  currentPrincipal: () => hostAuthentication.currentPrincipal(),
}))
```

The callback may use asynchronous local storage or an equivalent framework mechanism and returns `null` or `undefined` when no invocation is active. It must never read one mutable global principal. Concurrent callers share the same Cordis graph while `currentPrincipal()` resolves each caller independently. Disposing the adapter rejects new lookups and waits for lookups already in flight.

## Verify tokens from YAML

Both rows are ordinary Cordis plugins. The package root owns the registry; the JWKS subpath contributes a verifier:

```yaml
- name: '@karaka/authentication'
- name: '@karaka/authentication/authentication-jwks'
  config:
    name: customer-jwks
    tenants:
      acme:
        issuer: https://identity.example.com/
        audience: karaka-api
        jwksUri: https://identity.example.com/.well-known/jwks.json
        algorithms: [RS256]
        tenantClaim: org_id
        tenantValue: org_acme
      beta:
        issuer: https://identity.example.com/
        audience: karaka-api
        jwksUri: https://identity.example.com/.well-known/jwks.json
        algorithms: [RS256]
        tenantClaim: org_id
        tenantValue: org_beta
```

The provider routes only by the `tenantId` supplied by its caller. It verifies the token against that tenant's configured JWKS URL, issuer, audience, algorithm allowlist, expiration, subject, and optional tenant claim. It never reads a JWKS URL from an unverified token.

When tenants share an issuer and any audience, each must configure a distinct signed tenant claim. This prevents a valid token for one tenant from being replayed as another tenant.

## Verify a token

```ts
const identity = await ctx.authentication.authenticate({
  tenantId: 'acme',
  token,
})

identity.tenantId
identity.subject
identity.provider
identity.claims
```

The caller must obtain `tenantId` from its trusted routing context, such as the resolved workspace or tenant host. Downstream authorization must use the returned, verified identity rather than unverified token data.

## Add a provider

User plugins implement the public `AuthenticationProvider` contract and register through the same Cordis service as the built-in JWKS plugin:

```ts
import type { Context } from '@karaka/cordis'
import type { AuthenticationProvider } from '@karaka/authentication'

export const name = 'company-authentication'
export const inject = ['authentication']

export function apply(ctx: Context) {
  const provider: AuthenticationProvider = {
    name: 'company',
    tenantIds: ['internal'],
    async authenticate(request) {
      return verifyCompanyToken(request)
    },
  }

  ctx.authentication.register(provider)
}
```

The registration is a Cordis effect owned by the contributing plugin. Unloading that plugin removes its provider and tenant routes.
