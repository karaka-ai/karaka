import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type {
  RemoteEventHostInfo,
  TypertAccessPolicy,
  TypertRemoteEventInvocation,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { apply, inject, type Config } from '../src/index.ts'
import type { ConnectionCaller } from '@deepseek-ai/dsh-client-connection'
import { ApplicationId, TenantId, UserId } from '@deepseek-ai/dsh-session'

interface GatewayProbe {
  source: TypertRemoteEventSource | undefined
  host: RemoteEventHostInfo | undefined
  removals: number
  policy: TypertAccessPolicy | undefined
  registerAccessPolicy(policy: TypertAccessPolicy): () => void
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>
}

async function setup(config: Config = {}): Promise<{
  readonly ctx: Context
  readonly gateway: GatewayProbe
  readonly fiber: Fiber
}> {
  const ctx = new Context()
  const gateway: GatewayProbe = {
    source: undefined,
    host: undefined,
    removals: 0,
    policy: undefined,
    registerAccessPolicy(policy) {
      gateway.policy = policy
      return () => { gateway.policy = undefined }
    },
    registerRemoteEvents(source, host) {
      gateway.source = source
      gateway.host = host
      return async () => {
        if (gateway.source !== source) return
        gateway.source = undefined
        gateway.host = undefined
        gateway.removals += 1
      }
    },
  }
  ctx.reflect.provide('typertGateway', gateway)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber
  return { ctx, gateway, fiber }
}

function sourceOf(gateway: GatewayProbe): TypertRemoteEventSource {
  if (gateway.source === undefined) throw new Error('fixture Gateway has no Remote event source')
  return gateway.source
}

function emitRaw(ctx: Context, event: string, args: readonly unknown[]): void {
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...values: readonly unknown[]) => void
  emit(event, ...args)
}

function waterfallRaw(
  ctx: Context,
  target: object,
  event: string,
  args: readonly unknown[],
  next: () => Promise<unknown>,
): Promise<unknown> {
  const waterfall = ctx.waterfall.bind(ctx) as unknown as (
    receiver: object,
    name: string,
    ...values: readonly unknown[]
  ) => Promise<unknown>
  return waterfall(target, event, ...args, next)
}

function invocationOf(value: unknown): TypertRemoteEventInvocation {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'context')) {
    throw new Error('fixture did not receive a scoped Remote Event invocation')
  }
  return value as TypertRemoteEventInvocation
}

describe('Remote event Host source', () => {
  it('delegates application interactions excluded by deployment capabilities', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const delivery = iterator.next()
    const agent = { ctx: ctx.extend(), session: { header: { applicationOwner: { applicationId: 'app', tenantId: 'tenant', userId: 'alice' } } } }
    await expect(waterfallRaw(ctx, scopeTarget(ctx, agent), 'user-questions/request', [{ questions: [], agent }],
      () => Promise.resolve('unavailable'))).resolves.toBe('unavailable')
    abort.abort()
    await expect(delivery).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('registers the Host home used by Client connection generations', async () => {
    const { gateway, fiber } = await setup()
    expect(gateway.host?.home).toBeTypeOf('string')
    expect(gateway.host?.home.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(gateway.host).toBeUndefined()
  })

  it('gives each Client stream an independent allowlisted event queue', async () => {
    const { ctx, gateway, fiber } = await setup()
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = sourceOf(gateway)(firstAbort.signal)[Symbol.asyncIterator]()
    const second = sourceOf(gateway)(secondAbort.signal)[Symbol.asyncIterator]()

    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1])
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 1] },
    })

    const firstDone = first.next()
    firstAbort.abort(new Error('first Client disconnected'))
    emitRaw(ctx, 'commands/change', [])
    await expect(firstDone).resolves.toEqual({ done: true, value: undefined })
    await expect(second.next()).resolves.toEqual({
      done: false,
      value: { event: 'commands/change', args: [] },
    })

    const secondDone = second.next()
    secondAbort.abort(new Error('second Client disconnected'))
    await expect(secondDone).resolves.toEqual({ done: true, value: undefined })

    await fiber.dispose()
    expect(gateway.source).toBeUndefined()
    expect(gateway.removals).toBe(1)
    await ctx.fiber.dispose()
  })

  it('rejects a non-JSON argument without poisoning the stream', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()

    expect(() => {
      emitRaw(ctx, 'settings/document-updated', ['ui-theme', 1n])
    }).toThrow('argument 1 is not lossless JSON data')
    emitRaw(ctx, 'settings/document-updated', ['ui-theme', 2])
    await expect(pending).resolves.toEqual({
      done: false,
      value: { event: 'settings/document-updated', args: ['ui-theme', 2] },
    })

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(sourceOf(gateway)(alreadyAborted.signal)[Symbol.asyncIterator]().next())
      .resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('bridges scoped waterfall result, next delegation, and rejection', async () => {
    const { ctx, gateway } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const agentCtx = ctx.extend()
    const agent = { ctx: agentCtx, session: { header: {} } }
    const target = scopeTarget(ctx, agent)
    const request = { questions: [], agent }

    const claimed = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const claimedDispatch = invocationOf((await iterator.next()).value)
    expect(claimedDispatch).toMatchObject({
      event: 'user-questions/request',
      request,
      context: { value: agentCtx, subject: agent },
    })
    claimedDispatch.resolve({ kind: 'result', value: 'client answer' })
    await expect(claimed).resolves.toBe('client answer')

    const delegated = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const delegatedDispatch = invocationOf((await iterator.next()).value)
    delegatedDispatch.resolve({ kind: 'next' })
    await expect(delegated).resolves.toBe('host fallback')

    const rejection = Object.assign(new Error('the user cancelled ask_user_question'), {
      code: 'ASK_CANCELLED',
    })
    const rejected = waterfallRaw(
      ctx,
      target,
      'user-questions/request',
      [request],
      () => Promise.resolve('host fallback'),
    )
    const rejectedAssertion = expect(rejected).rejects.toBe(rejection)
    const rejectedDispatch = invocationOf((await iterator.next()).value)
    rejectedDispatch.reject(rejection)
    await rejectedAssertion

    const done = iterator.next()
    abort.abort()
    await expect(done).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('rejects a queued scoped waterfall when its source is withdrawn', async () => {
    const { ctx, gateway, fiber } = await setup()
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    const delivery = iterator.next()
    const agent = { ctx: ctx.extend(), session: { header: {} } }
    const reason = new Error('forwarded event source removed')
    const pending = waterfallRaw(
      ctx,
      scopeTarget(ctx, agent),
      'user-questions/request',
      [{ questions: [], agent }],
      () => Promise.resolve('host fallback'),
    )
    const rejected = expect(pending).rejects.toBe(reason)

    abort.abort(reason)

    await rejected
    await expect(delivery).resolves.toEqual({ done: true, value: undefined })
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})


describe('application Remote capability policy', () => {
  const caller: Extract<ConnectionCaller, { kind: 'application' }> = {
    kind: 'application', expiresAt: Number.MAX_SAFE_INTEGER,
    owner: { applicationId: ApplicationId('app'), tenantId: TenantId('tenant'), userId: UserId('alice') },
  }

  it('allows only selected methods and interaction answers, and withdraws the policy on disposal', async () => {
    const { ctx, gateway, fiber } = await setup({ applicationMethods: ['applicationHistory'], applicationEvents: ['approval/request'] })
    try {
      const policy = gateway.policy!
      expect(policy.allows(caller, 'session/applicationHistory')).toBe(true)
      expect(policy.allows(caller, 'session/applicationCancel')).toBe(false)
      expect(policy.allows(caller, 'session/list')).toBe(false)
      expect(policy.allows(caller, '$events')).toBe(true)
      expect(policy.allows(caller, '$events/result')).toBe(true)
      await fiber.dispose()
      expect(gateway.policy).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
    const closed = await setup()
    try {
      expect(closed.gateway.policy!.allows(caller, 'session/applicationHistory')).toBe(false)
      expect(closed.gateway.policy!.allows(caller, '$events/result')).toBe(false)
    } finally { await closed.ctx.fiber.dispose() }
  })

  it('matches application, tenant and user for selected scoped events only', async () => {
    const { ctx, gateway } = await setup({ applicationEvents: ['approval/request'] })
    try {
      const policy = gateway.policy!
      const subject = { session: { header: { applicationOwner: caller.owner } } }
      const event: TypertRemoteEventInvocation = {
        event: 'approval/request', request: {}, context: { value: ctx, subject }, resolve: () => {}, reject: () => {},
      }
      expect(policy.receives(caller, event)).toBe(true)
      expect(policy.receives({ kind: 'host' }, { event: 'host/private', args: [] })).toBe(true)
      expect(policy.receives(caller, { event: 'approval/request', args: [] })).toBe(false)
      expect(policy.receives(caller, { ...event, event: 'user-questions/request' })).toBe(false)
      expect(policy.receives(caller, { ...event, context: { value: ctx, subject: { session: { header: {} } } } })).toBe(false)
      for (const owner of [
        { ...caller.owner, applicationId: ApplicationId('other') },
        { ...caller.owner, tenantId: TenantId('other') },
        { ...caller.owner, userId: UserId('other') },
      ]) expect(policy.receives({ ...caller, owner }, event)).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('forwards selected application questions to the existing Remote event source', async () => {
    const { ctx, gateway } = await setup({ applicationEvents: ['user-questions/request'] })
    const abort = new AbortController()
    const iterator = sourceOf(gateway)(abort.signal)[Symbol.asyncIterator]()
    try {
      const agent = { ctx: ctx.extend(), session: { header: { applicationOwner: caller.owner } } }
      const answer = waterfallRaw(ctx, scopeTarget(ctx, agent), 'user-questions/request', [{ questions: [], agent }],
        () => Promise.reject(new Error('selected interaction was delegated')))
      const delivered = invocationOf((await iterator.next()).value)
      expect(gateway.policy!.receives(caller, delivered)).toBe(true)
      delivered.resolve({ kind: 'result', value: { answers: [] } })
      await expect(answer).resolves.toEqual({ answers: [] })
    } finally {
      abort.abort()
      await iterator.return?.()
      await ctx.fiber.dispose()
    }
  })
})
