import { Context } from '@deepseek-ai/cordis'
import { exportSPKI, generateKeyPair, jwtVerify, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, type Config } from '../src/index.ts'

vi.mock('jose', async (original) => {
  const jose = await original<typeof import('jose')>()
  return { ...jose, jwtVerify: vi.fn(jose.jwtVerify) }
})

let keys: Awaited<ReturnType<typeof generateKeyPair>>
let publicKey: string
const contexts: Context[] = []

beforeAll(async () => {
  keys = await generateKeyPair('ES256')
  publicKey = await exportSPKI(keys.publicKey)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function configuration(entries?: Config['keys']): Config {
  return {
    applicationId: 'app', issuer: 'issuer', audience: 'karaka', maxTokenAgeSeconds: 300,
    keys: entries ?? [{ id: 'key', algorithm: 'ES256', publicKey }],
  }
}

async function verifier() {
  const ctx = new Context()
  contexts.push(ctx)
  await apply(ctx, configuration())
  return ctx.karakaBrowserAuth
}

async function credential(overrides: Record<string, unknown> = {}, kid = 'key') {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    applicationId: 'app', tenantId: 'tenant', userId: 'user',
    iss: 'issuer', aud: 'karaka', iat: now, exp: now + 120, ...overrides,
  }).setProtectedHeader({ alg: 'ES256', kid }).sign(keys.privateKey)
}

describe('browser credentials', () => {
  it('returns the signed owner and expiration in milliseconds', async () => {
    const auth = await verifier()
    const exp = Math.floor(Date.now() / 1000) + 120
    expect(await auth.authenticate(await credential({ exp }))).toEqual({
      kind: 'application',
      owner: { applicationId: 'app', tenantId: 'tenant', userId: 'user' },
      expiresAt: exp * 1000,
    })
  })

  it.each([
    ['foreign application', { applicationId: 'another' }],
    ['foreign issuer', { iss: 'another' }],
    ['foreign audience', { aud: 'another' }],
    ['empty tenant', { tenantId: '' }],
    ['non-string user', { userId: 1 }],
    ['missing owner claim', { userId: undefined }],
    ['expired credential', { iat: 1, exp: 2 }],
    ['excessive issued lifetime', { iat: 1, exp: 4_102_444_800 }],
    ['future issuance', { iat: 4_102_444_000, exp: 4_102_444_100 }],
  ])('denies %s', async (_label, claims) => {
    expect(await (await verifier()).authenticate(await credential(claims))).toBeUndefined()
  })

  it('denies malformed tokens, unknown keys, and signatures from another key', async () => {
    const auth = await verifier()
    expect(await auth.authenticate('not-a-jwt')).toBeUndefined()
    expect(await auth.authenticate(await credential({}, 'unknown'))).toBeUndefined()
    const other = await generateKeyPair('ES256')
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'key' }).sign(other.privateKey)
    expect(await auth.authenticate(forged)).toBeUndefined()
  })

  it('refuses duplicate key ids and invalid public keys before publishing the service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const config = configuration()
    await expect(apply(ctx, configuration([...config.keys, ...config.keys]))).rejects.toThrow('must be unique')
    expect(ctx.get('karakaBrowserAuth')).toBeUndefined()
    await expect(apply(ctx, configuration([{ id: 'key', algorithm: 'ES256', publicKey: 'invalid' }]))).rejects.toThrow()
    expect(ctx.get('karakaBrowserAuth')).toBeUndefined()
  })

  it('denies a token without a protected key id and propagates verification infrastructure errors', async () => {
    const auth = await verifier()
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).sign(keys.privateKey)
    expect(await auth.authenticate(token)).toBeUndefined()
    const error = new Error('crypto provider unavailable')
    vi.mocked(jwtVerify).mockRejectedValueOnce(error)
    await expect(auth.authenticate(await credential())).rejects.toBe(error)
  })

})
