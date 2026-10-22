/** Deterministic external model and preset observation for the ownership composition. */
import type { Context } from '@deepseek-ai/cordis'
import type { ApplicationOwner } from '@karaka-ai/identity'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ownershipProbe: { readonly published: { readonly chatId: SessionId; readonly owner: ApplicationOwner | undefined }[] }
  }
}

class DeterministicModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    const text = 'Recorded ownership reply.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Required fixture dependencies. */
export const inject = ['llm']

/**
 * Publish observations and register the external model replacement.
 * @param ctx - Fixture-owning context.
 */
export function apply(ctx: Context): void {
  ctx.provide('ownershipProbe', { published: [] })
  ctx.effect(() => ctx.llm.registerAdapter(['ownership-fixture'], new DeterministicModel()))
}

/** Preset observer dependencies. */
export const presetObserver = {
  inject: ['karakaIdentity', 'ownershipProbe'],
  apply(ctx: Context): void {
    ctx.on('agent/created', ({ agent }) => {
      ctx.ownershipProbe.published.push({ chatId: agent.id, owner: ctx.karakaIdentity.ownerOfCached(agent.session) })
    })
  },
}
