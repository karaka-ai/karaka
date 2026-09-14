/** Browser-safe application client over Karaka's authenticated HTTP adapter. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionId as ChatId } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
export { SessionId }

/** Application methods supported by the authenticated browser endpoint. */
export const APPLICATION_REMOTE_METHODS = ['applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel'] as const
/** One supported browser application method. */
export type ApplicationRemoteMethod = typeof APPLICATION_REMOTE_METHODS[number]
/** Sanitized remote failure with protocol code and optional server details. */
export interface RemoteFailure { readonly code: string; readonly message: string; readonly details: unknown }
/** Successful operation value or sanitized remote failure. */
export type RemoteResult<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: RemoteFailure }
type TextDelta = { readonly type: 'text-delta'; readonly cursor: number; readonly text: string }
type FollowFrame = SessionFollowFrame | TextDelta
interface Address { readonly chatId: ChatId }
interface AgentRow { readonly id: string; readonly name: string; readonly description?: string }
interface Observable<Value> { getSnapshot(): Value; subscribe(listener: () => void): () => void }
/** Identity and Host display facts for one authenticated connection generation. */
export interface BrowserGeneration { readonly id: number; readonly host: { readonly home: string } }
/** Per-instance endpoint, renewable credentials and reconnection settings. */
export interface BrowserClientConfig {
  /** HTTP(S) server origin without a path, credentials, query or fragment. */
  readonly endpoint: string
  /**
   * Resolve a current JWT for each request.
   * @param signal - Cancellation of this HTTP request.
   * @returns Current browser credential, synchronously or asynchronously.
   */
  readonly credential: (signal: AbortSignal) => string | Promise<string>
  /** Locally enabled application methods; defaults to all supported methods. */
  readonly methods?: readonly ApplicationRemoteMethod[]
  /** Browser route prefix. Default: /karaka/browser. */
  readonly path?: string
  /** Positive integer delay between connection attempts in milliseconds. Default: 1000. */
  readonly reconnectDelayMs?: number
}
/** Browser methods, connection observations and chat-scoped interaction subscriptions. */
export interface BrowserClient {
  readonly chats: {
    /**
     * List presets available to the authenticated application.
     * @param signal - Optional caller cancellation.
     * @returns Available presets or a sanitized remote failure.
     */
    applicationAgents(signal?: AbortSignal): Promise<RemoteResult<readonly AgentRow[]>>
    /**
     * Create an owned chat using an available preset.
     * @param request - New chat id and selected preset id.
     * @param signal - Optional caller cancellation.
     * @returns Created chat identity or a sanitized remote failure.
     */
    applicationCreate(
      request: Address & { readonly agentId: string }, signal?: AbortSignal,
    ): Promise<RemoteResult<Address & { readonly agentId: string }>>
    /**
     * Submit content with an application request id for deduplication.
     * @param request - Owned chat, request id, and prompt content.
     * @param signal - Optional caller cancellation.
     * @returns Acceptance and duplicate status, or a sanitized remote failure.
     */
    applicationPrompt(
      request: Address & { readonly requestId: string; readonly content: readonly PromptContentPart[] }, signal?: AbortSignal,
    ): Promise<RemoteResult<{ readonly accepted: true; readonly duplicate: boolean }>>
    /**
     * Read an owned chat's persisted history.
     * @param request - Owned chat identity.
     * @param signal - Optional caller cancellation.
     * @returns Persisted wire events or a sanitized remote failure.
     */
    applicationHistory(request: Address, signal?: AbortSignal): Promise<RemoteResult<readonly SessionWireEvent[]>>
    /**
     * Follow an owned chat until its stream closes or the caller cancels.
     * @param request - Owned chat identity.
     * @param signal - Optional caller cancellation; cancellation ends iteration without an error frame.
     * @returns Remote follow frames and sanitized transport failures.
     */
    applicationFollow(request: Address, signal?: AbortSignal): AsyncIterable<RemoteResult<FollowFrame>>
    /**
     * Request cancellation of the owned chat's active work.
     * @param request - Owned chat identity.
     * @param signal - Optional cancellation of the HTTP request.
     * @returns Cancellation acceptance or a sanitized remote failure.
     */
    applicationCancel(request: Address, signal?: AbortSignal): Promise<RemoteResult<{ readonly accepted: true }>>
  }
  readonly connection: {
    readonly state: Observable<'connecting' | 'connected' | 'disconnected'>
    readonly generation: Observable<BrowserGeneration | undefined>
    /** Replace the event connection; throws after disposal. */
    reconnect(): void
  }
  /**
   * Select the chat whose incoming interactions receive these listeners.
   * @param chatId - Application chat identity.
   * @returns Approval and question subscriptions scoped to this chat.
   */
  forChat(chatId: string): {
    /**
     * Answer or delegate approval requests in registration order.
     * @param event - Approval event name.
     * @param handler - Answerer receiving cancellation and the next answerer.
     * @returns Callback removing this subscription.
     */
    $on(event: 'approval/request', handler: ApprovalHandler): () => void
    /**
     * Answer or delegate questions in registration order.
     * @param event - Question event name.
     * @param handler - Answerer receiving cancellation and the next answerer.
     * @returns Callback removing this subscription.
     */
    $on(event: 'user-questions/request', handler: QuestionHandler): () => void
  }
  /**
   * Cancel connections and interactions, then remove listeners.
   * @returns Completion after the event loop and tracked callbacks settle.
   */
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
/** Owner-scoped browser question payload with cancellation and a chat identity. */
export type BrowserQuestionRequest = z.infer<typeof questionRequestSchema>
type ApprovalHandler = (
  request: BrowserApprovalRequest, next: () => Promise<ApprovalOutcome | undefined>,
) => ApprovalOutcome | undefined | Promise<ApprovalOutcome | undefined>
type QuestionHandler = (
  request: BrowserQuestionRequest, next: () => Promise<AskUserQuestionAnswer | undefined>,
) => AskUserQuestionAnswer | undefined | Promise<AskUserQuestionAnswer | undefined>
const approvalAnswerSchema = z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable'])
const questionAnswerSchema = z.object({
  answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })),
})
const failureSchema = z.object({ code: z.string(), message: z.string(), details: z.unknown() })
const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), value: z.unknown() }), z.object({ ok: z.literal(false), error: failureSchema })])
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), clientId: z.string(), host: z.object({ home: z.string() }) }),
  z.object({ type: z.literal('cancel'), eventId: z.string() }),
  z.object({ type: z.literal('interaction'), eventId: z.string(), chatId: z.string(), event: z.enum(['approval/request', 'user-questions/request']), request: z.record(z.string(), z.unknown()) }),
])
type Handler = (request: Record<string, unknown>, next: () => Promise<unknown>) => unknown

/**
 * Start an independent browser connection with renewable credentials and chat-scoped listeners.
 * @param config - Server origin, credential callback and optional route or reconnect settings.
 * @returns Client immediately while connecting; dispose() awaits event-loop and callback teardown.
 */
// oxlint-disable-next-line typescript/require-await -- Configuration errors reject through the existing asynchronous factory API.
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
    } catch (error) { if (!isAborted(lifetime.signal) && !supplied?.aborted) yield failure(error) }
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
      return await Promise.resolve(handler({ ...event.request, signal: interactionSignal }, () => dispatch(index + 1)))
    }
    try {
      const value = await abortable(dispatch(0), interactionSignal)
      if (isAborted(interactionSignal)) return
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispatch mutates delegated while awaiting its handler chain.
      const outcome = delegated && value === undefined ? { kind: 'next' } : { kind: 'result', value }
      const response = await fetchRequest('result', { clientId, eventId: event.eventId, outcome }, interactionSignal)
      if (!response.ok) throw new Error('Browser interaction response was rejected')
    } catch {
      if (!isAborted(interactionSignal)) {
        // A failed answerer delegates rather than approving or dropping the pending decision.
        await fetchRequest('result', { clientId, eventId: event.eventId, outcome: { kind: 'next' } }, interactionSignal).catch(() => { /* A failed fallback request cannot settle the server interaction; connection teardown releases its recipient. */ })
      }
    } finally {
      if (interactions.get(event.eventId) === controller) interactions.delete(event.eventId)
    }
  }

  const eventLoop = (async () => {
    while (!isAborted(lifetime.signal)) {
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
            void callback.then(() => { callbacks.delete(callback) })
          }
        }
      } catch {
        // Connection and credential failures enter the same renewable reconnect loop.
      } finally {
        currentReady.resolve()
        for (const controller of interactions.values()) controller.abort(new Error('Browser connection replaced'))
        interactions.clear()
        generation.set(undefined)
        if (!isAborted(lifetime.signal)) state.set('connecting')
      }
      if (isAborted(lifetime.signal)) break
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
            return {
              answers: parsed.answers.map(item => ({
                id: item.id, selected: item.selected, ...(item.custom === undefined ? {} : { custom: item.custom }),
              })),
            }
          })
        const byEvent = listeners.get(chatId) ?? new Map<string, Set<Handler>>()
        const handlers = byEvent.get(event) ?? new Set<Handler>()
        handlers.add(adapted); byEvent.set(event, handlers); listeners.set(chatId, byEvent)
        return () => {
          handlers.delete(adapted)
          if (handlers.size === 0) byEvent.delete(event)
          if (byEvent.size === 0) listeners.delete(chatId)
        }
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
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) {
        try { listener() } catch (error) { console.error('Browser connection observer failed', error) }
      }
    },
  }
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
  } finally {
    await reader.cancel().catch(() => {
      // A failed stream can reject cancellation; its reader lock must still be released.
    })
    reader.releaseLock()
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function abortable<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('Browser request failed', { cause: reason }))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
