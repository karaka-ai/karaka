/** Authenticated HTTP JSON and SSE transport for application-owned Karaka chats. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { TenantId, UserId, type ApplicationId, type ApplicationOwner } from '@karaka-ai/identity'
import { SessionId as sessionId } from '@deepseek-ai/dsh-session'
import { ApplicationChatController, type FollowFrame as SessionFollowFrame } from './application.ts'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import {
  ApplicationAddressRequestSchema,
  ApplicationCreateChatRequestSchema,
  ApplicationModelRequestSchema,
  ApplicationPromptRequestSchema,
  ApplicationRespondRequestSchema,
  KARAKA_APPLICATION_API_PATH,
  type ApplicationChatEvent,
  type ApplicationIdentity,
} from '@karaka-ai/sdk'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './startup.ts'
import type {} from '@karaka-ai/server-auth'
import type {} from '@karaka-ai/browser-auth'
import { mountBrowserRoutes } from './browser-routes.ts'
import { json, readObject, writeEvent } from './http.ts'

export const name = 'karaka-transport-http'
export const inject = ['serverAuth', 'karakaIdentity', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence', 'sessionProjections', 'agentDefaultModel', 'llm', 'webServer', 'karakaStartup']

/** HTTP transport configuration. */
export interface Config {
  /** Register this transport as an application question recipient. Default: true. */
  readonly handleQuestions?: boolean
  /** Route prefix mounted on the shared Host web server. */
  readonly path?: string
  /** Maximum accepted JSON request body size in bytes. */
  readonly maxBodyBytes?: number
  /** Optional JWT-authenticated browser endpoint; requires browser-auth and explicit origins. */
  readonly browserPath?: string
  /** Exact browser origins allowed on browserPath. */
  readonly browserOrigins?: string[]
  /** Browser operations mounted at browserPath; defaults to all six application methods. */
  readonly browserMethods?: ('applicationAgents' | 'applicationCreate' | 'applicationPrompt' | 'applicationHistory' | 'applicationFollow' | 'applicationCancel')[]
  /** Owner-scoped interactions delivered to browsers; defaults to approvals and questions. */
  readonly browserEvents?: ('approval/request' | 'user-questions/request')[]
}

export const Config: z<Config> = z.object({
  handleQuestions: z.boolean().default(true),
  path: z.string().default(KARAKA_APPLICATION_API_PATH),
  maxBodyBytes: z.natural().default(1_048_576),
  browserPath: z.string(),
  browserOrigins: z.array(z.string()),
  browserMethods: z.array(z.union(['applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel'])).default(['applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel']),
  browserEvents: z.array(z.union(['approval/request', 'user-questions/request'])).default(['approval/request', 'user-questions/request']),
})

interface PendingInteraction {
  readonly id: string
  readonly chatId: SessionId
  readonly owner: ApplicationOwner
  readonly questions: AskUserQuestionRequestEvent['questions']
  readonly cursor: number
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: unknown) => void
}

interface ActiveHttpRequest {
  readonly controller: AbortController
  readonly request: IncomingMessage
  readonly response: ServerResponse
}

/** Mount authenticated application routes onto the shared Host web server. */
export function apply(ctx: Context, config: Config): void {
  const startup = ctx.karakaStartup
  new ApplicationChatController(ctx)
  const base = normalizeBase(config.path ?? KARAKA_APPLICATION_API_PATH)
  const maxBodyBytes = config.maxBodyBytes ?? 1_048_576
  const pending = new Map<string, PendingInteraction>()
  const subscribers = new Map<SessionId, Set<(event: InteractionEvent) => void>>()
  const activeRequests = new Map<Promise<void>, ActiveHttpRequest>()

  ctx.effect(() => async () => {
    const error = new Error('Karaka HTTP transport was disposed')
    for (const { controller, request, response } of activeRequests.values()) {
      controller.abort(error)
      request.destroy()
      response.destroy()
    }
    for (const interaction of pending.values()) interaction.reject(error)
    pending.clear()
    subscribers.clear()
    await Promise.allSettled(activeRequests.keys())
  }, 'karaka-transport-http.pending')

  const mount = (routeBase: string): void => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: routeBase,
      handler: (request, response) => {
        if (!startup.ready) {
          json(response, 503, { code: 'STARTING', message: 'Application is starting' })
          return
        }
        const controller = new AbortController()
        const abort = (): void => { controller.abort(new Error('HTTP peer disconnected')) }
        request.once('aborted', abort)
        response.once('close', abort)
        const operation = handleRequest(
          ctx, routeBase, maxBodyBytes, pending, subscribers, controller, request, response,
        ).finally(() => {
          request.off('aborted', abort)
          response.off('close', abort)
          activeRequests.delete(operation)
        })
        activeRequests.set(operation, { controller, request, response })
        return operation
      },
    }))
  }
  mount(base)
  if (config.browserPath !== undefined) {
    if (config.browserOrigins === undefined || config.browserOrigins.length === 0) throw new Error('Browser transport requires explicit origins')
    const browserBase = normalizeBase(config.browserPath)
    if (browserBase === base || browserBase.startsWith(`${base}/`) || base.startsWith(`${browserBase}/`)) throw new Error('Browser and backend paths must be disjoint')
    mountBrowserRoutes(ctx, config, () => startup.ready)
  }

  if (config.handleQuestions === false) return

  ctx.on('user-questions/request', async (request, next) => {
    const agent = request.agent
    const owner = agent === undefined ? undefined : await ctx.karakaIdentity.ownerOf(agent.session)
    if (agent === undefined || owner === undefined) return next()
    const id = randomUUID()
    const deferred: PromiseWithResolvers<AskUserQuestionAnswer> = Promise.withResolvers()
    const abort = (): void => {
      pending.delete(id)
      deferred.reject(request.signal?.reason ?? new Error('Interaction was cancelled'))
    }
    try {
      const interaction: PendingInteraction = {
        id,
        chatId: agent.id,
        owner,
        questions: request.questions,
        cursor: agent.session.seq - 1,
        resolve: deferred.resolve,
        reject: deferred.reject,
      }
      pending.set(id, interaction)
      publish(subscribers, agent.id, {
        type: 'interaction-required',
        cursor: interaction.cursor,
        interactionId: id,
        questions: request.questions,
      })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
      return await deferred.promise
    } finally {
      request.signal?.removeEventListener('abort', abort)
      pending.delete(id)
    }
  }, { global: true })
}

async function handleRequest(
  ctx: Context,
  base: string,
  maxBodyBytes: number,
  pending: Map<string, PendingInteraction>,
  subscribers: Map<SessionId, Set<(event: InteractionEvent) => void>>,
  controller: AbortController,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const authenticated = await ctx.serverAuth.authenticate(
      request.headers.authorization,
      controller.signal,
    )
    if (authenticated === undefined) {
      json(response, 401, { code: 'UNAUTHORIZED', message: 'Invalid server credential' })
      return
    }
    await route(
      ctx, base, maxBodyBytes, authenticated.applicationId, pending, subscribers,
      controller, request, response,
    )
  } catch (error: unknown) {
    if (controller.signal.aborted || response.destroyed) return
    const exposed = exposeError(error)
    if (response.headersSent) {
      await writeEvent(response, {
        type: 'error',
        code: exposed.code,
        message: exposed.message,
      }, controller.signal)
      response.end()
      return
    }
    json(response, exposed.status, { code: exposed.code, message: exposed.message })
  }
}

async function route(
  ctx: Context,
  base: string,
  maxBodyBytes: number,
  applicationId: ApplicationId,
  pending: Map<string, PendingInteraction>,
  subscribers: Map<SessionId, Set<(event: InteractionEvent) => void>>,
  controller: AbortController,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const ownerFor = (body: ApplicationIdentity): ApplicationOwner => {
    const owner = ownerFrom(applicationId, body)
    return owner
  }
  const url = new URL(request.url ?? '/', 'http://karaka.local')
  const relative = url.pathname.slice(base.length)
  if (request.method === 'GET' && relative === '/agents') {
    json(response, 200, await ctx.karakaApplication.listAgents(controller.signal))
    return
  }
  if (request.method === 'POST' && relative === '/chats') {
    const body = ApplicationCreateChatRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
    const owner = ownerFor(body)
    json(response, 201, await ctx.karakaApplication.create({
      chatId: sessionId(body.chatId),
      agentId: body.agentId,
      owner,
    }, controller.signal))
    return
  }
  const match = /^\/chats\/([^/]+)\/(messages|stream|history|cancel|model|responses)$/u.exec(relative)
  if (request.method !== 'POST' || match === null) {
    json(response, 404, { code: 'NOT_FOUND', message: 'Route not found' })
    return
  }
  const chatId = sessionId(decodeURIComponent(match[1] as string))
  const operation = match[2] as 'messages' | 'stream' | 'history' | 'cancel' | 'model' | 'responses'
  switch (operation) {
    case 'messages': {
      const body = ApplicationPromptRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFor(body)
      const result = await ctx.karakaApplication.prompt({
        chatId,
        requestId: body.requestId,
        owner,
        content: body.content.map(part => part.type === 'text'
          ? part
          : {
            type: 'image',
            mediaType: part.mediaType,
            data: part.data,
            ...(part.name === undefined ? {} : { name: part.name }),
          }),
      }, controller.signal)
      json(response, 202, { chatId, requestId: body.requestId, ...result })
      return
    }
    case 'history': {
      const body = ApplicationAddressRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFor(body)
      const events = await ctx.karakaApplication.events({ chatId, owner }, controller.signal)
      json(response, 200, { chatId, events: events.flatMap(projectEvent) })
      return
    }
    case 'cancel': {
      const body = ApplicationAddressRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFor(body)
      json(response, 200, await ctx.karakaApplication.cancel({ chatId, owner }, controller.signal))
      return
    }
    case 'model': {
      const body = ApplicationModelRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFor(body)
      json(response, 200, await ctx.karakaApplication.selectModel({
        chatId,
        owner,
        provider: body.provider,
        model: body.model,
        ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
      }, controller.signal))
      return
    }
    case 'responses': {
      const body = ApplicationRespondRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFor(body)
      const interaction = pending.get(body.interactionId)
      if (interaction === undefined || interaction.chatId !== chatId || !sameOwner(interaction.owner, owner)) {
        throw Object.assign(new Error('Interaction is not pending for this chat'), { code: 'CHAT_FORBIDDEN' })
      }
      pending.delete(body.interactionId)
      interaction.resolve({
        answers: body.answers.answers.map(item => ({
          id: item.id,
          selected: item.selected,
          ...(item.custom === undefined ? {} : { custom: item.custom }),
        })),
      })
      json(response, 200, { accepted: true })
      return
    }
    case 'stream': {
      const body = ApplicationAddressRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFor(body)
      await stream(ctx, chatId, owner, body.cursor, pending, subscribers, controller, response)
      return
    }
  }
}

async function stream(
  ctx: Context,
  chatId: SessionId,
  owner: ApplicationOwner,
  cursor: number | undefined,
  pending: Map<string, PendingInteraction>,
  subscribers: Map<SessionId, Set<(event: InteractionEvent) => void>>,
  controller: AbortController,
  response: ServerResponse,
): Promise<void> {
  const buffered: InteractionEvent[] = []
  const queuedInteractions = new Set<string>()
  let directWake = Promise.withResolvers<void>()
  const direct = (event: InteractionEvent): void => {
    /* v8 ignore next -- duplicate delivery requires an Agent event during kernel-level SSE backpressure */
    if (queuedInteractions.has(event.interactionId)) return
    queuedInteractions.add(event.interactionId)
    buffered.push(event)
    directWake.resolve()
  }
  const set = subscribers.get(chatId) ?? new Set()
  const frames = ctx.karakaApplication.follow({ chatId, owner }, controller.signal)[Symbol.asyncIterator]()
  let completed = false
  try {
    const first = await frames.next()
    if (first.done) throw new Error('application chat stream ended before its opening snapshot')
    if (first.value.type !== 'snapshot') throw new Error('application chat stream did not open with a snapshot')
    if (cursor !== undefined && cursor > first.value.cursor) {
      throw Object.assign(new Error('stream cursor is past the durable chat cursor'), { code: 'BAD_REQUEST' })
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    set.add(direct)
    subscribers.set(chatId, set)
    await writeFollowFrame(response, first.value, cursor, controller.signal)
    let durableCursor = first.value.cursor
    for (const interaction of pending.values()) {
      if (interaction.chatId !== chatId || !sameOwner(interaction.owner, owner)) continue
      direct({
        type: 'interaction-required',
        cursor: interaction.cursor,
        interactionId: interaction.id,
        questions: interaction.questions,
      })
    }
    let nextFrame = frames.next()
    while (true) {
      await drainBufferedInteractions(
        response, buffered, queuedInteractions, durableCursor, controller.signal,
      )
      const wake = directWake.promise
      const next = await Promise.race([
        nextFrame.then(frame => ({ kind: 'frame' as const, frame })),
        wake.then(() => ({ kind: 'direct' as const })),
      ])
      if (next.kind === 'direct') {
        directWake = Promise.withResolvers<void>()
        continue
      }
      if (next.frame.done) break
      durableCursor = next.frame.value.type === 'snapshot'
        ? next.frame.value.cursor
        : next.frame.value.type === 'event' ? next.frame.value.event.seq : durableCursor
      await writeFollowFrame(response, next.frame.value, cursor, controller.signal)
      nextFrame = frames.next()
    }
    completed = true
  } finally {
    await frames.return?.()
    set.delete(direct)
    if (set.size === 0) subscribers.delete(chatId)
    if (completed) response.end()
  }
}

async function drainBufferedInteractions(
  response: ServerResponse,
  buffered: InteractionEvent[],
  queued: Set<string>,
  durableCursor: number,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    const index = buffered.findIndex(event => event.cursor <= durableCursor)
    if (index === -1) return
    const event = buffered.splice(index, 1)[0] as InteractionEvent
    queued.delete(event.interactionId)
    await writeEvent(response, event, signal)
  }
}

type WireEvent = ApplicationChatEvent
type InteractionEvent = Extract<WireEvent, { readonly type: 'interaction-required' }>

async function writeFollowFrame(
  response: ServerResponse,
  frame: SessionFollowFrame,
  cursor: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (frame.type === 'text-delta') {
    await writeEvent(response, frame, signal)
    return
  }
  if (frame.type === 'snapshot') {
    for (const record of frame.records) {
      if (cursor !== undefined && record.event.seq <= cursor) continue
      for (const event of projectWireEvent(record.event)) await writeEvent(response, event, signal)
    }
    await writeEvent(response, { type: 'snapshot', cursor: frame.cursor }, signal)
    return
  }
  if (cursor !== undefined && frame.event.seq <= cursor) return
  for (const event of projectWireEvent(frame.event)) await writeEvent(response, event, signal)
}

function projectEvent(event: SessionEvent): WireEvent[] {
  return projectWireEvent(event)
}

function projectWireEvent(event: SessionEvent): WireEvent[] {
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user'
        ? [{ type: 'user-message', cursor: event.seq, content: event.data }]
        : []
    case 'assistant/message':
      return [{ type: 'assistant-message', cursor: event.seq, content: event.data.message }]
    case 'tool/call':
      return [{ type: 'tool-call', cursor: event.seq, callId: event.data.callId, name: event.data.name, arguments: event.data.arguments }]
    case 'tool/result':
      return [{ type: 'tool-result', cursor: event.seq, callId: event.data.message.source.callId, content: event.data.message }]
    case 'turn/end':
      return [{ type: 'turn-end', cursor: event.seq, reason: event.data.reason }]
    default:
      // Other session events have no application transcript representation.
      return []
  }
}

function ownerFrom(applicationId: ApplicationId, body: ApplicationIdentity): ApplicationOwner {
  return { applicationId, tenantId: TenantId(body.tenantId), userId: UserId(body.userId) }
}

function sameOwner(left: ApplicationOwner, right: ApplicationOwner): boolean {
  return left.applicationId === right.applicationId && left.tenantId === right.tenantId && left.userId === right.userId
}

function publish(
  subscribers: Map<SessionId, Set<(event: InteractionEvent) => void>>,
  chatId: SessionId,
  event: InteractionEvent,
): void {
  for (const subscriber of subscribers.get(chatId) ?? []) subscriber(event)
}

function normalizeBase(path: string): string {
  if (!path.startsWith('/') || path === '/' || path.endsWith('/')) throw new Error('transport-http path must start with / and have no trailing slash')
  return path
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function exposeError(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  const code = errorCode(error)
  if (code === 'forbidden') return { status: 403, code: 'CHAT_FORBIDDEN', message: 'Chat access is forbidden' }
  if (code === 'unavailable') return { status: 503, code: 'CHAT_UNAVAILABLE', message: 'Chat storage is unavailable' }
  if (code === 'CHAT_FORBIDDEN') return { status: 403, code, message: 'Chat access is forbidden' }
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found') {
    return { status: 404, code: 'CHAT_NOT_FOUND', message: 'Chat not found' }
  }
  if (code === 'agent-preset/not-found') {
    return { status: 404, code: 'AGENT_NOT_FOUND', message: 'Agent not found' }
  }
  if (code === 'session/conflict' || code === 'agent-preset/conflict' || code === 'session/agent-busy') {
    return { status: 409, code: 'CHAT_CONFLICT', message: 'Chat state conflicts with this operation' }
  }
  if (code === 'BAD_REQUEST' || code === 'gateway/bad-request'
    || code === 'session/model-unavailable' || code === 'session/attachment-invalid'
    || code === 'agent-preset/invalid' || (error instanceof Error && error.name === 'ZodError')) {
    return { status: 400, code: 'BAD_REQUEST', message: 'Invalid request' }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }
}
