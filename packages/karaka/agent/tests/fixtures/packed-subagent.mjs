import assert from 'node:assert/strict'
import { LlmAdapter, ToolCallId } from '@karaka-ai/agent/llm'
import { SessionId } from '@karaka-ai/agent/session'
import { apply as installControlTools } from '@karaka-ai/agent/tool-subagent-control'

/** Exercise independently emitted tools against the packed deployment runtime. */
export async function verifyPackedSubagent(ctx) {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const disposed = Promise.withResolvers()
  let requests = 0
  class Adapter extends LlmAdapter {
    async * stream(options) {
      if (++requests === 1) {
        entered.resolve()
        await release.promise
      }
      options.signal?.throwIfAborted()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['packed-test'], new Adapter())
  const host = await ctx.agents.create({
    sessionId: SessionId('packed-parent'),
    agentOptions: { provider: 'packed-test', model: 'packed-test' },
  })
  const offPark = ctx.on('agent/pre-step', ({ agent }, next) => {
    return agent === host.agent ? { kind: 'reject' } : next()
  })
  // This definition comes from the public entry; the manager comes from the
  // launched bundle. Its initial guidance depends on their shared marker.
  let publicControl
  const offCreated = ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.parentSession !== host.agent.id) return
    agent.ctx.inject(['tools', 'subagents'], (scopedCtx) => {
      installControlTools(scopedCtx)
      publicControl = scopedCtx.tools.get('send_message', agent)
    })
  })
  const delivered = []
  const offInbox = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === host.agent && message.source.kind === 'agent-message') delivered.push(message)
  })
  let childId
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (agent.id === childId) disposed.resolve()
  })
  try {
    assert.equal(typeof ctx.subagents.sendMessage, 'function')
    for (const obsolete of ['followup', 'reportFrom', 'registerContinuableSetup']) {
      assert.equal(obsolete in ctx.subagents, false, obsolete)
    }
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn', label: 'packed child',
      request: { parent: host.agent, prompt: [{ type: 'text', text: 'packed task' }] },
      signal: new AbortController().signal,
    })
    childId = started.childId
    await entered.promise
    const child = ctx.agents.get(childId)
    assert.ok(child)
    assert.ok(publicControl)
    assert.equal(ctx.tools.get('send_message', child), publicControl)
    const initial = child.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === 'packed task'))
    assert.ok(initial.data.content.some(block => block.type === 'text'
      && block.text.includes('Your parent agent id is "packed-parent"')))
    const signal = new AbortController().signal
    const queued = await ctx.subagents.prompt({
      parentSessionId: host.agent.id, childSessionId: childId, mode: 'continuable',
      requestId: 'packed-human', content: [{ type: 'text', text: 'human task' }], clientTimeZone: 'UTC',
    }, signal)
    const sent = await ctx.tools.execute({
      signal, agent: child, callId: ToolCallId('packed-return'), name: 'send_message',
      arguments: { agent_id: host.agent.id, message: 'packed finding' },
    })
    assert.equal(sent.isError, false)
    assert.deepEqual(child.inbox.nextTurn.map(message => message.id), [queued.messageId])
    assert.equal(child.inbox.nextStep.length, 0)
    assert.equal(delivered.length, 1)
    assert.deepEqual(delivered[0].source, { kind: 'agent-message', form: 'relay', senderSessionId: childId })
    assert.deepEqual(delivered[0].content, [
      { type: 'text', text: 'Agent ' + childId + ' sent a message: ' },
      { type: 'text', text: 'packed finding' },
    ])
    release.resolve()
    await disposed.promise
    const stored = await ctx.sessionPersistence.open(childId, 'read')
    try {
      const events = await stored.read()
      const human = events.find(event => event.type === 'user/message' && event.data.source.rpcId === 'packed-human')
      assert.deepEqual(human.data.source, { kind: 'user', rpcId: 'packed-human', clientTimeZone: 'UTC' })
    } finally {
      await stored.close()
    }
    assert.equal(requests, 2)
  } finally {
    release.resolve()
    offInbox()
    offCreated()
    offDisposed()
    offPark()
    await host.dispose()
  }
}
