import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { AuthenticationError, AuthenticationService, type AuthenticationProvider } from '@karaka/authentication'
import AuthenticationHost from '@karaka/authentication/authentication-host'
import AuthenticationJwks, {
  JwksAuthenticationProvider,
  type JwksAlgorithm,
  type JwksTenantConfig,
} from '@karaka/authentication/authentication-jwks'
import { Context } from '@karaka/cordis'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const issuer = 'https://issuer.example.test/'
const audience = 'karaka-api'
const keyId = 'test-key'

let server: Server
let jwksUri: string
let privateKey: CryptoKey
let publicJwk: JWK
let jwksRequests = 0

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  publicJwk = {
    ...await exportJWK(pair.publicKey),
    alg: 'RS256',
    kid: keyId,
    use: 'sig',
  }
  server = createServer((_request, response) => {
    jwksRequests++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ keys: [publicJwk] }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  jwksUri = `http://127.0.0.1:${address.port}/jwks`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
})

describe('Authentication seam', () => {
  it('scopes trusted host identities to independent embedded callers', async () => {
    const root = new Context()
    const acme = root.isolate('identity')
    const beta = root.isolate('identity')

    const acmeHost = acme.plugin(AuthenticationHost, {
      tenantId: 'acme',
      subject: 'user-acme',
      claims: { role: 'developer' },
    })
    const betaHost = beta.plugin(AuthenticationHost, {
      tenantId: 'beta',
      subject: 'user-beta',
    })
    await Promise.all([acmeHost, betaHost])

    expect(root.get('identity')).toBeUndefined()
    expect(acme.identity).toEqual({
      tenantId: 'acme',
      subject: 'user-acme',
      provider: 'host',
      claims: { role: 'developer' },
    })
    expect(beta.identity).toEqual({
      tenantId: 'beta',
      subject: 'user-beta',
      provider: 'host',
      claims: {},
    })

    const observed: string[] = []
    const consumer = acme.plugin({
      name: 'identity-consumer',
      inject: ['identity'],
      apply(ctx) {
        observed.push(`${ctx.identity.tenantId}:${ctx.identity.subject}`)
      },
    })
    await consumer
    expect(observed).toEqual(['acme:user-acme'])

    await acmeHost.dispose()
    expect(acme.get('identity')).toBeUndefined()
    expect(beta.identity.subject).toBe('user-beta')

    await root.fiber.dispose()
  })

  it('rejects empty trusted host identity fields', async () => {
    const ctx = new Context().isolate('identity')
    const host = ctx.plugin(AuthenticationHost, {
      tenantId: ' ',
      subject: 'developer',
    })

    await expect(host).rejects.toThrow('tenant ID must be a non-empty string')
    expect(ctx.get('identity')).toBeUndefined()
    await ctx.root.fiber.dispose()
  })

  it('owns custom provider registrations through the contributing Cordis plugin', async () => {
    const ctx = new Context()
    const authentication = ctx.plugin(AuthenticationService)
    await authentication

    const provider: AuthenticationProvider = {
      name: 'company',
      tenantIds: ['private'],
      async authenticate(request) {
        return {
          tenantId: request.tenantId,
          subject: 'user-1',
          provider: 'company',
          claims: { source: 'private-sso' },
        }
      },
    }
    const custom = ctx.plugin({
      name: 'company-authentication',
      inject: ['authentication'],
      apply(pluginContext) {
        pluginContext.authentication.register(provider)
      },
    })
    await custom

    await expect(ctx.authentication.authenticate({ tenantId: 'private', token: 'opaque' })).resolves.toMatchObject({
      tenantId: 'private',
      subject: 'user-1',
      provider: 'company',
    })
    expect(ctx.authentication.list()).toEqual([{ name: 'company', tenantIds: ['private'] }])

    await custom.dispose()
    await expect(ctx.authentication.authenticate({ tenantId: 'private', token: 'opaque' })).rejects.toMatchObject({
      code: 'UNKNOWN_TENANT',
    })
    expect(ctx.authentication.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('verifies shared-issuer tenants against distinct verified tenant claims', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationService)
    const jwksProvider = ctx.plugin(AuthenticationJwks, {
      name: 'customer-jwks',
      tenants: {
        acme: tenantConfig('org_id', 'org_acme'),
        beta: tenantConfig('org_id', 'org_beta'),
      },
    })
    await jwksProvider

    const acmeToken = await signToken('user-acme', 'org_acme')
    const betaToken = await signToken('user-beta', 'org_beta')

    await expect(ctx.authentication.authenticate({ tenantId: 'acme', token: acmeToken })).resolves.toMatchObject({
      tenantId: 'acme',
      subject: 'user-acme',
      provider: 'customer-jwks',
      claims: { org_id: 'org_acme' },
    })
    await expect(ctx.authentication.authenticate({ tenantId: 'beta', token: betaToken })).resolves.toMatchObject({
      tenantId: 'beta',
      subject: 'user-beta',
      provider: 'customer-jwks',
      claims: { org_id: 'org_beta' },
    })
    await expect(ctx.authentication.authenticate({ tenantId: 'beta', token: acmeToken })).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    })
    await expect(ctx.authentication.authenticate({
      tenantId: 'acme',
      token: await signToken('wrong-audience', 'org_acme', { tokenAudience: 'another-api' }),
    })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(ctx.authentication.authenticate({
      tenantId: 'acme',
      token: await signToken('no-expiration', 'org_acme', { expires: false }),
    })).rejects.toMatchObject({ code: 'INVALID_TOKEN' })

    await jwksProvider.dispose()
    await expect(ctx.authentication.authenticate({ tenantId: 'acme', token: acmeToken })).rejects.toMatchObject({
      code: 'UNKNOWN_TENANT',
    })
    await ctx.fiber.dispose()
  })

  it('rejects ambiguous tenant configuration before registering the provider', () => {
    expect(() => new JwksAuthenticationProvider({
      tenants: {
        acme: tenantConfig(),
        beta: tenantConfig(),
      },
    })).toThrow('share issuer and audience')
  })

  it('does not contact JWKS endpoints for unknown tenants or malformed requests', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationService)
    const before = jwksRequests

    await expect(ctx.authentication.authenticate({ tenantId: 'missing', token: 'anything' })).rejects.toEqual(
      expect.objectContaining<Partial<AuthenticationError>>({ code: 'UNKNOWN_TENANT' }),
    )
    await expect(ctx.authentication.authenticate({ tenantId: '', token: 'anything' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    expect(jwksRequests).toBe(before)
    await ctx.fiber.dispose()
  })
})

function tenantConfig(tenantClaim?: string, tenantValue?: string): JwksTenantConfig {
  const config: JwksTenantConfig = {
    issuer,
    audience,
    jwksUri,
    algorithms: ['RS256'] satisfies JwksAlgorithm[],
  }
  if (tenantClaim !== undefined && tenantValue !== undefined) {
    config.tenantClaim = tenantClaim
    config.tenantValue = tenantValue
  }
  return config
}

interface SignTokenOptions {
  tokenAudience?: string
  expires?: boolean
}

function signToken(subject: string, organization: string, options: SignTokenOptions = {}) {
  const token = new SignJWT({ org_id: organization })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(issuer)
    .setAudience(options.tokenAudience ?? audience)
    .setSubject(subject)
    .setIssuedAt()
  if (options.expires !== false) token.setExpirationTime('5m')
  return token.sign(privateKey)
}
