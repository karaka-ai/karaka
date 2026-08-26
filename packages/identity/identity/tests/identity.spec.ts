import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Identity, {
  IdentityError,
  type VerifiedIdentity,
  type VerifyIdentityRequest,
} from '../src/index.ts'

const VERIFIED = Object.freeze({
  issuer: 'https://issuer.example' as VerifiedIdentity['issuer'],
  subject: 'user-1' as VerifiedIdentity['subject'],
  audiences: Object.freeze(['karaka'] as unknown as VerifiedIdentity['audiences']),
  issuedAt: 1,
  expiresAt: 2,
  claims: Object.freeze({ sub: 'user-1' }),
})

class TestIdentity extends Identity {
  verify(_request: VerifyIdentityRequest): Promise<VerifiedIdentity> {
    return Promise.resolve(VERIFIED)
  }
}

describe('identity Service Definition', () => {
  it('mounts through a provider and leaves no service after disposal', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(TestIdentity)
    await fiber
    await expect(ctx.identity.verify({
      credential: { kind: 'bearer', token: 'opaque' },
    })).resolves.toBe(VERIFIED)

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
})
