/** Application schema admission rejects invalid arguments before invocation authorization. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Tool } from '@modelcontextprotocol/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { prepareApplicationTool } from '../src/tools.ts'

function definition(parameters: ToolDefinition['parameters']) {
  return {
    name: 'mcp__app__read', description: 'Read one item', parameters,
    output: { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] },
    execute: vi.fn(async () => 'received'),
  }
}

it.each([
  { type: 'string' },
  { type: 'object', patternProperties: {} },
])('rejects unsupported application input schemas %j', (parameters) => {
  expect(() => prepareApplicationTool(definition(parameters), { name: 'read', inputSchema: { type: 'object' } })).toThrow()
})

it('removes the schema dialect and rejects invalid input before the wrapped invocation', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const original = definition({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false,
  })
  const prepared = prepareApplicationTool(original, { name: 'read', inputSchema: { type: 'object' } })
  expect(prepared.parameters).not.toHaveProperty('$schema')
  ctx.effect(() => ctx.tools.register(prepared))
  async function invoke(args: unknown) {
    return ctx.tools.execute({
      name: prepared.name, arguments: args, callId: ToolCallId('application-call'), signal: new AbortController().signal,
    })
  }
  for (const args of [null, 'item', [], { id: 'wrong' }, { id: 1, unexpected: true }]) {
    const result = await invoke(args)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  }
  expect(original.execute).not.toHaveBeenCalled()
  expect((await invoke({ id: 1 })).isError).toBe(false)
  expect(original.execute).toHaveBeenCalledOnce()
})

it.each(['required', 'optional'] as const)('retains task-support rejection order for %s descriptors', async (taskSupport) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // SDK2's modern wire codec omits taskSupport; the public factory still accepts it.
  const tool: Tool = {
    name: 'read', execution: { taskSupport },
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: { id: { type: 'integer' } }, required: ['id'],
    },
  }
  const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'accepted' }] }))
  const original = createMcpToolDefinition(ctx, {
    name: 'mcp__app__read', rawName: tool.name, description: 'Read one item',
    inputSchema: tool.inputSchema, taskRequired: taskSupport === 'required', call,
  })
  const prepared = prepareApplicationTool(original, tool)
  expect(prepared.parameters).not.toHaveProperty('$schema')
  ctx.effect(() => ctx.tools.register(prepared))
  const result = await ctx.tools.execute({
    name: prepared.name, arguments: {}, callId: ToolCallId('application-call'), signal: new AbortController().signal,
  })
  expect(result.isError).toBe(true)
  if (taskSupport === 'required') {
    expect(result.error?.message).toContain('requires task-based execution')
    expect(result.error?.info?.code).not.toBe('INVALID_ARGS')
  } else {
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  }
  expect(call).not.toHaveBeenCalled()
})
