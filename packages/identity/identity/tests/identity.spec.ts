import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose'
import Identity, {
  IdentityError,
  IdentityTenantId,
  IdentityUserId,
  type Config,
  type JwtConfig,
} from '../src/index.ts'

const ISSUER = 'https://issuer.example'
const AUDIENCE = 'karaka-api'
const KID = 'test-key'

let privateKey: CryptoKey
let otherPrivateKey: CryptoKey
let disallowedPrivateKey: CryptoKey
let publicJwk: JWK
let server: Server
let jwksUrl: string
let responseStatus = 200
let responseBody: unknown
let responseDelayMs = 0
let responseGate: Promise<void> | undefined
let requestCount = 0
let onRequest: (() => void) | undefined

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  const other = await generateKeyPair('RS256')
  const disallowed = await generateKeyPair('RS384')
  privateKey = pair.privateKey
  otherPrivateKey = other.privateKey
  disallowedPrivateKey = disallowed.privateKey
  publicJwk = { ...await exportJWK(pair.publicKey), kid: KID, alg: 'RS256', use: 'sig' }
  server = createServer((_request, response) => {
    requestCount += 1
    onRequest?.()
    const send = () => {
      response.statusCode = responseStatus
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(responseBody))
    }
    if (responseGate !== undefined) void responseGate.then(send)
    else if (responseDelayMs === 0) send()
    else setTimeout(send, responseDelayMs)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test server address')
  jwksUrl = `http://127.0.0.1:${String(address.port)}/jwks.json`
})

beforeEach(() => {
  responseStatus = 200
  responseBody = { keys: [publicJwk] }
  responseDelayMs = 0
  responseGate = undefined
  requestCount = 0
  onRequest = undefined
})

afterAll(async () => {
  server.close()
  await once(server, 'close')
})

function jwtConfig(overrides: Partial<JwtConfig> = {}): JwtConfig {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl,
    algorithms: ['RS256'],
    ...overrides,
  }
}

interface TokenOptions {
  issuer?: string
  audience?: string | string[]
  subject?: string | number | null
  issuedAt?: number | string | null
  expiresAt?: number | null
  algorithm?: 'RS256' | 'RS384'
  key?: CryptoKey
  tokenId?: string | number | null
  notBefore?: number
  tenantId?: string | number | null
}

async function token(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  const algorithm = options.algorithm ?? 'RS256'
  const claims: Record<string, unknown> = { nested: { roles: ['founder'] } }
  if (typeof options.subject === 'number') claims['sub'] = options.subject
  if (typeof options.issuedAt === 'string') claims['iat'] = options.issuedAt
  if (typeof options.tokenId === 'number') claims['jti'] = options.tokenId
  if (options.tenantId !== null) claims['tenant_id'] = options.tenantId ?? 'tenant-1'
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm, kid: KID })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
  if (options.subject !== null && typeof options.subject !== 'number') {
    jwt = jwt.setSubject(options.subject ?? 'user-1')
  }
  if (options.issuedAt !== null && typeof options.issuedAt !== 'string') {
    jwt = jwt.setIssuedAt(options.issuedAt ?? now)
  }
  if (options.expiresAt !== null) jwt = jwt.setExpirationTime(options.expiresAt ?? now + 60)
  if (options.tokenId !== null && typeof options.tokenId !== 'number') {
    jwt = jwt.setJti(options.tokenId ?? 'token-1')
  }
  if (options.notBefore !== undefined) jwt = jwt.setNotBefore(options.notBefore)
  return jwt.sign(options.key ?? privateKey)
}

async function boot(config: Config = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin(Identity, config)
  await fiber
  return { ctx, fiber }
}

async function verifyError(jwt: string, expected: IdentityError['code']): Promise<void> {
  const { ctx, fiber } = await boot({ jwt: jwtConfig() })
  await expect(ctx.identity.resolve({ kind: 'http-bearer', authorization: `Bearer ${jwt}` }))
    .rejects.toMatchObject({ name: 'IdentityError', code: expected })
  await fiber.dispose()
}

describe('trusted same-process identity', () => {
  it('normalizes a user and optional tenant into a detached immutable result', async () => {
    const { ctx, fiber } = await boot()
    const request = {
      kind: 'trusted' as const,
      userId: IdentityUserId('user-1'),
      tenantId: IdentityTenantId('tenant-1'),
    }
    const resolved = await ctx.identity.resolve(request)
    expect(resolved).toEqual({ source: 'trusted', userId: 'user-1', tenantId: 'tenant-1' })
    expect(resolved).not.toBe(request)
    expect(Object.isFrozen(resolved)).toBe(true)

    await expect(ctx.identity.resolve({
      kind: 'trusted',
      userId: IdentityUserId('user-2'),
    })).resolves.toEqual({ source: 'trusted', userId: 'user-2' })
    await fiber.dispose()
    expect(ctx.get('identity')).toBeUndefined()
  })

  it.each([
    'IDENTITY_CREDENTIAL_MISSING',
    'IDENTITY_CREDENTIAL_MALFORMED',
    'IDENTITY_CREDENTIAL_UNSUPPORTED',
    'IDENTITY_CREDENTIAL_INVALID',
    'IDENTITY_VERIFICATION_UNAVAILABLE',
    'IDENTITY_VERIFICATION_ABORTED',
  ] as const)('exposes a stable safe %s error', (code) => {
    const error = new IdentityError(code)
    expect(error).toMatchObject({ name: 'IdentityError', code })
    expect(error.message).not.toContain('secret-token')
    expect(error.cause).toBeUndefined()
  })

  it('rejects an unsupported runtime request with a stable safe error', async () => {
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.resolve({ kind: 'api-key' } as never))
      .rejects.toMatchObject({ code: 'IDENTITY_CREDENTIAL_UNSUPPORTED' })
    await fiber.dispose()
  })
})

describe('HTTP Bearer input', () => {
  it.each([
    [undefined, 'IDENTITY_CREDENTIAL_MISSING'],
    ['', 'IDENTITY_CREDENTIAL_MISSING'],
    [[], 'IDENTITY_CREDENTIAL_MISSING'],
    [['Bearer one', 'Bearer two'], 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Bearer', 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Bearer one,two', 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Bearer one two', 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Basic abc', 'IDENTITY_CREDENTIAL_UNSUPPORTED'],
  ] as const)('rejects %j with %s', async (authorization, code) => {
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.resolve({ kind: 'http-bearer', authorization }))
      .rejects.toMatchObject({ code })
    await fiber.dispose()
  })

  it.each([
    'Bearer opaque-token',
    'bearer opaque-token',
    '  BEARER\topaque-token  ',
    ['Bearer opaque-token'],
  ])('parses one strict value and reports unavailable JWT verification for %j', async (authorization) => {
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.resolve({ kind: 'http-bearer', authorization }))
      .rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await fiber.dispose()
  })

  it('rejects an already-aborted request before parsing or network work', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    await expect(ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: undefined,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    expect(requestCount).toBe(0)
    await fiber.dispose()
  })
})

describe('HTTP Bearer JWT verification', () => {
  it('verifies and returns a deeply immutable normalized user and tenant', async () => {
    const controller = new AbortController()
    const { ctx, fiber } = await boot({ jwt: jwtConfig({ tenantIdClaim: 'tenant_id' }) })
    const resolved = await ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token()}`,
      signal: controller.signal,
    })
    expect(resolved).toMatchObject({
      source: 'http-bearer',
      userId: 'user-1',
      tenantId: 'tenant-1',
      issuer: ISSUER,
      audiences: [AUDIENCE],
      tokenId: 'token-1',
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    if (resolved.source !== 'http-bearer') throw new Error('expected JWT identity')
    expect(Object.isFrozen(resolved.audiences)).toBe(true)
    expect(Object.isFrozen(resolved.claims)).toBe(true)
    expect(Object.isFrozen(resolved.claims['nested'])).toBe(true)
    const nested = resolved.claims['nested'] as { readonly roles: readonly string[] }
    expect(Object.isFrozen(nested.roles)).toBe(true)
    expect(() => { (nested.roles as string[]).push('admin') }).toThrow(TypeError)
    await fiber.dispose()
  })

  it('copies attacker-controlled claim keys into null-prototype frozen objects', async () => {
    const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const now = Math.floor(Date.now() / 1_000)
    const jwt = await new SignJWT(dangerous)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey)
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    const resolved = await ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${jwt}`,
    })
    if (resolved.source !== 'http-bearer') throw new Error('expected JWT identity')
    expect(Object.getPrototypeOf(resolved.claims)).toBeNull()
    expect(Object.getPrototypeOf(resolved.claims['__proto__'])).toBeNull()
    expect(resolved.claims['__proto__']).toEqual({ polluted: true })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    await fiber.dispose()
  })

  it('rejects a bad signature without exposing the credential', async () => {
    const controller = new AbortController()
    const jwt = await token({ key: otherPrivateKey })
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    const error = await ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${jwt}`,
      signal: controller.signal,
    })
      .then(() => undefined, (caught: unknown) => caught as IdentityError)
    expect(error).toMatchObject({ code: 'IDENTITY_CREDENTIAL_INVALID' })
    expect(error?.message).not.toContain(jwt)
    expect(error?.cause).toBeUndefined()
    await fiber.dispose()
  })

  it.each([
    ['wrong issuer', () => token({ issuer: 'https://other.example' })],
    ['wrong audience', () => token({ audience: 'other-api' })],
    ['expired token', () => token({ expiresAt: Math.floor(Date.now() / 1_000) - 1 })],
    ['missing subject', () => token({ subject: null })],
    ['missing issued-at', () => token({ issuedAt: null })],
    ['missing expiration', () => token({ expiresAt: null })],
    ['empty subject', () => token({ subject: '' })],
    ['non-numeric issued-at', () => token({ issuedAt: 'yesterday' })],
    ['non-string token id', () => token({ tokenId: 7 })],
    ['disallowed algorithm', () => token({ algorithm: 'RS384', key: disallowedPrivateKey })],
  ] as const)('rejects %s as an invalid credential', async (_name, makeToken) => {
    await verifyError(await makeToken(), 'IDENTITY_CREDENTIAL_INVALID')
  })

  it('normalizes audience arrays and optional registered claims', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    await expect(ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token({
        audience: [AUDIENCE, 'secondary'],
        notBefore: now - 1,
        tokenId: null,
      })}`,
    })).resolves.toMatchObject({ audiences: [AUDIENCE, 'secondary'], notBefore: now - 1 })
    const resolved = await ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token({ tokenId: null })}`,
    })
    expect(resolved).not.toHaveProperty('tokenId')
    expect(resolved).not.toHaveProperty('tenantId')
    await fiber.dispose()
  })

  it('requires and validates the configured tenant claim', async () => {
    const { ctx, fiber } = await boot({ jwt: jwtConfig({ tenantIdClaim: 'tenant_id' }) })
    await expect(ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token({ tenantId: null })}`,
    })).rejects.toMatchObject({ code: 'IDENTITY_CREDENTIAL_INVALID' })
    await expect(ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token({ tenantId: 7 })}`,
    })).rejects.toMatchObject({ code: 'IDENTITY_CREDENTIAL_INVALID' })
    await fiber.dispose()
  })

  it('requires configured additional claims and accepts clock tolerance', async () => {
    const withRequiredClaim = await boot({
      jwt: jwtConfig({ additionalRequiredClaims: ['jti', 'sub'] }),
    })
    await expect(withRequiredClaim.ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token({ tokenId: null })}`,
    })).rejects.toMatchObject({ code: 'IDENTITY_CREDENTIAL_INVALID' })
    await withRequiredClaim.fiber.dispose()

    const tolerant = await boot({ jwt: jwtConfig({ clockToleranceSeconds: 5 }) })
    await expect(tolerant.ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token({ expiresAt: Math.floor(Date.now() / 1_000) - 1 })}`,
    })).resolves.toMatchObject({ userId: 'user-1' })
    await tolerant.fiber.dispose()
  })

  it('reuses the process-local remote JWKS cache', async () => {
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    await ctx.identity.resolve({ kind: 'http-bearer', authorization: `Bearer ${await token()}` })
    await ctx.identity.resolve({ kind: 'http-bearer', authorization: `Bearer ${await token()}` })
    expect(requestCount).toBe(1)
    await fiber.dispose()
  })

  it('distinguishes JWKS retrieval failure from an invalid credential', async () => {
    responseStatus = 503
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    await expect(ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token()}`,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await fiber.dispose()
  })

  it('classifies malformed remote key data and fetch timeouts as unavailable', async () => {
    responseBody = { keys: 'not-an-array' }
    const malformed = await boot({ jwt: jwtConfig() })
    await expect(malformed.ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token()}`,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await malformed.fiber.dispose()

    responseBody = { keys: [publicJwk] }
    responseDelayMs = 20
    const timedOut = await boot({ jwt: jwtConfig({ timeoutMs: 1 }) })
    await expect(timedOut.ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token()}`,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await timedOut.fiber.dispose()
  })

  it('honors cancellation during successful and failed key fetches', async () => {
    const successful = new AbortController()
    onRequest = () => { successful.abort() }
    const first = await boot({ jwt: jwtConfig() })
    await expect(first.ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token()}`,
      signal: successful.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    await first.fiber.dispose()

    const failed = new AbortController()
    responseStatus = 503
    onRequest = () => { failed.abort() }
    const second = await boot({ jwt: jwtConfig() })
    await expect(second.ctx.identity.resolve({
      kind: 'http-bearer',
      authorization: `Bearer ${await token()}`,
      signal: failed.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    await second.fiber.dispose()
  })

  it('settles cancellation while a shared JWKS fetch remains in flight', async () => {
    const controller = new AbortController()
    let requestReachedServer!: () => void
    const requestReached = new Promise<void>((resolve) => { requestReachedServer = resolve })
    let releaseResponse!: () => void
    responseGate = new Promise<void>((resolve) => { releaseResponse = resolve })
    onRequest = requestReachedServer
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    const authorization = `Bearer ${await token()}`
    const resolution = ctx.identity.resolve({
      kind: 'http-bearer',
      authorization,
      signal: controller.signal,
    })

    await requestReached
    controller.abort()
    try {
      await expect(resolution).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    } finally {
      releaseResponse()
    }
    await expect(ctx.identity.resolve({ kind: 'http-bearer', authorization }))
      .resolves.toMatchObject({ userId: 'user-1' })
    expect(requestCount).toBe(1)
    await fiber.dispose()
  })

  it('observes cancellation immediately before abort-listener registration', async () => {
    const controller = new AbortController()
    const addEventListener = controller.signal.addEventListener.bind(controller.signal)
    controller.signal.addEventListener = (...args) => {
      // Reproduce an abort after the service's initial check but before listener installation.
      controller.abort()
      addEventListener(...args)
    }
    const { ctx, fiber } = await boot({ jwt: jwtConfig() })
    const authorization = `Bearer ${await token()}`

    await expect(ctx.identity.resolve({
      kind: 'http-bearer',
      authorization,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    await expect(ctx.identity.resolve({ kind: 'http-bearer', authorization }))
      .resolves.toMatchObject({ userId: 'user-1' })
    await fiber.dispose()
  })
})

describe('JWT configuration', () => {
  it('resolves every timing default when mounted directly', () => {
    expect(new Identity(new Context(), { jwt: jwtConfig() })).toBeInstanceOf(Identity)
  })

  it.each([
    [{ jwksUrl: 'http://keys.example/jwks' }, /HTTPS/],
    [{ jwksUrl: 'ftp://127.0.0.1/jwks' }, /HTTPS/],
    [{ jwksUrl: 'https://user:secret@keys.example/jwks' }, /credentials/],
    [{ jwksUrl: 'https://keys.example/jwks#fragment' }, /fragment/],
    [{ jwksUrl: 'not a url' }, /Invalid URL/],
    [{ algorithms: [] }, /at least one/],
    [{ audience: [] }, /at least one/],
    [{ issuer: ' issuer' }, /non-empty string/],
    [{ algorithms: [' '] }, /non-empty string/],
    [{ additionalRequiredClaims: [' '] }, /non-empty string/],
    [{ tenantIdClaim: ' tenant' }, /non-empty string/],
    [{ timeoutMs: -1 }, /non-negative/],
    [{ cooldownMs: 1.5 }, /non-negative/],
    [{ cacheMaxAgeMs: -1 }, /non-negative/],
    [{ clockToleranceSeconds: 1.5 }, /non-negative/],
  ] as const)('rejects unsafe or malformed config %j at construction', (overrides, message) => {
    const ctx = new Context()
    expect(() => new Identity(ctx, { jwt: jwtConfig(overrides as Partial<JwtConfig>) })).toThrow(message)
  })

  it('accepts an audience array and explicit cache timing policy', async () => {
    const { fiber } = await boot({
      jwt: jwtConfig({
        audience: [AUDIENCE, 'secondary'],
        cooldownMs: 1,
        cacheMaxAgeMs: 1,
      }),
    })
    await fiber.dispose()
  })
})

describe('real Loader composition', () => {
  it('mounts one package row and resolves trusted and HTTP identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-identity-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-identity'",
      '  config:',
      '    jwt:',
      `      issuer: '${ISSUER}'`,
      `      audience: '${AUDIENCE}'`,
      `      jwksUrl: '${jwksUrl}'`,
      '      algorithms:',
      "        - 'RS256'",
      "      tenantIdClaim: 'tenant_id'",
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-identity') {
          throw new Error(`unexpected Loader import: ${specifier}`)
        }
        return Identity
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    try {
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href },
      })
      await ctx.loader.await()
      await expect(ctx.identity.resolve({
        kind: 'trusted',
        userId: IdentityUserId('host-user'),
      })).resolves.toEqual({ source: 'trusted', userId: 'host-user' })
      await expect(ctx.identity.resolve({
        kind: 'http-bearer',
        authorization: `Bearer ${await token()}`,
      })).resolves.toMatchObject({ userId: 'user-1', tenantId: 'tenant-1', issuer: ISSUER })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
