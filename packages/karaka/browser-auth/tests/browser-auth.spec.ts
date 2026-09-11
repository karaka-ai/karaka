import { Context } from '@deepseek-ai/cordis'
import { exportSPKI, generateKeyPair, SignJWT, jwtVerify } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as BrowserAuth from '../src/index.ts'

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>()
  return { ...actual, jwtVerify: vi.fn(actual.jwtVerify) }
})

const roots: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture() {
  const ctx = new Context()
  roots.push(ctx)
  const { publicKey, privateKey } = await generateKeyPair('ES256')
  const config: BrowserAuth.Config = {
    applicationId: 'app', issuer: 'issuer', audience: 'karaka', maxTokenAgeSeconds: 300,
    keys: [{ id: 'one', algorithm: 'ES256', publicKey: await exportSPKI(publicKey) }],
  }
  const fiber = await ctx.plugin(BrowserAuth, config)
  const now = Math.floor(Date.now() / 1000)
  const sign = (claims: Record<string, unknown> = {}, keyId: string | null = 'one') => new SignJWT({
    iss: 'issuer', aud: 'karaka', iat: now, exp: now + 120,
    applicationId: 'app', tenantId: 'tenant', userId: 'user', ...claims,
  }).setProtectedHeader({ alg: 'ES256', ...(keyId === null ? {} : { kid: keyId }) }).sign(privateKey)
  return { ctx, config, fiber, sign, now }
}

describe('browser application credentials', () => {
  it('verifies all three owner identifiers and retains expiry', async () => {
    const { ctx, sign, now } = await fixture()
    await expect(ctx.connectionAuth.authenticate(await sign())).resolves.toEqual({
      kind: 'application', owner: { applicationId: 'app', tenantId: 'tenant', userId: 'user' }, expiresAt: (now + 120) * 1000,
    })
  })

  it.each([
    { iss: 'other' }, { aud: 'other' }, { applicationId: 'other' }, { tenantId: '' },
    { userId: '' }, { userId: 1 }, { exp: 1 }, { exp: undefined }, { iat: undefined },
    { nbf: 9_000_000_000 }, { iat: 9_000_000_000 }, { exp: 9_000_000_000 },
  ])('rejects invalid claims %j', async (claims) => {
    const { ctx, sign } = await fixture()
    await expect(ctx.connectionAuth.authenticate(await sign(claims))).resolves.toBeUndefined()
  })

  it('rejects unknown keys, malformed tokens and invalid signatures', async () => {
    const { ctx, sign } = await fixture()
    await expect(ctx.connectionAuth.authenticate(await sign({}, 'unknown'))).resolves.toBeUndefined()
    await expect(ctx.connectionAuth.authenticate(await sign({}, null))).resolves.toBeUndefined()
    await expect(ctx.connectionAuth.authenticate('not-a-token')).resolves.toBeUndefined()
    const token = await sign()
    const [header, body] = token.split('.')
    await expect(ctx.connectionAuth.authenticate(`${header}.${body}.${'A'.repeat(86)}`)).resolves.toBeUndefined()
  })

  it('rejects duplicate or invalid verification keys at load', async () => {
    const { config, fiber } = await fixture()
    await fiber.dispose()
    const ctx = new Context()
    roots.push(ctx)
    await expect(BrowserAuth.apply(ctx, {
      applicationId: config.applicationId, issuer: config.issuer, audience: config.audience,
      maxTokenAgeSeconds: config.maxTokenAgeSeconds, keys: [config.keys[0]!, config.keys[0]!],
    }))
      .rejects.toThrow('unique')
    await expect(BrowserAuth.apply(ctx, {
      applicationId: config.applicationId, issuer: config.issuer, audience: config.audience,
      maxTokenAgeSeconds: config.maxTokenAgeSeconds, keys: [{ ...config.keys[0]!, publicKey: 'invalid' }],
    }))
      .rejects.toThrow()
  })

  it('propagates an unavailable platform verifier', async () => {
    const { ctx, sign } = await fixture()
    const token = await sign()
    const failure = new Error('platform verification unavailable')
    vi.mocked(jwtVerify).mockRejectedValueOnce(failure)
    await expect(ctx.connectionAuth.authenticate(token)).rejects.toBe(failure)
  })

  it('withdraws the verifier with its plugin', async () => {
    const { ctx, fiber } = await fixture()
    expect(ctx.get('connectionAuth')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('connectionAuth')).toBeUndefined()
  })
})
