/** Host BFF entry and Loader shell for the Remote contribution assembly. */

import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { APPLICATION_REMOTE_METHODS, type ApplicationRemoteMethod } from './application-methods.ts'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
  TypertRemoteEventOutcome,
  TypertRemoteEventSource,
} from '@deepseek-ai/dsh-api-gateway'
import { Deque } from '@deepseek-ai/dsh-deque'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'

// The owner packages' client-safe `./types` exports carry the cordis `Events`
// declarations for every allowlisted event. Pulling them into this face is what
// makes the shape assertion below judge real signatures rather than an empty
// event vocabulary.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-settings/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
export type {} from '@deepseek-ai/dsh-api-session-controller/types'

export { API_REMOTE_FORWARDED_EVENTS } from './remote-events.ts'
export type { ApiRemoteForwardedEvent } from './types.ts'

/** Required Host service: the Gateway owns the physical Remote stream mux. */
export const inject = ['typertGateway']

/** Browser-user capabilities; omitted selections grant no application operations. */
export interface Config {
  /** Application chat methods accessible to authenticated browser users. @default [] */
  readonly applicationMethods?: ApplicationRemoteMethod[]
  /** Application interactions delivered to their authenticated owners. @default [] */
  readonly applicationEvents?: ('approval/request' | 'user-questions/request')[]
}

export const Config: z<Config> = z.object({
  applicationMethods: z.array(z.union(APPLICATION_REMOTE_METHODS)).default([]),
  applicationEvents: z.array(z.union(['approval/request', 'user-questions/request'])).default([]),
})

/** Host plugin body registering this application's selected Cordis event source. */
export function apply(ctx: Context, config: Config = {}): void {
  const methods = new Set((config.applicationMethods ?? []).map(method => `session/${method}`))
  const events: ReadonlySet<string> = new Set(config.applicationEvents ?? [])
  ctx.effect(() => ctx.typertGateway.registerAccessPolicy({
    allows: (_caller, endpoint) => methods.has(endpoint)
      || endpoint === '$events'
      || (events.size > 0 && endpoint === '$events/result'),
    receives: (caller, dispatch) => {
      if (caller.kind === 'host') return true
      if (!events.has(dispatch.event) || !('context' in dispatch)) return false
      const owner = (dispatch.context.subject as Agent).session.header.applicationOwner
      return owner !== undefined && owner.applicationId === caller.owner.applicationId
        && owner.tenantId === caller.owner.tenantId && owner.userId === caller.owner.userId
    },
  }), 'api-remotes: application access')
  ctx.effect(
    () => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx, events), { home: homedir() }),
    'api-remotes: forwarded Cordis event source',
  )
}

/** Create the sole queue and listener set consumed by the registered Gateway. */
function remoteEventSource(ctx: Context, applicationEvents: ReadonlySet<string>): TypertRemoteEventSource {
  return (signal) => {
    const queue = new RemoteEventQueue()
    const disposers = API_REMOTE_FORWARDED_EVENTS.map(({ event, mode }) => {
      if (mode === 'emit') {
        return ctx.on(event as never, ((...args: unknown[]) => {
          queue.push({ event, args: assertJsonArgs(event, args) })
        }) as never)
      }
      return ctx.on(event as never, (function (
        this: unknown,
        request: object,
        next: () => unknown,
      ) {
        const subject = carrierKeyOf(this)
        if (subject === undefined) return next()
        if ((subject as Agent).session.header.applicationOwner !== undefined && !applicationEvents.has(event)) return next()
        const value = Reflect.get(subject, 'ctx') as unknown
        if (typeof value !== 'object' || value === null) {
          throw new TypeError(`forwarded scoped event ${JSON.stringify(event)} has no live Context`)
        }
        return forwardWaterfall(
          queue,
          event,
          request,
          { value: value as Context, subject },
          next,
        )
      }) as never)
    })
    return queue.iterate(signal, () => {
      for (const dispose of disposers) dispose()
    })
  }
}

/** One pull-driven queue bridging synchronous Cordis listeners to an AsyncIterable. */
class RemoteEventQueue {
  private readonly buffer = new Deque<TypertRemoteEventDispatch>()
  private waiter: (() => void) | undefined
  private done = false

  push(frame: TypertRemoteEventDispatch): boolean {
    if (this.done) return false
    this.buffer.pushBack(frame)
    this.waiter?.()
    return true
  }

  private end(reason: unknown): void {
    if (this.done) return
    this.done = true
    while (this.buffer.size > 0) {
      const dispatch = this.buffer.popFront() as TypertRemoteEventDispatch
      if ('context' in dispatch) dispatch.reject(reason)
    }
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<TypertRemoteEventDispatch> {
    const abort = (): void => { this.end(remoteEventSourceEndReason(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        if (this.done || signal.aborted) return
        while (this.buffer.size > 0) yield this.buffer.popFront() as TypertRemoteEventDispatch
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.end(remoteEventSourceEndReason(signal))
      cleanup()
    }
  }
}

/**
 * Normalize an event-source shutdown for pending Host waterfalls.
 * @param signal - source lifetime whose reason wins after cancellation.
 * @returns the cancellation reason or an unexpected-end failure.
 */
function remoteEventSourceEndReason(signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  return new Error('api-remotes: forwarded Remote event source ended')
}

/** Bridge one Cordis waterfall listener through the Gateway-owned pending event. */
function forwardWaterfall(
  queue: RemoteEventQueue,
  event: string,
  request: object,
  context: TypertRemoteEventInvocation['context'],
  next: () => unknown,
): Promise<unknown> {
  const settled = Promise.withResolvers<unknown>()
  const dispatch: TypertRemoteEventInvocation = {
    event,
    request,
    context,
    resolve: (outcome: TypertRemoteEventOutcome) => {
      if (outcome.kind === 'result') {
        settled.resolve(outcome.value)
        return
      }
      void Promise.resolve().then(next).then(settled.resolve, settled.reject)
    },
    reject: settled.reject,
  }
  if (!queue.push(dispatch)) void Promise.resolve().then(next).then(settled.resolve, settled.reject)
  return settled.promise
}

/** Reject an allowlisted event whose runtime arguments are not lossless JSON data. */
function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${String(index)} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}
