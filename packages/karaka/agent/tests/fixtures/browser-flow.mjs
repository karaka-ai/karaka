import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@karaka-ai/agent/llm'
import { defineTool } from '@karaka-ai/agent/tools'

export const inject = ['llm', 'tools', 'approval', 'userQuestions', 'webServer', 'connection', 'sessionController', 'typertGateway']

class FixtureModel extends LlmAdapter {
  calls = new Map()
  async *stream(options) {
    options.signal?.throwIfAborted()
    const count = this.calls.get(options.sessionId) ?? 0
    this.calls.set(options.sessionId, count + 1)
    if (count === 0) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'approve-call', name: 'confirm_action', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'approve-call', name: 'confirm_action', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ACTION_FINISHED' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ACTION_FINISHED' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

export function apply(ctx, config) {
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new FixtureModel()))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'confirm_action', description: 'Ask for approval before completing the action.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      const owner = exec.agent.session.header.applicationOwner
      const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'confirm_action', callId: exec.callId, reason: `Approve ${owner.userId}`, signal: exec.signal })
      if (outcome !== 'allowed-once') return `${owner.userId}:${outcome}`
      const answer = await ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'confirm', question: `Confirm ${owner.userId}` }] })
      return `${owner.userId}:${outcome}:${answer.answers[0].custom}`
    },
  })))
  writeFileSync(config.readyFile, String(ctx.webServer.port), { flag: 'wx' })
}
