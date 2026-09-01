/** Authenticated HTTP JSON and SSE transport for application-owned Karaka chats. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ApplicationId, ApplicationOwner, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as sessionId, TenantId, UserId } from '@deepseek-ai/dsh-session'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
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
} from '@karaka/sdk'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@karaka/server-auth'

export const name = 'karaka-transport-http'
export const inject = ['serverAuth', 'sessionController', 'webServer']

/** HTTP transport configuration. */
export interface Config {
  /** Route prefix mounted on the shared Host web server. */
  readonly path?: string
  /** Maximum accepted JSON request body size in bytes. */
  readonly maxBodyBytes?: number
}

export const Config: z<Config> = z.object({
  path: z.string().default(KARAKA_APPLICATION_API_PATH),
  maxBodyBytes: z.natural().default(1_048_576),
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
  const base = normalizeBase(config.path ?? KARAKA_APPLICATION_API_PATH)
  const maxBodyBytes = config.maxBodyBytes ?? 1_048_576
  const pending = new Map<string, PendingInteraction>()
  const subscribers = new Map<SessionId, Set<(event: WireEvent) => void>>()
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: base,
    handler: (request, response) => {
      const controller = new AbortController()
      const abort = (): void => { controller.abort(new Error('HTTP peer disconnected')) }
      request.once('aborted', abort)
      response.once('close', abort)
      const operation = handleRequest(
        ctx, base, maxBodyBytes, pending, subscribers, controller, request, response,
      ).finally(() => {
        request.off('aborted', abort)
        response.off('close', abort)
        activeRequests.delete(operation)
      })
      activeRequests.set(operation, { controller, request, response })
      return operation
    },
  }))

  ctx.on('user-questions/request', async (request, next) => {
    const agent = request.agent
    const owner = agent?.session.header.applicationOwner
    if (agent === undefined || owner === undefined) return next()
    const id = randomUUID()
    const deferred: PromiseWithResolvers<AskUserQuestionAnswer> = Promise.withResolvers()
    const abort = (): void => {
      if (!pending.delete(id)) return
      deferred.reject(request.signal?.reason ?? new Error('Interaction was cancelled'))
    }
    try {
      const interaction: PendingInteraction = {
        id,
        chatId: agent.id,
        owner,
        questions: request.questions,
        cursor: agent.session.events.at(-1)?.seq ?? -1,
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
  subscribers: Map<SessionId, Set<(event: WireEvent) => void>>,
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
  subscribers: Map<SessionId, Set<(event: WireEvent) => void>>,
  controller: AbortController,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://karaka.local')
  const relative = url.pathname.slice(base.length)
  if (request.method === 'GET' && relative === '/agents') {
    json(response, 200, await ctx.sessionController.application.listAgents(controller.signal))
    return
  }
  if (request.method === 'POST' && relative === '/chats') {
    const body = ApplicationCreateChatRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
    const owner = ownerFrom(applicationId, body)
    json(response, 201, await ctx.sessionController.application.create({
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
  const operation = match[2]
  if (operation === undefined) throw new Error('Matched chat route has no operation')
  switch (operation) {
    case 'messages': {
      const body = ApplicationPromptRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFrom(applicationId, body)
      const result = await ctx.sessionController.application.prompt({
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
      const owner = ownerFrom(applicationId, body)
      const events = await ctx.sessionController.application.events({ chatId, owner }, controller.signal)
      json(response, 200, { chatId, events: events.flatMap(projectEvent) })
      return
    }
    case 'cancel': {
      const body = ApplicationAddressRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFrom(applicationId, body)
      json(response, 200, await ctx.sessionController.application.cancel({ chatId, owner }, controller.signal))
      return
    }
    case 'model': {
      const body = ApplicationModelRequestSchema.parse(await readObject(request, maxBodyBytes, controller.signal))
      const owner = ownerFrom(applicationId, body)
      json(response, 200, await ctx.sessionController.application.selectModel({
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
      const owner = ownerFrom(applicationId, body)
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
      const owner = ownerFrom(applicationId, body)
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
  subscribers: Map<SessionId, Set<(event: WireEvent) => void>>,
  controller: AbortController,
  response: ServerResponse,
): Promise<void> {
  const buffered: WireEvent[] = []
  const deliveredInteractions = new Set<string>()
  const queuedInteractions = new Set<string>()
  let directWake = Promise.withResolvers<void>()
  const direct = (event: WireEvent): void => {
    if (event.type === 'interaction-required') {
      if (deliveredInteractions.has(event.interactionId) || queuedInteractions.has(event.interactionId)) return
      queuedInteractions.add(event.interactionId)
    }
    buffered.push(event)
    directWake.resolve()
  }
  const set = subscribers.get(chatId) ?? new Set()
  const frames = ctx.sessionController.application.follow({ chatId, owner }, controller.signal)[Symbol.asyncIterator]()
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
        response, buffered, queuedInteractions, deliveredInteractions, durableCursor, controller.signal,
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
        : next.frame.value.event.seq
      await writeFollowFrame(response, next.frame.value, cursor, controller.signal)
      nextFrame = frames.next()
    }
    completed = true
  } finally {
    await frames.return?.()
    set.delete(direct)
    if (set.size === 0) subscribers.delete(chatId)
    if (completed && response.headersSent && !response.writableEnded) response.end()
  }
}

async function drainBufferedInteractions(
  response: ServerResponse,
  buffered: WireEvent[],
  queued: Set<string>,
  delivered: Set<string>,
  durableCursor: number,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    const index = buffered.findIndex(event => event.type !== 'interaction-required' || event.cursor <= durableCursor)
    if (index === -1) return
    const [event] = buffered.splice(index, 1)
    if (event === undefined) return
    if (event.type === 'interaction-required') {
      queued.delete(event.interactionId)
      if (delivered.has(event.interactionId)) continue
      delivered.add(event.interactionId)
    }
    await writeEvent(response, event, signal)
  }
}

type WireEvent = ApplicationChatEvent

async function writeFollowFrame(
  response: ServerResponse,
  frame: SessionFollowFrame,
  cursor: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (frame.type === 'snapshot') {
    for (const record of frame.records) {
      if (record.type !== 'event' || (cursor !== undefined && record.event.seq <= cursor)) continue
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

function projectWireEvent(event: { readonly type: string; readonly seq: number; readonly data: unknown }): WireEvent[] {
  const data = event.data as Record<string, unknown>
  if (event.type === 'user/message') {
    const source = data.source as Record<string, unknown> | undefined
    return source?.kind === 'user'
      ? [{ type: 'user-message', cursor: event.seq, content: data }]
      : []
  }
  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk as Record<string, unknown> | undefined
    return chunk?.type === 'text-delta' && typeof chunk.text === 'string'
      ? [{ type: 'text-delta', cursor: event.seq, text: chunk.text }]
      : []
  }
  if (event.type === 'assistant/message') {
    return [{ type: 'assistant-message', cursor: event.seq, content: data.message }]
  }
  if (event.type === 'tool/call') {
    return typeof data.callId === 'string' && typeof data.name === 'string' && typeof data.arguments === 'string'
      ? [{ type: 'tool-call', cursor: event.seq, callId: data.callId, name: data.name, arguments: data.arguments }]
      : []
  }
  if (event.type === 'tool/result') {
    const message = data.message as Record<string, unknown> | undefined
    const source = message?.source as Record<string, unknown> | undefined
    return typeof source?.callId === 'string'
      ? [{ type: 'tool-result', cursor: event.seq, callId: source.callId, content: data.result ?? data.message ?? data }]
      : []
  }
  if (event.type === 'turn/end') return [{ type: 'turn-end', cursor: event.seq, reason: data.reason }]
  return []
}

function ownerFrom(applicationId: ApplicationId, body: ApplicationIdentity): ApplicationOwner {
  return { applicationId, tenantId: TenantId(body.tenantId), userId: UserId(body.userId) }
}

function sameOwner(left: ApplicationOwner, right: ApplicationOwner): boolean {
  return left.applicationId === right.applicationId && left.tenantId === right.tenantId && left.userId === right.userId
}

function readObject(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      signal.removeEventListener('abort', onSignal)
    }
    const fail = (error: unknown): void => {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onData = (chunk: Buffer | Uint8Array): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > maxBytes) {
        fail(badRequest(`request body exceeds ${String(maxBytes)} bytes`))
        return
      }
      chunks.push(bytes)
    }
    const onEnd = (): void => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('request body must be an object')
        }
        cleanup()
        resolve(parsed as Record<string, unknown>)
      } catch (error: unknown) {
        fail(badRequest(error instanceof Error ? error.message : 'invalid JSON request body'))
      }
    }
    const onError = (error: Error): void => { fail(error) }
    const onAborted = (): void => { fail(new Error('request body was aborted')) }
    const onSignal = (): void => { fail(signal.reason ?? new Error('request body was cancelled')) }
    if (signal.aborted) {
      onSignal()
      return
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
    signal.addEventListener('abort', onSignal, { once: true })
  })
}

function publish(subscribers: Map<SessionId, Set<(event: WireEvent) => void>>, chatId: SessionId, event: WireEvent): void {
  for (const subscriber of subscribers.get(chatId) ?? []) subscriber(event)
}

function tryWriteEvent(response: ServerResponse, event: WireEvent): boolean {
  return response.write(`data: ${JSON.stringify(event)}\n\n`)
}

async function writeEvent(response: ServerResponse, event: WireEvent, signal: AbortSignal): Promise<void> {
  if (tryWriteEvent(response, event)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new Error('SSE response closed before draining')) }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('SSE write cancelled'))
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
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

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' })
}

function exposeError(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  const code = errorCode(error)
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
