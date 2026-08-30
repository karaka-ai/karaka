import AgentRuntime from '@karaka/agent-runtime'
import EchoModel from '@karaka/agent-runtime/model-echo'
import SessionStorage from '@karaka/agent-runtime/session-storage'
import Authentication from '@karaka/authentication'
import { Context, type Context as CordisContext } from '@karaka/cordis'
import Entitlement from '@karaka/entitlement'
import { createKarakaClient } from '@karaka/sdk'
import Storage from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
import IpcTransport from '@karaka/transport/ipc'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.platform === 'win32')('IPC Transport', () => {
  it('authenticates durable chats and streams over one Unix domain socket', async () => {
    const runtime = await createRuntime({ basePath: '/internal' })
    const userA = createKarakaClient({
      endpoint: unixEndpoint(runtime.socketPath, '/internal'),
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })
    const userB = createKarakaClient({
      endpoint: unixEndpoint(runtime.socketPath, '/internal'),
      authentication,
      user: { tenantId: 'acme', userId: 'user-b' },
    })

    try {
      expect((await stat(runtime.socketPath)).mode & 0o777).toBe(0o600)
      const started = await userA.chat.send({ agentId: 'support', message: 'Hello' })
      expect(started).toMatchObject({
        agentId: 'support',
        model: 'support-model',
        message: { role: 'assistant', content: 'Received: Hello' },
      })

      await expect(userA.chat.send({ chatId: started.chatId, message: 'Again' })).resolves.toMatchObject({
        chatId: started.chatId,
        message: { content: 'Received: Again' },
      })
      await expect(userB.chat.send({ chatId: started.chatId, message: 'Steal it' })).rejects.toMatchObject({
        code: 'CHAT_NOT_FOUND',
        status: 404,
      })

      const events = []
      for await (const event of userA.chat.stream({ agentId: 'support', message: 'Stream' })) events.push(event)
      expect(events).toEqual([
        { type: 'text-delta', delta: 'Received: ' },
        { type: 'text-delta', delta: 'Stream' },
        {
          type: 'completed',
          result: {
            chatId: expect.any(String),
            agentId: 'support',
            model: 'support-model',
            message: { role: 'assistant', content: 'Received: Stream' },
          },
        },
      ])
    } finally {
      await runtime.dispose()
    }

    await expect(stat(runtime.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await runtime.cleanup()
    await expect(userA.chat.send({ agentId: 'support', message: 'Closed' })).rejects.toMatchObject({
      code: 'TRANSPORT_ERROR',
    })
  })

  it('cancels Agent Runtime work when the IPC caller aborts', async () => {
    const generationStarted = Promise.withResolvers<void>()
    const generationAborted = Promise.withResolvers<void>()
    const runtime = await createRuntime({
      async installModel(ctx) {
        await ctx.plugin({
          name: 'cancellable-model',
          inject: ['agentModels'],
          apply(pluginContext) {
            pluginContext.agentModels.register({
              id: 'support-model',
              async generate(request) {
                generationStarted.resolve()
                return new Promise<never>((_resolve, reject) => {
                  request.signal?.addEventListener('abort', () => {
                    generationAborted.resolve()
                    reject(request.signal?.reason)
                  }, { once: true })
                })
              },
            })
          },
        })
      },
    })
    const client = createKarakaClient({
      endpoint: unixEndpoint(runtime.socketPath),
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })

    try {
      const controller = new AbortController()
      const call = client.chat.send({ agentId: 'support', message: 'Wait' }, { signal: controller.signal })
      await generationStarted.promise
      controller.abort()

      await expect(call).rejects.toMatchObject({ code: 'ABORTED' })
      await expect(within(generationAborted.promise)).resolves.toBeUndefined()
    } finally {
      await runtime.dispose()
      await runtime.cleanup()
    }
  })

  it('rejects ambiguous or relative IPC endpoints', () => {
    expect(() => createKarakaClient({
      endpoint: 'unix:relative.sock',
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })).toThrow('absolute socket path')
    expect(() => createKarakaClient({
      endpoint: 'unix:///tmp/karaka.sock?unknown=true',
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })).toThrow('unsupported Karaka IPC endpoint option')
    expect(() => createKarakaClient({
      endpoint: 'unix:///tmp/karaka.sock?basePath=/v1&basePath=/v2',
      authentication,
      user: { tenantId: 'acme', userId: 'user-a' },
    })).toThrow('at most one basePath')
  })
})

interface RuntimeOptions {
  basePath?: string
  installModel?(ctx: CordisContext): Promise<void>
}

async function createRuntime(options: RuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'karaka-ipc-'))
  const socketPath = join(directory, 'karaka.sock')
  const ctx = new Context()

  try {
    await ctx.plugin(Authentication)
    await ctx.plugin({
      name: 'test-server-authentication',
      inject: ['authentication'],
      apply(pluginContext) {
        pluginContext.authentication.register({
          async authenticate(request) {
            if (request.headers.get('authorization') !== 'Bearer application-server') throw new Error('untrusted server')
            return {
              id: 'application-server',
              provider: 'test-server',
              claims: {},
            }
          },
          name: 'test-server',
          request(_target, request, dispatch) {
            return dispatch(request)
          },
        })
      },
    })
    await ctx.plugin(Entitlement)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageLocal, { path: join(directory, 'storage.sqlite') })
    await ctx.plugin(AgentRuntime)
    await ctx.plugin(SessionStorage, {})
    if (options.installModel) await options.installModel(ctx)
    else await ctx.plugin(EchoModel, { id: 'support-model', prefix: 'Received: ' })
    await ctx.plugin(agentPlugin)
    const transportConfig = options.basePath === undefined
      ? { path: socketPath }
      : { path: socketPath, basePath: options.basePath }
    await ctx.plugin(IpcTransport, transportConfig)

    return {
      socketPath,
      async dispose() {
        await ctx.fiber.dispose()
      },
      async cleanup() {
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

const authentication = {
  async request(_target: { audience: string }, request: Request, dispatch: (request: Request) => Promise<Response>) {
    const headers = new Headers(request.headers)
    headers.set('authorization', 'Bearer application-server')
    return dispatch(new Request(request, { headers }))
  },
}

const agentPlugin = {
  name: 'support-agent',
  inject: ['agentRuntime', 'agentModels'],
  apply(ctx: CordisContext) {
    ctx.agentRuntime.registerAgent({
      id: 'support',
      prompt: 'You are a support agent.',
      model: 'support-model',
    }, ctx.agentModels)
  },
}

function unixEndpoint(socketPath: string, basePath?: string): URL {
  const endpoint = new URL('unix:///')
  endpoint.pathname = socketPath
  if (basePath) endpoint.searchParams.set('basePath', basePath)
  return endpoint
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('operation did not finish')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
