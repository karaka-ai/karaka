/** Browser-safe application client over Karaka's authenticated HTTP adapter. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionId as ChatId } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
export { SessionId }

export const APPLICATION_REMOTE_METHODS = ['applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel'] as const
export type ApplicationRemoteMethod = typeof APPLICATION_REMOTE_METHODS[number]
export interface RemoteFailure { readonly code: string; readonly message: string; readonly details: unknown }
export type RemoteResult<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: RemoteFailure }
type TextDelta = { readonly type: 'text-delta'; readonly cursor: number; readonly text: string }
type FollowFrame = SessionFollowFrame | TextDelta
interface Address { readonly chatId: ChatId }
interface AgentRow { readonly id: string; readonly name: string; readonly description?: string }
interface Observable<Value> { getSnapshot(): Value; subscribe(listener: () => void): () => void }
/** Identity and Host display facts for one authenticated connection generation. */
export interface BrowserGeneration { readonly id: number; readonly host: { readonly home: string } }
export interface BrowserClientConfig {
  readonly endpoint: string
  readonly credential: (signal: AbortSignal) => string | Promise<string>
  readonly methods?: readonly ApplicationRemoteMethod[]
  readonly path?: string
  readonly reconnectDelayMs?: number
}
export interface BrowserClient {
  readonly chats: {
    applicationAgents(signal?: AbortSignal): Promise<RemoteResult<readonly AgentRow[]>>
    applicationCreate(request: Address & { readonly agentId: string }, signal?: AbortSignal): Promise<RemoteResult<Address & { readonly agentId: string }>>
    applicationPrompt(request: Address & { readonly requestId: string; readonly content: readonly PromptContentPart[] }, signal?: AbortSignal): Promise<RemoteResult<{ readonly accepted: true; readonly duplicate: boolean }>>
    applicationHistory(request: Address, signal?: AbortSignal): Promise<RemoteResult<readonly SessionWireEvent[]>>
    applicationFollow(request: Address, signal?: AbortSignal): AsyncIterable<RemoteResult<FollowFrame>>
    applicationCancel(request: Address, signal?: AbortSignal): Promise<RemoteResult<{ readonly accepted: true }>>
  }
  readonly connection: {
    readonly state: Observable<'connecting' | 'connected' | 'disconnected'>
    readonly generation: Observable<BrowserGeneration | undefined>
    reconnect(): void
  }
  forChat(chatId: string): {
    $on(event: 'approval/request', handler: (request: BrowserApprovalRequest, next: () => Promise<ApprovalOutcome | undefined>) => ApprovalOutcome | undefined | Promise<ApprovalOutcome | undefined>): () => void
    $on(event: 'user-questions/request', handler: (request: BrowserQuestionRequest, next: () => Promise<AskUserQuestionAnswer | undefined>) => AskUserQuestionAnswer | undefined | Promise<AskUserQuestionAnswer | undefined>): () => void
  }
  dispose(): Promise<void>
}
const approvalRequestSchema = z.object({
  agent: z.object({ id: z.string().transform(SessionId) }), toolName: z.string(),
  callId: z.string().optional(), reason: z.string().optional(), signal: z.instanceof(AbortSignal),
})
const questionRequestSchema = z.object({
  agent: z.object({ id: z.string().transform(SessionId) }), signal: z.instanceof(AbortSignal),
  questions: z.array(z.object({
    id: z.string(), question: z.string(), detail: z.string().optional(), header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
    multiSelect: z.boolean().optional(), intent: z.object({ kind: z.literal('plan-review'), approve: z.string() }).optional(),
  })),
})
/** Browser event payloads contain a chat identity, never a live server Agent. */
export type BrowserApprovalRequest = z.infer<typeof approvalRequestSchema>
export type BrowserQuestionRequest = z.infer<typeof questionRequestSchema>
type ApprovalHandler = (request: BrowserApprovalRequest, next: () => Promise<ApprovalOutcome | undefined>) => ApprovalOutcome | undefined | Promise<ApprovalOutcome | undefined>
type QuestionHandler = (request: BrowserQuestionRequest, next: () => Promise<AskUserQuestionAnswer | undefined>) => AskUserQuestionAnswer | undefined | Promise<AskUserQuestionAnswer | undefined>
const approvalAnswerSchema = z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable'])
const questionAnswerSchema = z.object({ answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })) })
const failureSchema = z.object({ code: z.string(), message: z.string(), details: z.unknown() })
const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: failureSchema })])
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), clientId: z.string(), host: z.object({ home: z.string() }) }),
  z.object({ type: z.literal('cancel'), eventId: z.string() }),
  z.object({ type: z.literal('interaction'), eventId: z.string(), chatId: z.string(), event: z.enum(['approval/request', 'user-questions/request']), request: z.record(z.string(), z.unknown()) }),
])
type Handler = (request: Record<string, unknown>, next: () => Promise<unknown>) => unknown | Promise<unknown>

/** Preserve independent credentials, chat-scoped listeners and explicit reconnection. */
export async function createBrowserClient(config: BrowserClientConfig): Promise<BrowserClient> {
  const origin = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('connection: endpoint must be an HTTP(S) server origin')
  const path = config.path ?? '/karaka/browser'
  if (!path.startsWith('/') || path.endsWith('/')) throw new Error('Browser path must start with / and have no trailing slash')
  const endpoint = origin.origin + path
  const delay = config.reconnectDelayMs ?? 1_000
  if (!Number.isSafeInteger(delay) || delay < 1) throw new Error('reconnectDelayMs must be a positive safe integer')
  const methods = new Set(config.methods ?? APPLICATION_REMOTE_METHODS)
  const lifetime = new AbortController()
  let connection = new AbortController()
  let generationId = 0
  let connectionReady = Promise.withResolvers<void>()
  const generation = observable<BrowserGeneration | undefined>(undefined)
  const state = observable<'connecting' | 'connected' | 'disconnected'>('connecting')
  const listeners = new Map<string, Map<string, Set<Handler>>>()
  const interactions = new Map<string, AbortController>()
  const callbacks = new Set<Promise<void>>()

  async function fetchRequest(method: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const credential = await config.credential(signal)
    signal.throwIfAborted()
    return fetch(`${endpoint}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  }
  async function invoke<Value>(method: ApplicationRemoteMethod, body: unknown, supplied?: AbortSignal): Promise<RemoteResult<Value>> {
    if (!methods.has(method)) throw new Error(`Browser method ${method} is not mounted`)
    try {
      const signal = AbortSignal.any([lifetime.signal, ...(supplied === undefined ? [] : [supplied])])
      await abortable(connectionReady.promise, signal)
      const response = await fetchRequest(method, body, AbortSignal.any([signal, connection.signal]))
      return parseResponse<Value>(await response.json(), response.status)
    } catch (error) { return failure(error) }
  }
  async function* follow(request: Address, supplied?: AbortSignal): AsyncIterable<RemoteResult<FollowFrame>> {
    if (!methods.has('applicationFollow')) throw new Error('Browser method applicationFollow is not mounted')
    const signal = AbortSignal.any([lifetime.signal, connection.signal, ...(supplied === undefined ? [] : [supplied])])
    try {
      await abortable(connectionReady.promise, signal)
      const response = await fetchRequest('applicationFollow', request, signal)
      if (!response.ok) { yield parseResponse(await response.json(), response.status); return }
      for await (const frame of parseEvents(response)) yield envelope.parse(frame) as RemoteResult<FollowFrame>
    } catch (error) { if (!lifetime.signal.aborted && !supplied?.aborted) yield failure(error) }
  }

  async function handleInteraction(event: Extract<z.infer<typeof eventSchema>, { type: 'interaction' }>, clientId: string, signal: AbortSignal): Promise<void> {
    if (interactions.has(event.eventId)) return
    const controller = new AbortController()
    interactions.set(event.eventId, controller)
    const interactionSignal = AbortSignal.any([signal, controller.signal])
    const handlers = [...listeners.get(event.chatId)?.get(event.event) ?? []]
    let delegated = false
    const dispatch = async (index: number): Promise<unknown> => {
      const handler = handlers[index]
      if (handler === undefined) { delegated = true; return undefined }
      return handler({ ...event.request, signal: interactionSignal }, () => dispatch(index + 1))
    }
    try {
      const value = await abortable(dispatch(0), interactionSignal)
      if (interactionSignal.aborted) return
      const outcome = delegated && value === undefined ? { kind: 'next' } : { kind: 'result', value }
      const response = await fetchRequest('result', { clientId, eventId: event.eventId, outcome }, interactionSignal)
      if (!response.ok) throw new Error('Browser interaction response was rejected')
    } catch (error) {
      if (!interactionSignal.aborted) {
        // A failed answerer delegates rather than approving or dropping the pending decision.
        await fetchRequest('result', { clientId, eventId: event.eventId, outcome: { kind: 'next' } }, interactionSignal).catch(() => {})
      }
    } finally {
      if (interactions.get(event.eventId) === controller) interactions.delete(event.eventId)
    }
  }

  const eventLoop = (async () => {
    while (!lifetime.signal.aborted) {
      const current = connection
      const currentReady = connectionReady
      const signal = AbortSignal.any([lifetime.signal, current.signal])
      try {
        const response = await fetchRequest('events', {}, signal)
        if (!response.ok) throw new Error('Browser event connection rejected')
        let clientId: string | undefined
        for await (const raw of parseEvents(response)) {
          const event = eventSchema.parse(raw)
          if (event.type === 'ready') {
            clientId = event.clientId
            generation.set({ id: ++generationId, host: event.host })
            state.set('connected')
            currentReady.resolve()
          } else if (event.type === 'cancel') interactions.get(event.eventId)?.abort(new Error('Interaction settled'))
          else {
            if (clientId === undefined) throw new Error('Browser event arrived before readiness')
            const callback = handleInteraction(event, clientId, signal)
            callbacks.add(callback)
            void callback.then(() => callbacks.delete(callback), () => callbacks.delete(callback))
          }
        }
      } catch (error) {
        // Connection and credential failures enter the same renewable reconnect loop.
      } finally {
        currentReady.resolve()
        for (const controller of interactions.values()) controller.abort(new Error('Browser connection replaced'))
        interactions.clear()
        generation.set(undefined)
        if (!lifetime.signal.aborted) state.set('connecting')
      }
      if (lifetime.signal.aborted) break
      if (connection === current) {
        await pause(delay, signal)
        if (connection === current) { connection = new AbortController(); connectionReady = Promise.withResolvers<void>() }
      }
    }
  })()

  return {
    chats: {
      applicationAgents: signal => invoke('applicationAgents', {}, signal),
      applicationCreate: (request, signal) => invoke('applicationCreate', request, signal),
      applicationPrompt: (request, signal) => invoke('applicationPrompt', request, signal),
      applicationHistory: (request, signal) => invoke('applicationHistory', request, signal),
      applicationFollow: follow,
      applicationCancel: (request, signal) => invoke('applicationCancel', request, signal),
    },
    connection: { state, generation, reconnect() {
      lifetime.signal.throwIfAborted()
      const previous = connection
      connection = new AbortController()
      connectionReady = Promise.withResolvers<void>()
      previous.abort(new Error('Browser reconnect requested'))
      generation.set(undefined)
      state.set('connecting')
    } },
    forChat(chatId: string) {
      function on(event: 'approval/request', handler: ApprovalHandler): () => void
      function on(event: 'user-questions/request', handler: QuestionHandler): () => void
      function on(event: 'approval/request' | 'user-questions/request', handler: ApprovalHandler | QuestionHandler): () => void {
        // The overload pairs each event with its handler; parse the wire payload before invoking it.
        const adapted: Handler = event === 'approval/request'
          ? (request, next) => (handler as ApprovalHandler)(approvalRequestSchema.parse(request), async () => {
            const value = await next()
            return value === undefined ? undefined : approvalAnswerSchema.parse(value)
          })
          : (request, next) => (handler as QuestionHandler)(questionRequestSchema.parse(request), async () => {
            const value = await next()
            if (value === undefined) return undefined
            const parsed = questionAnswerSchema.parse(value)
            return { answers: parsed.answers.map(item => ({ id: item.id, selected: item.selected, ...(item.custom === undefined ? {} : { custom: item.custom }) })) }
          })
        const byEvent = listeners.get(chatId) ?? new Map<string, Set<Handler>>()
        const handlers = byEvent.get(event) ?? new Set<Handler>()
        handlers.add(adapted); byEvent.set(event, handlers); listeners.set(chatId, byEvent)
        return () => { handlers.delete(adapted); if (handlers.size === 0) byEvent.delete(event); if (byEvent.size === 0) listeners.delete(chatId) }
      }
      return { $on: on }
    },
    async dispose() {
      lifetime.abort(new Error('Browser client disposed'))
      connection.abort()
      state.set('disconnected')
      await eventLoop
      await Promise.allSettled(callbacks)
      listeners.clear()
    },
  }
}
function observable<Value>(initial: Value): Observable<Value> & { set(value: Value): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }, set(next) { value = next; for (const listener of [...listeners]) {
    try { listener() } catch (error) { console.error('Browser connection observer failed', error) }
  } } }
}
function failure(error: unknown): RemoteResult<never> { return { ok: false, error: { code: 'gateway/internal', message: error instanceof Error ? error.message : 'Browser request failed', details: {} } } }
function parseResponse<Value>(raw: unknown, status: number): RemoteResult<Value> {
  const result = envelope.safeParse(raw)
  if (result.success) return result.data as RemoteResult<Value>
  return { ok: false, error: { code: status === 401 || status === 403 ? 'gateway/forbidden' : 'gateway/internal', message: status === 401 || status === 403 ? 'Browser access is forbidden' : 'Browser response is invalid', details: {} } }
}
async function* parseEvents(response: Response): AsyncIterable<unknown> {
  if (response.body === null) throw new Error('Browser event response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const part = await reader.read()
      buffer = (buffer + decoder.decode(part.value, { stream: !part.done })).replace(/\r\n/gu, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data) yield JSON.parse(data)
      }
      if (part.done) break
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function abortable<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
