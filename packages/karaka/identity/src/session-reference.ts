/** Owner-aware references using the original resolver's public virtual methods. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionReferenceResolver, {
  DEFAULT_CANDIDATE_LIMIT,
  SessionReferenceError,
  type Config,
  type PreparedReferencedMessage,
  type SessionReferenceCandidate,
  type SessionReferenceInput,
} from '@deepseek-ai/dsh-session-reference'
import { IdentityError, sameOwner, type ApplicationOwner } from './owner.ts'
import type {} from './index.ts'

/**
 * Original budgets, projections, mention parsing, spill behavior and remote
 * methods stay inherited. Only application-owner selection is added.
 */
export class KarakaSessionReferenceResolver extends SessionReferenceResolver {
  static override inject = [...SessionReferenceResolver.inject, 'karakaIdentity']
  private readonly karakaCandidateLimit: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config)
    this.karakaCandidateLimit = config.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT
  }

  /**
   * Filter ownership before the final cap while retaining original ranking.
   * @param agent - Target Agent.
   * @param query - Original substring query.
   * @param limit - Positive result cap.
   * @param signal - Caller cancellation.
   * @returns Same-owner application candidates or unowned ordinary candidates.
   */
  override async listCandidates(
    agent: Agent,
    query = '',
    limit = this.karakaCandidateLimit,
    signal?: AbortSignal,
  ): Promise<SessionReferenceCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new SessionReferenceError('candidate limit must be a positive safe integer', 'SESSION_REFERENCE_INVALID_REFERENCE')
    }
    const owner = await this.ctx.karakaIdentity.ownerOf(agent.session)
    // The original resolver already lists and sorts the complete registry.
    // Do not truncate that list before the authorization filter.
    const candidates = await super.listCandidates(agent, query, Number.MAX_SAFE_INTEGER, signal)
    const selected: SessionReferenceCandidate[] = []
    for (const candidate of candidates) {
      assertNotCancelled(signal)
      const targetOwner = await this.ctx.karakaIdentity.ownerOfId(candidate.sessionId)
      if (!canReference(owner, targetOwner)) continue
      selected.push(candidate)
      if (selected.length === limit) break
    }
    assertNotCancelled(signal)
    return selected
  }

  /**
   * Authorize each exact target before the original resolver reads its content.
   * Its inherited pre-step listener dispatches through this override as well.
   * @param agent - Target Agent.
   * @param content - Direct user content.
   * @param references - Requested original Session references.
   * @param signal - Cancellation.
   * @returns The original resolver's durable, budgeted reference context.
   */
  override async prepare(
    agent: Agent,
    content: ContentBlock[],
    references: SessionReferenceInput[],
    signal?: AbortSignal,
  ): Promise<PreparedReferencedMessage> {
    const owner = await this.ctx.karakaIdentity.ownerOf(agent.session)
    for (const reference of references) {
      assertNotCancelled(signal)
      const targetOwner = await this.ctx.karakaIdentity.ownerOfId(reference.sessionId)
      if (!canReference(owner, targetOwner)) throw new IdentityError('forbidden', 'Referenced chat is not owned by this caller')
    }
    assertNotCancelled(signal)
    return super.prepare(agent, content, references, signal)
  }
}

function canReference(owner: ApplicationOwner | undefined, target: ApplicationOwner | undefined): boolean {
  return owner === undefined ? target === undefined : target !== undefined && sameOwner(owner, target)
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionReferenceError('session reference preparation was cancelled', 'SESSION_REFERENCE_CANCELLED', { cause: signal.reason })
  }
}

export default KarakaSessionReferenceResolver
