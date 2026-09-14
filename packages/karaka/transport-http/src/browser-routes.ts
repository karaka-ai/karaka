/** JWT-authenticated browser operations and owner-scoped interaction delivery. */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApplicationOwner } from '@karaka-ai/identity'
import { sameOwner } from '@karaka-ai/identity'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { ApplicationCreateChatRequestSchema, ApplicationPromptRequestSchema } from '@karaka-ai/sdk'
import type {} from '@karaka-ai/browser-auth'
import { json, readObject, writeJsonEvent } from './http.ts'
import type { Config } from './index.ts'

interface Channel { readonly id: string; readonly owner: ApplicationOwner; readonly push: (event: unknown) => void }
interface Pending {
  readonly id: string
  readonly chatId: string
  readonly owner: ApplicationOwner
  readonly event: 'approval/request' | 'user-questions/request'
  readonly request: unknown
  readonly recipients: Set<string>
  readonly resolve: (outcome: { readonly kind: 'next' } | { readonly kind: 'result'; readonly value: unknown }) => void
  readonly reject: (error: unknown) => void
}
const address = z.strictObject({ chatId: z.string().min(1) })
const create = ApplicationCreateChatRequestSchema.omit({ tenantId: true, userId: true })
const prompt = ApplicationPromptRequestSchema.omit({ tenantId: true, userId: true }).extend({ chatId: z.string().min(1) }).strict()
const answer = z.strictObject({
  answers: z.array(z.strictObject({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })),
})
const outcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('next') }),
  z.strictObject({ kind: z.literal('result'), value: z.unknown() }),
])
const resultSchema = z.strictObject({ clientId: z.string(), eventId: z.string(), outcome: outcomeSchema })

/**
 * Mount JWT-authenticated application methods and owner-scoped interaction delivery.
 * @param ctx - Context providing the application controller and authorization services.
 * @param config - Browser route, allowed origins and enabled capabilities.
 * @param ready - Whether the application has completed startup.
 */
export function mountBrowserRoutes(ctx: Context, config: Config, ready: () => boolean): void {
  const path = config.browserPath
  if (path === undefined) return
  if (config.browserOrigins === undefined || config.browserOrigins.length === 0) throw new Error('Browser transport requires explicit origins')
  const methods = new Set(config.browserMethods ?? ['applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel'])
  const events = new Set(config.browserEvents ?? ['approval/request', 'user-questions/request'])
  const channels = new Map<string, Channel>()
  const pending = new Map<string, Pending>()
  const active = new Set<AbortController>()
  const lifetime = new AbortController()
  ctx.effect(() => () => {
    const error = new Error('Browser transport disposed')
    lifetime.abort(error)
    for (const controller of active) controller.abort(error)
    for (const item of pending.values()) item.reject(error)
    pending.clear()
    channels.clear()
  })

  const ask = async (event: Pending['event'], chatId: string, owner: ApplicationOwner, request: unknown, signal?: AbortSignal) => {
    const recipients = new Set([...channels.values()].filter(channel => sameOwner(channel.owner, owner)).map(channel => channel.id))
    if (recipients.size === 0) return { kind: 'next' as const }
    const deferred = Promise.withResolvers<
      { readonly kind: 'next' } | { readonly kind: 'result'; readonly value: unknown }
    >()
    const item: Pending = {
      id: randomUUID(), chatId, owner, event, request, recipients, resolve: deferred.resolve, reject: deferred.reject,
    }
    pending.set(item.id, item)
    const abort = (): void => { deferred.reject(signal?.reason ?? new Error('Interaction cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    for (const id of recipients) channels.get(id)?.push(frame(item))
    try {
      if (signal?.aborted) abort()
      return await deferred.promise
    } finally {
      pending.delete(item.id)
      signal?.removeEventListener('abort', abort)
      for (const channel of channels.values()) if (sameOwner(channel.owner, owner)) channel.push({ type: 'cancel', eventId: item.id })
    }
  }
  if (events.has('approval/request')) ctx.on('approval/request', async (request, next) => {
    const owner = await ctx.karakaIdentity.ownerOf(request.agent.session)
    if (owner === undefined) return next()
    const result = await ask('approval/request', request.agent.id, owner, {
      agent: { id: request.agent.id }, toolName: request.toolName,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.callId === undefined ? {} : { callId: request.callId }),
    }, request.signal)
    return result.kind === 'next' ? next() : result.value as ApprovalOutcome
  }, { global: true, prepend: true })
  if (events.has('user-questions/request')) ctx.on('user-questions/request', async (request, next) => {
    if (request.agent === undefined) return next()
    const owner = await ctx.karakaIdentity.ownerOf(request.agent.session)
    if (owner === undefined) return next()
    const result = await ask('user-questions/request', request.agent.id, owner, { agent: { id: request.agent.id }, questions: request.questions }, request.signal)
    return result.kind === 'next' ? next() : result.value as AskUserQuestionAnswer
  }, { global: true, prepend: true })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path, handler: async (request, response) => {
    if (!ready()) { json(response, 503, { code: 'STARTING', message: 'Application is starting' }); return }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime.signal])
    active.add(controller)
    const abort = (): void => { controller.abort(new Error('Browser disconnected')) }
    request.once('aborted', abort)
    response.once('close', abort)
    let expiry: ReturnType<typeof setTimeout> | undefined
    let operation = 'authentication'
    try {
      const origin = request.headers.origin
      if (origin === undefined || !config.browserOrigins?.includes(origin)) { json(response, 403, { code: 'ORIGIN_FORBIDDEN', message: 'Browser origin is forbidden' }); return }
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'Origin')
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'POST')
        response.setHeader('access-control-allow-headers', 'authorization,content-type')
        response.writeHead(204).end(); return
      }
      const verifier = ctx.get('karakaBrowserAuth')
      if (verifier === undefined) throw new Error('Browser authentication is not configured')
      const token = /^Bearer ([^\s]+)$/iu.exec(request.headers.authorization ?? '')?.[1]
      const caller = token === undefined ? undefined : await verifier.authenticate(token)
      if (caller === undefined) { json(response, 401, { code: 'UNAUTHORIZED', message: 'Invalid browser credential' }); return }
      expiry = setTimeout(() => { controller.abort(new Error('Browser credential expired')); response.destroy() }, Math.max(0, caller.expiresAt - Date.now()))
      const method = new URL(request.url ?? '/', 'http://karaka.local').pathname.slice(path.length + 1)
      operation = ['events', 'result', 'applicationAgents', 'applicationCreate', 'applicationPrompt', 'applicationHistory', 'applicationFollow', 'applicationCancel'].includes(method) ? method : 'unknown-route'
      if (request.method !== 'POST') { json(response, 405, { code: 'METHOD_FORBIDDEN', message: 'POST required' }); return }
      const body = await readObject(request, config.maxBodyBytes ?? 1_048_576, signal)
      if (method === 'events') {
        z.strictObject({}).parse(body)
        await eventChannel(caller.owner, response, signal); return
      }
      if (method === 'result') {
        const result = resultSchema.parse(body)
        const channel = channels.get(result.clientId)
        const item = pending.get(result.eventId)
        if (channel === undefined || item === undefined || !sameOwner(channel.owner, caller.owner)
          || !sameOwner(item.owner, caller.owner) || !item.recipients.has(channel.id)) {
          throw Object.assign(new Error('Interaction is unavailable to this caller'), { code: 'CHAT_FORBIDDEN' })
        }
        if (result.outcome.kind === 'result') {
          const value = item.event === 'approval/request'
            ? z.enum(['allowed-once', 'rejected', 'cancelled', 'unavailable']).parse(result.outcome.value)
            : answer.parse(result.outcome.value)
          item.resolve({ kind: 'result', value })
        } else {
          item.recipients.delete(channel.id)
          if (item.recipients.size === 0) item.resolve({ kind: 'next' })
        }
        json(response, 200, { ok: true, value: null }); return
      }
      if (!methods.has(method)) { json(response, 403, { code: 'METHOD_FORBIDDEN', message: 'Browser method is unavailable' }); return }
      const owner = caller.owner
      let value: unknown
      if (method === 'applicationAgents') { z.strictObject({}).parse(body); value = await ctx.karakaApplication.listAgents(signal) }
      else if (method === 'applicationCreate') { const input = create.parse(body); value = await ctx.karakaApplication.create({ chatId: SessionId(input.chatId), agentId: input.agentId, owner }, signal) }
      else if (method === 'applicationPrompt') { const input = prompt.parse(body); value = await ctx.karakaApplication.prompt({ requestId: input.requestId, chatId: SessionId(input.chatId), owner, content: input.content.map(part => part.type === 'text' ? part : { type: part.type, mediaType: part.mediaType, data: part.data, ...(part.name === undefined ? {} : { name: part.name }) }) }, signal) }
      else {
        const input = address.parse(body)
        const target = { chatId: SessionId(input.chatId), owner }
        if (method === 'applicationHistory') value = await ctx.karakaApplication.events(target, signal)
        else if (method === 'applicationCancel') value = await ctx.karakaApplication.cancel(target, signal)
        else {
          const frames = ctx.karakaApplication.follow(target, signal)[Symbol.asyncIterator]()
          try {
            const first = await frames.next()
            if (first.done) throw new Error('Chat follow ended before snapshot')
            openEvents(response)
            await writeJsonEvent(response, { ok: true, value: first.value }, signal)
            for (let next = await frames.next(); !next.done; next = await frames.next()) {
              await writeJsonEvent(response, { ok: true, value: next.value }, signal)
            }
          } finally { await frames.return?.() }
          response.end(); return
        }
      }
      json(response, 200, { ok: true, value })
    } catch (error) {
      if (signal.aborted || response.destroyed) return
      const code = error instanceof Error && 'code' in error ? String(error.code) : error instanceof z.ZodError ? 'BAD_REQUEST' : 'INTERNAL_ERROR'
      const denied = code === 'forbidden' || code === 'CHAT_FORBIDDEN'
      if (!denied && code !== 'BAD_REQUEST') {
        // Stack locations diagnose implementation failures without logging messages, payloads or credentials.
        const locations = error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /u.test(line)).join('\n') : undefined
        ctx.logger.error(`Karaka browser ${operation} failed${locations === undefined ? '' : `\n${locations}`}`)
      }
      const failure = { ok: false, error: { code: denied ? 'gateway/forbidden' : code === 'BAD_REQUEST' ? 'gateway/bad-request' : 'gateway/internal', message: denied ? 'Chat access is forbidden' : code === 'BAD_REQUEST' ? 'Invalid request' : 'Browser operation failed', details: {} } }
      if (response.headersSent) { await writeJsonEvent(response, failure, signal); response.end() }
      else json(response, denied ? 403 : code === 'BAD_REQUEST' ? 400 : 500, failure)
    } finally {
      if (expiry !== undefined) clearTimeout(expiry)
      request.off('aborted', abort); response.off('close', abort); active.delete(controller)
    }
  } }))

  async function eventChannel(owner: ApplicationOwner, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const queue: unknown[] = []
    let wake = Promise.withResolvers<void>()
    const channel: Channel = { id: randomUUID(), owner, push(event) { queue.push(event); wake.resolve() } }
    channels.set(channel.id, channel)
    const abort = (): void => { wake.resolve() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      openEvents(response)
      channel.push({ type: 'ready', clientId: channel.id, host: { home: homedir() } })
      for (const item of pending.values()) if (sameOwner(item.owner, owner)) { item.recipients.add(channel.id); channel.push(frame(item)) }
      while (!signal.aborted) {
        if (queue.length === 0) { await wake.promise; wake = Promise.withResolvers<void>(); continue }
        await writeJsonEvent(response, queue.shift(), signal)
      }
    } finally {
      channels.delete(channel.id)
      // Pending interactions survive loss of the last connection and replay when its owner reconnects.
      for (const item of pending.values()) item.recipients.delete(channel.id)
      signal.removeEventListener('abort', abort)
    }
  }
}
function frame(item: Pending) { return { type: 'interaction', eventId: item.id, chatId: item.chatId, event: item.event, request: item.request } }
function openEvents(response: ServerResponse) { response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' }) }
