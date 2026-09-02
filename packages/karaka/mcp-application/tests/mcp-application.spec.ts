import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ApplicationId, SessionId, TenantId, UserId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as ApplicationMcp from '@karaka-ai/mcp-application'
import { createKarakaToolHost } from '@karaka-ai/sdk'
import BearerServerAuth from '@karaka-ai/server-auth'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('Karaka MCP application bridge', () => {
  it('authenticates, discovers, validates, and invokes an SDK tool with trusted identity', async () => {
    const callback = vi.fn(() => ({ content: [{ type: 'text' as const, text: 'refunded' }] }))
    const host = createKarakaToolHost({ verifyToken: 'tool-secret' })
    host.registerTool('invoices_refund', {
      description: 'Refund an invoice',
      inputSchema: z.object({ invoiceId: z.string() }).strict(),
    }, callback)
    const handler = host.expressHandler()
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await host.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    ctx.provide('credentials', {
      resolve: (ref: string) => Promise.resolve(ref === 'TOOL_TOKEN'
        ? { value: 'tool-secret', source: 'test' }
        : undefined),
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BearerServerAuth, {
      applications: [{ id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' }],
    })
    const address = server.address() as AddressInfo
    await ctx.plugin(ApplicationMcp, {
      serverName: 'billing',
      url: `http://127.0.0.1:${String(address.port)}`,
      applicationId: 'billing',
      headers: {},
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    })

    const agent = {
      id: SessionId('chat-1'),
      session: {
        id: SessionId('chat-1'),
        header: {
          applicationOwner: {
            applicationId: ApplicationId('billing'),
            tenantId: TenantId('tenant-1'),
            userId: UserId('user-1'),
          },
        },
      },
    }
    let agentScope!: Context
    await ctx.plugin(Object.assign((inner: Context) => {
      agentScope = createScope(inner, agent).ctx
    }, { inject: ['tools'] }))
    expect(ctx.tools.schemas(agent as never)).toEqual([])
    agentScope.tools.restrict({ allow: ['mcp__billing__invoices_refund'] })
    expect(ctx.tools.schemas(agent as never).map(tool => tool.name)).toEqual(['mcp__billing__invoices_refund'])
    const invalid = await ctx.tools.execute({
      signal: AbortSignal.timeout(5_000),
      callId: ToolCallId('invalid'),
      name: 'mcp__billing__invoices_refund',
      arguments: {},
      agent: agent as never,
    })
    expect(invalid.isError).toBe(true)
    expect(callback).not.toHaveBeenCalled()

    const result = await ctx.tools.execute({
      signal: AbortSignal.timeout(5_000),
      callId: ToolCallId('valid'),
      name: 'mcp__billing__invoices_refund',
      arguments: { invoiceId: 'inv-1' },
      agent: agent as never,
    })
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'refunded' }] })
    expect(callback).toHaveBeenCalledWith(
      { invoiceId: 'inv-1' },
      expect.objectContaining({
        applicationId: 'billing', tenantId: 'tenant-1', userId: 'user-1', chatId: 'chat-1',
      }),
    )
  })

  it('rejects an unsupported SDK Zod constraint while connecting to the application endpoint', async () => {
    const host = createKarakaToolHost({ verifyToken: 'tool-secret' })
    host.registerTool('constrained', {
      inputSchema: z.object({ value: z.string().min(2) }).strict(),
    }, () => ({ content: [{ type: 'text', text: 'unused' }] }))
    const handler = host.expressHandler()
    const server = createServer((request, response) => { void handler(request, response) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const ctx = new Context()
    cleanups.push(async () => {
      await ctx.fiber.dispose()
      await host.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    })
    ctx.provide('credentials', {
      resolve: (ref: string) => Promise.resolve(ref === 'TOOL_TOKEN'
        ? { value: 'tool-secret', source: 'test' }
        : undefined),
    } as never)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BearerServerAuth, {
      applications: [{ id: 'billing', chatCredential: 'CHAT_TOKEN', toolCredential: 'TOOL_TOKEN' }],
    })
    const address = server.address() as AddressInfo

    await expect(ctx.plugin(ApplicationMcp, {
      serverName: 'billing',
      url: `http://127.0.0.1:${String(address.port)}`,
      applicationId: 'billing',
      headers: {},
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    })).rejects.toThrow(
      /unsupported JSON schema: schema\.properties\.value\.minLength is not a supported keyword/u,
    )
  })
})
