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
import { IdentityError, type VerifiedIdentity } from '@deepseek-ai/dsh-identity'
import IdentityHttpBearer from '@deepseek-ai/dsh-identity-http-bearer'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose'
import JwksIdentity, {
  DEFAULT_JWKS_CACHE_MAX_AGE_MS,
  DEFAULT_JWKS_COOLDOWN_MS,
  DEFAULT_JWKS_TIMEOUT_MS,
  resolveIdentityJwksSpec,
  type Config,
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
    onRequest?.()
    const send = () => {
      response.statusCode = responseStatus
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(responseBody))
    }
    if (responseDelayMs === 0) send()
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
  onRequest = undefined
})

afterAll(async () => {
  server.close()
  await once(server, 'close')
})

function config(overrides: Partial<Config> = {}): Config {
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
}

async function token(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  const algorithm = options.algorithm ?? 'RS256'
  const claims: Record<string, unknown> = { nested: { roles: ['founder'] } }
  if (typeof options.subject === 'number') claims['sub'] = options.subject
  if (typeof options.issuedAt === 'string') claims['iat'] = options.issuedAt
  if (typeof options.tokenId === 'number') claims['jti'] = options.tokenId
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

async function boot(overrides: Partial<Config> = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin(JwksIdentity, config(overrides))
  await fiber
  return { ctx, fiber }
}

async function verifyError(jwt: string, expected: IdentityError['code']): Promise<void> {
  const { ctx, fiber } = await boot()
  await expect(ctx.identity.verify({ credential: { kind: 'bearer', token: jwt } }))
    .rejects.toMatchObject({ name: 'IdentityError', code: expected })
  await fiber.dispose()
}

describe('JWKS identity provider', () => {
  it('verifies registered claims and returns a deeply immutable identity', async () => {
    const { ctx, fiber } = await boot()
    const verified = await ctx.identity.verify({ credential: { kind: 'bearer', token: await token() } })
    expect(verified).toMatchObject({
      issuer: ISSUER,
      subject: 'user-1',
      audiences: [AUDIENCE],
      tokenId: 'token-1',
    })
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.audiences)).toBe(true)
    expect(Object.isFrozen(verified.claims)).toBe(true)
    expect(Object.isFrozen(verified.claims['nested'])).toBe(true)
    const nested = verified.claims['nested'] as { readonly roles: readonly string[] }
    expect(Object.isFrozen(nested.roles)).toBe(true)
    expect(() => { (nested.roles as string[]).push('admin') }).toThrow(TypeError)
    await fiber.dispose()
    expect(ctx.get('identity')).toBeUndefined()
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
    const { ctx, fiber } = await boot()
    const verified = await ctx.identity.verify({ credential: { kind: 'bearer', token: jwt } })
    expect(Object.getPrototypeOf(verified.claims)).toBeNull()
    expect(Object.getPrototypeOf(verified.claims['__proto__'])).toBeNull()
    expect(verified.claims['__proto__']).toEqual({ polluted: true })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    await fiber.dispose()
  })

  it('rejects a bad signature without exposing the credential', async () => {
    const jwt = await token({ key: otherPrivateKey })
    const { ctx, fiber } = await boot()
    const error = await ctx.identity.verify({ credential: { kind: 'bearer', token: jwt } })
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

  it('normalizes a verified audience array and includes not-before without inventing a token id', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.verify({
      credential: {
        kind: 'bearer',
        token: await token({ audience: [AUDIENCE, 'secondary'], notBefore: now - 1, tokenId: null }),
      },
    })).resolves.toMatchObject({ audiences: [AUDIENCE, 'secondary'], notBefore: now - 1 })
    const verified = await ctx.identity.verify({
      credential: { kind: 'bearer', token: await token({ tokenId: null }) },
    })
    expect(verified).not.toHaveProperty('tokenId')
    await fiber.dispose()
  })

  it.each([
    { kind: 'api-key', token: 'value' },
    { kind: 'bearer', token: '' },
    { kind: 'bearer', token: 42 },
  ])('rejects a malformed runtime credential envelope %j', async (credential) => {
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.verify({ credential } as never))
      .rejects.toMatchObject({ code: 'IDENTITY_CREDENTIAL_INVALID' })
    await fiber.dispose()
  })

  it('distinguishes JWKS retrieval failure from an invalid credential', async () => {
    responseStatus = 503
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.verify({ credential: { kind: 'bearer', token: await token() } }))
      .rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await fiber.dispose()
  })

  it('classifies malformed remote key data and fetch timeouts as unavailable', async () => {
    responseBody = { keys: 'not-an-array' }
    const malformed = await boot()
    await expect(malformed.ctx.identity.verify({
      credential: { kind: 'bearer', token: await token() },
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await malformed.fiber.dispose()

    responseBody = { keys: [publicJwk] }
    responseDelayMs = 20
    const timedOut = await boot({ timeoutMs: 1 })
    await expect(timedOut.ctx.identity.verify({
      credential: { kind: 'bearer', token: await token() },
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_UNAVAILABLE' })
    await timedOut.fiber.dispose()
  })

  it('rejects before network work when cancellation is already requested', async () => {
    const controller = new AbortController()
    controller.abort()
    const { ctx, fiber } = await boot()
    await expect(ctx.identity.verify({
      credential: { kind: 'bearer', token: await token() },
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    await fiber.dispose()
  })

  it('honors cancellation that arrives during a successful or failed key fetch', async () => {
    const successful = new AbortController()
    onRequest = () => { successful.abort() }
    const first = await boot()
    await expect(first.ctx.identity.verify({
      credential: { kind: 'bearer', token: await token() },
      signal: successful.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    await first.fiber.dispose()

    const failed = new AbortController()
    responseStatus = 503
    onRequest = () => { failed.abort() }
    const second = await boot()
    await expect(second.ctx.identity.verify({
      credential: { kind: 'bearer', token: await token() },
      signal: failed.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    await second.fiber.dispose()
  })
})

describe('JWKS provider configuration', () => {
  it('resolves documented defaults and baseline required claims explicitly', () => {
    const spec = resolveIdentityJwksSpec(config({ additionalRequiredClaims: ['jti', 'sub'] }))
    expect(spec).toMatchObject({
      timeoutMs: DEFAULT_JWKS_TIMEOUT_MS,
      cooldownMs: DEFAULT_JWKS_COOLDOWN_MS,
      cacheMaxAgeMs: DEFAULT_JWKS_CACHE_MAX_AGE_MS,
      clockToleranceSeconds: 0,
      requiredClaims: ['sub', 'iat', 'exp', 'jti'],
    })
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec.algorithms)).toBe(true)
    expect(resolveIdentityJwksSpec(config({ audience: [AUDIENCE, 'secondary'] })).audience)
      .toEqual([AUDIENCE, 'secondary'])
  })

  it.each([
    [{ jwksUrl: 'http://keys.example/jwks' }, /HTTPS/],
    [{ jwksUrl: 'ftp://127.0.0.1/jwks' }, /HTTPS/],
    [{ jwksUrl: 'https://user:secret@keys.example/jwks' }, /credentials/],
    [{ algorithms: [] }, /at least one/],
    [{ audience: [] }, /at least one/],
    [{ issuer: ' issuer' }, /non-empty string/],
    [{ algorithms: [' '] }, /non-empty string/],
    [{ additionalRequiredClaims: [' '] }, /non-empty string/],
    [{ timeoutMs: -1 }, /non-negative/],
    [{ timeoutMs: 1.5 }, /non-negative/],
  ] as const)('rejects unsafe or malformed config %j', (overrides, message) => {
    expect(() => resolveIdentityJwksSpec(config(overrides as Partial<Config>))).toThrow(message)
  })

  it('returns the service contract rather than an authority object', async () => {
    const { ctx, fiber } = await boot()
    const verified: VerifiedIdentity = await ctx.identity.verify({
      credential: { kind: 'bearer', token: await token() },
    })
    expect(verified).not.toHaveProperty('tenantId')
    expect(verified).not.toHaveProperty('roles')
    expect(verified).not.toHaveProperty('permissions')
    await fiber.dispose()
  })
})

describe('real Loader composition', () => {
  it('mounts the provider and Consumer rows and verifies through the assembled seam', async () => {
    responseStatus = 200
    const root = await mkdtemp(join(tmpdir(), 'dsh-identity-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-identity-jwks'",
      '  config:',
      `    issuer: '${ISSUER}'`,
      `    audience: '${AUDIENCE}'`,
      `    jwksUrl: '${jwksUrl}'`,
      '    algorithms:',
      "      - 'RS256'",
      "- name: '@deepseek-ai/dsh-identity-http-bearer'",
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-identity-jwks', JwksIdentity],
      ['@deepseek-ai/dsh-identity-http-bearer', IdentityHttpBearer],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>

    try {
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(configPath).href },
      })
      await ctx.loader.await()
      await expect(ctx.identityHttpBearer.authenticate({
        authorization: `Bearer ${await token()}`,
      })).resolves.toMatchObject({ subject: 'user-1', issuer: ISSUER })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
