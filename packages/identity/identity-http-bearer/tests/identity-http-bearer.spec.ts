import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Identity, {
  type VerifiedIdentity,
  type VerifyIdentityRequest,
} from '@deepseek-ai/dsh-identity'
import IdentityHttpBearer from '../src/index.ts'

const VERIFIED = Object.freeze({
  issuer: 'https://issuer.example' as VerifiedIdentity['issuer'],
  subject: 'user-1' as VerifiedIdentity['subject'],
  audiences: Object.freeze(['karaka-api'] as unknown as VerifiedIdentity['audiences']),
  issuedAt: 1,
  expiresAt: 2,
  claims: Object.freeze({ sub: 'user-1' }),
})

class RecordingIdentity extends Identity {
  readonly verifyCall = vi.fn<(request: VerifyIdentityRequest) => Promise<VerifiedIdentity>>()
    .mockResolvedValue(VERIFIED)

  verify(request: VerifyIdentityRequest): Promise<VerifiedIdentity> {
    return this.verifyCall(request)
  }
}

async function boot() {
  const ctx = new Context()
  const providerFiber = ctx.plugin(RecordingIdentity)
  await providerFiber
  const consumerFiber = ctx.plugin(IdentityHttpBearer)
  await consumerFiber
  return { ctx, providerFiber, consumerFiber, provider: ctx.identity as RecordingIdentity }
}

describe('HTTP Bearer identity Consumer', () => {
  it.each([
    'Bearer opaque-token',
    'bearer opaque-token',
    '  BEARER\topaque-token  ',
    ['Bearer opaque-token'],
  ])('parses %j and delegates only the opaque token', async (authorization) => {
    const { ctx, provider, providerFiber, consumerFiber } = await boot()
    await expect(ctx.identityHttpBearer.authenticate({ authorization })).resolves.toBe(VERIFIED)
    expect(provider.verifyCall).toHaveBeenCalledWith({
      credential: { kind: 'bearer', token: 'opaque-token' },
    })
    await consumerFiber.dispose()
    await providerFiber.dispose()
  })

  it.each([
    [undefined, 'IDENTITY_CREDENTIAL_MISSING'],
    ['', 'IDENTITY_CREDENTIAL_MISSING'],
    [[], 'IDENTITY_CREDENTIAL_MISSING'],
    [['Bearer one', 'Bearer two'], 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Bearer', 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Bearer one,two', 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Bearer one two', 'IDENTITY_CREDENTIAL_MALFORMED'],
    ['Basic abc', 'IDENTITY_CREDENTIAL_UNSUPPORTED'],
  ] as const)('rejects %j with %s without calling the provider', async (authorization, code) => {
    const { ctx, provider, providerFiber, consumerFiber } = await boot()
    await expect(ctx.identityHttpBearer.authenticate({ authorization }))
      .rejects.toMatchObject({ code })
    expect(provider.verifyCall).not.toHaveBeenCalled()
    await consumerFiber.dispose()
    await providerFiber.dispose()
  })

  it('forwards the exact cancellation signal', async () => {
    const { ctx, provider, providerFiber, consumerFiber } = await boot()
    const signal = new AbortController().signal
    await ctx.identityHttpBearer.authenticate({ authorization: 'Bearer token', signal })
    expect(provider.verifyCall).toHaveBeenCalledWith({
      credential: { kind: 'bearer', token: 'token' },
      signal,
    })
    await consumerFiber.dispose()
    await providerFiber.dispose()
  })

  it('rejects an already-aborted request before calling the provider', async () => {
    const { ctx, provider, providerFiber, consumerFiber } = await boot()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.identityHttpBearer.authenticate({
      authorization: 'Bearer token',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'IDENTITY_VERIFICATION_ABORTED' })
    expect(provider.verifyCall).not.toHaveBeenCalled()
    await consumerFiber.dispose()
    await providerFiber.dispose()
  })

  it('removes only the Consumer service when its fiber disposes', async () => {
    const { ctx, providerFiber, consumerFiber } = await boot()
    await consumerFiber.dispose()
    expect(ctx.get('identityHttpBearer')).toBeUndefined()
    expect(ctx.get('identity')).toBeDefined()
    await providerFiber.dispose()
  })
})
