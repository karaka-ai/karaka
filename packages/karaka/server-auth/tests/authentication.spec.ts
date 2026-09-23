import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { ApplicationId } from '@karaka-ai/identity'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BearerServerAuth, { type Config } from '../src/index.ts'

const contexts: Context[] = []
const applications: Config['applications'] = [
  { id: 'app', chatCredential: 'CHAT', toolCredential: 'TOOLS' },
  { id: 'other', chatCredential: 'OTHER_CHAT', toolCredential: 'OTHER_TOOLS' },
]

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function fixture(values: Record<string, string> = { CHAT: 'inbound', TOOLS: 'outbound' }) {
  const ctx = new Context()
  contexts.push(ctx)
  const resolve = vi.fn(async (ref: string): Promise<ResolvedCredential | undefined> => {
    const value = values[ref]
    return value === undefined ? undefined : { value, source: 'fixture' }
  })
  // This consumer only resolves references; credential editing is not part of its dependency use.
  const credentials = { resolve }
  ctx.provide('credentials', Object.setPrototypeOf(credentials, CredentialProvider.prototype) as CredentialProvider)
  return { ctx, values, resolve, auth: new BearerServerAuth(ctx, { applications }) }
}

describe('server bearer authentication', () => {
  it('keeps inbound and outbound credentials separate and observes rotation', async () => {
    const { auth, values } = fixture()
    expect(await auth.authenticate('Bearer inbound')).toEqual({ applicationId: 'app' })
    expect(await auth.authenticate('Bearer outbound')).toBeUndefined()
    expect(await auth.authorizeTools(ApplicationId('app'))).toBe('Bearer outbound')
    values.CHAT = 'rotated-inbound'
    values.TOOLS = 'rotated-outbound'
    expect(await auth.authenticate('Bearer inbound')).toBeUndefined()
    expect(await auth.authenticate('bearer rotated-inbound')).toEqual({ applicationId: 'app' })
    expect(await auth.authorizeTools(ApplicationId('app'))).toBe('Bearer rotated-outbound')
  })

  it.each([undefined, '', 'Basic inbound', 'Bearer', 'Bearer  inbound', 'Bearer inbound extra'])('denies malformed authorization %s', async (header) => {
    const { auth, resolve } = fixture()
    expect(await auth.authenticate(header)).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('denies ambiguous and absent credentials', async () => {
    const { auth } = fixture({ CHAT: 'shared', OTHER_CHAT: 'shared' })
    expect(await auth.authenticate('Bearer shared')).toBeUndefined()
    expect(await auth.authenticate('Bearer unknown')).toBeUndefined()
    await expect(auth.authorizeTools(ApplicationId('app'))).rejects.toThrow('not configured')
    await expect(auth.authorizeTools(ApplicationId('unknown'))).rejects.toThrow('unknown application')
  })

  it('rejects duplicate application identities and invalid credential references at construction', () => {
    const construct = (config: Config) => {
      const ctx = new Context()
      contexts.push(ctx)
      return new BearerServerAuth(ctx, config)
    }
    expect(() => construct({ applications: [...applications, ...applications] })).toThrow('duplicate')
    expect(() => construct({ applications: [{ id: '', chatCredential: 'CHAT', toolCredential: 'TOOLS' }] })).toThrow('must not be empty')
    expect(() => construct({ applications: [{ id: 'app', chatCredential: 'not a reference', toolCredential: 'TOOLS' }] })).toThrow('must match')
  })

  it('rejects pre-aborted operations before resolving credentials', async () => {
    const { auth, resolve } = fixture()
    const error = new Error('cancelled')
    const signal = AbortSignal.abort(error)
    await expect(auth.authenticate('Bearer inbound', signal)).rejects.toBe(error)
    await expect(auth.authorizeTools(ApplicationId('app'), signal)).rejects.toBe(error)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('rejects an in-flight credential wait on cancellation and consumes late completion', async () => {
    const { auth, resolve } = fixture()
    const pending = Promise.withResolvers<ResolvedCredential | undefined>()
    resolve.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const error = new Error('cancelled')
    const result = auth.authenticate('Bearer inbound', controller.signal)
    const rejected = expect(result).rejects.toBe(error)
    expect(resolve).toHaveBeenCalledOnce()
    controller.abort(error)
    await rejected
    pending.resolve({ value: 'inbound', source: 'fixture' })
    await pending.promise
  })

  it('propagates credential-provider failures', async () => {
    const { auth, resolve } = fixture()
    const error = new Error('provider unavailable')
    resolve.mockRejectedValueOnce(error)
    await expect(auth.authenticate('Bearer inbound')).rejects.toBe(error)
    resolve.mockRejectedValueOnce(error)
    await expect(auth.authorizeTools(ApplicationId('app'))).rejects.toBe(error)
  })

  it('uses a safe cancellation error for a non-Error abort reason', async () => {
    const { auth, resolve } = fixture()
    const pending = Promise.withResolvers<ResolvedCredential | undefined>()
    resolve.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const result = auth.authorizeTools(ApplicationId('app'), controller.signal)
    const rejected = expect(result).rejects.toThrow('server authentication cancelled')
    controller.abort('caller left')
    await rejected
    pending.resolve(undefined)
    await pending.promise
  })

})
