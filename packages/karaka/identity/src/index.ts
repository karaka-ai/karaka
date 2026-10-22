/** Process-local application authority over unchanged DSH Session and persistence services. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-persistence'
import { bindingOf, matchesBinding, type IdentityRecord } from './records.ts'
import { IdentityError, sameOwner, type ApplicationOwner } from './owner.ts'

export * from './owner.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    karakaIdentity: KarakaIdentity
  }
}

/** Loader plugin name. */
export const name = 'karaka-identity'
/** Original services used without replacement. */
export const inject = ['sessions', 'sessionPersistence']

/**
 * Authenticated ingress restores root ownership explicitly. Application ingress
 * serializes complete create/admit operations through withChatLock. Read-only
 * owner lookup never adopts a Session or infers ownership from request metadata.
 */
export class KarakaIdentity {
  private readonly chats = new Map<SessionId, IdentityRecord>()
  private readonly chains = new Map<SessionId, Promise<unknown>>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private closed = false

  constructor(private readonly ctx: Context) {}

  /**
   * Serialize one complete controller operation, including original engine calls.
   * @param id - Chat being changed.
   * @param operation - Non-reentrant operation.
   * @returns The operation's result after preceding operations have settled.
   */
  async withChatLock<T>(id: SessionId, operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const previous = this.chains.get(id) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => {}, () => {})
    this.chains.set(id, settled)
    try {
      return await result
    } finally {
      if (this.chains.get(id) === settled) this.chains.delete(id)
    }
  }

  /**
   * Reserve creation or authorize an existing root. Call inside withChatLock.
   * @param id - Caller-selected chat identity.
   * @param owner - Authenticated owner.
   * @returns Whether the controller must create or reuse the original Session.
   */
  async reserve(id: SessionId, owner: ApplicationOwner): Promise<'create' | 'existing'> {
    this.assertOpen()
    const record = this.chats.get(id)
    if (record !== undefined) this.checkOwner(record.owner, owner)
    const header = await this.observe(id)
    if (record === undefined) {
      if (header !== undefined) throw new IdentityError('forbidden', 'Chat is not owned by this caller')
      this.chats.set(id, { state: 'reserved', owner: Object.freeze({ ...owner }) })
      return 'create'
    }
    if (header !== undefined) {
      if (record.state === 'reserved') throw new IdentityError('unavailable', 'Chat has no bound authority')
      this.checkBinding(record, header)
      return 'existing'
    }
    if (record.state === 'ready') throw new IdentityError('unavailable', 'Acknowledged chat data is missing')
    // A failed unpublished attempt did not materialize. Its same owner may
    // retry with the actual new timestamp supplied by the original factory.
    if (record.state === 'bound') this.chats.set(id, { state: 'reserved', owner: record.owner })
    return 'create'
  }

  /**
   * Bind the actual unpublished Session during the original Agent setup callback.
   * @param session - Original factory-created Session.
   * @param owner - Reserved owner.
   * @returns Resolution only after the immutable source binding is recorded in memory.
   */
  async bind(session: Session, owner: ApplicationOwner): Promise<void> {
    this.assertOpen()
    const record = this.requireRecord(session.id)
    this.checkOwner(record.owner, owner)
    if (record.state !== 'reserved') {
      this.checkBinding(record, session.header)
    } else {
      if (session.header.parentSession !== undefined) {
        const parent = await this.observe(session.header.parentSession)
        if (parent === undefined) throw new IdentityError('forbidden', 'Chat parent is unavailable')
        const inherited = await this.resolveOwner(parent)
        if (inherited === undefined) throw new IdentityError('forbidden', 'Chat parent has no application owner')
        this.checkOwner(inherited, owner)
      }
      this.chats.set(session.id, { state: 'bound', owner: record.owner, binding: bindingOf(session.header) })
    }
    this.headers.set(session.id, session.header)
  }

  /**
   * Complete creation only after Session flush and persisted source checks succeed.
   * @param session - Published original Session.
   * @param owner - Authenticated owner.
   * @returns Resolution after the application can acknowledge this chat.
   */
  async markReady(session: Session, owner: ApplicationOwner): Promise<void> {
    await this.authorizeSession(session, owner)
    const record = this.boundRecord(session.id, 'unavailable')
    if (!await this.ctx.sessions.flush(session)) throw new IdentityError('unavailable', 'Chat has no durability provider')
    const stored = await this.ctx.sessionPersistence.stat(session.id)
    if (stored === undefined) throw new IdentityError('unavailable', 'Flushed chat data is unavailable')
    this.checkBinding(record ?? { state: 'bound', owner, binding: bindingOf(session.header) }, stored.header)
    // A runtime-created child inherits authority through its parent; flushing
    // it must not invent another direct owner record.
    if (record !== undefined && record.state !== 'ready') this.chats.set(session.id, { ...record, state: 'ready' })
  }

  /**
   * Restore ownership of a persisted root after ingress verifies application access.
   * Call inside withChatLock, after verifying chat scope, preset, and root access.
   * Missing data, child Sessions, conflicting owners, and changed sources are denied.
   * @param id - Persisted root authorized by the application.
   * @param owner - Owner established by verified application authority.
   * @returns The persisted immutable header, without resuming or repairing data.
   */
  async restore(id: SessionId, owner: ApplicationOwner): Promise<SessionHeader> {
    this.assertOpen()
    const record = this.chats.get(id)
    if (record !== undefined) this.checkOwner(record.owner, owner)
    const stored = await this.ctx.sessionPersistence.stat(id)
    if (stored === undefined) throw new IdentityError('forbidden', 'Chat is unavailable for restoration')
    const header = stored.header
    if (header.parentSession !== undefined) {
      throw new IdentityError('forbidden', 'Only application root chats can restore ownership')
    }
    if (record?.state === 'reserved') throw new IdentityError('unavailable', 'Chat has no bound authority')
    const restored = record ?? { state: 'ready', owner: Object.freeze({ ...owner }), binding: bindingOf(header) }
    this.checkBinding(restored, header)
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) this.checkBinding(restored, live.header)
    this.chats.set(id, { ...restored, state: 'ready' })
    this.headers.set(id, header)
    return header
  }

  /**
   * Authorize using read-only observation before calling original agents.resume.
   * @param id - Requested chat.
   * @param owner - Authenticated owner.
   * @returns Its observed original header; missing and foreign chats are denied.
   */
  async authorize(id: SessionId, owner: ApplicationOwner): Promise<SessionHeader> {
    this.assertOpen()
    const header = await this.observe(id)
    if (header === undefined) throw new IdentityError('forbidden', 'Chat is not owned by this caller')
    const actual = await this.resolveOwner(header)
    if (actual === undefined) throw new IdentityError('forbidden', 'Chat is not owned by this caller')
    this.checkOwner(actual, owner)
    return header
  }

  /**
   * Check the exact live or unpublished restored Session before an operation.
   * @param session - Original Session.
   * @param owner - Authenticated owner.
   * @returns Resolution after immutable binding and lineage checks.
   */
  async authorizeSession(session: Session, owner: ApplicationOwner): Promise<void> {
    const actual = await this.ownerOf(session)
    if (actual === undefined) throw new IdentityError('forbidden', 'Chat is not owned by this caller')
    this.checkOwner(actual, owner)
  }

  /**
   * Resolve trusted identity for tool execution, including background child Agents.
   * @param session - Executing original Session, never request-supplied metadata.
   * @returns Its root authority owner, or undefined until root ownership is established.
   */
  async ownerOf(session: Session): Promise<ApplicationOwner | undefined> {
    this.assertOpen()
    return this.resolveOwner(session.header)
  }

  /**
   * Observe a cold or live Session's owner without activating or repairing it.
   * @param id - Original Session identity selected by an authorized consumer.
   * @returns Its application owner, or undefined for missing/unowned Sessions.
   */
  async ownerOfId(id: SessionId): Promise<ApplicationOwner | undefined> {
    this.assertOpen()
    const header = await this.observe(id)
    return header === undefined ? undefined : this.resolveOwner(header)
  }

  /**
   * Synchronous catalog lookup from validated authority and runtime/persisted lineage.
   * Execution must still call ownerOf; an unresolved catalog grants no tools.
   * @param session - Original Session being composed or published.
   * @returns Known owner, or undefined when lineage has not been observed.
   */
  ownerOfCached(session: Session): ApplicationOwner | undefined {
    this.assertOpen()
    const seen = new Set<SessionId>()
    let owner: ApplicationOwner | undefined
    let header: SessionHeader | undefined = session.header
    while (header !== undefined) {
      if (seen.has(header.id)) throw new IdentityError('forbidden', 'Cyclic chat lineage')
      seen.add(header.id)
      const record = this.chats.get(header.id)
      if (record !== undefined) {
        if (record.state === 'reserved') return undefined
        this.checkBinding(record, header)
        if (owner !== undefined) this.checkOwner(owner, record.owner)
        owner = record.owner
      }
      const parent: SessionId | undefined = header.parentSession
      if (parent === undefined) return owner === undefined ? undefined : Object.freeze({ ...owner })
      header = this.ctx.sessions.get(parent)?.header ?? this.headers.get(parent)
    }
    return undefined
  }

  /**
   * Reject new authority calls, await admitted operations, and clear identity caches.
   * @returns Resolution after admitted operations settle and identity caches are cleared.
   */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.chains.values()])
    this.chats.clear()
    this.headers.clear()
  }

  private async resolveOwner(initial: SessionHeader): Promise<ApplicationOwner | undefined> {
    const seen = new Set<SessionId>()
    let owner: ApplicationOwner | undefined
    let header: SessionHeader | undefined = initial
    while (header !== undefined) {
      if (seen.has(header.id)) throw new IdentityError('forbidden', 'Cyclic chat lineage')
      seen.add(header.id)
      this.headers.set(header.id, header)
      const record = this.boundRecord(header.id, 'forbidden')
      if (record !== undefined) {
        this.checkBinding(record, header)
        if (owner !== undefined) this.checkOwner(owner, record.owner)
        owner = record.owner
      }
      if (header.parentSession === undefined) return owner === undefined ? undefined : Object.freeze({ ...owner })
      header = await this.observe(header.parentSession)
    }
    return undefined
  }

  private async observe(id: SessionId): Promise<SessionHeader | undefined> {
    const header = this.ctx.sessions.get(id)?.header ?? (await this.ctx.sessionPersistence.stat(id))?.header
    if (header !== undefined) this.headers.set(id, header)
    else this.headers.delete(id)
    return header
  }

  private boundRecord(id: SessionId, errorCode: IdentityError['code']): Exclude<IdentityRecord, { state: 'reserved' }> | undefined {
    const record = this.chats.get(id)
    if (record?.state === 'reserved') throw new IdentityError(errorCode, 'Chat has no bound authority')
    return record
  }

  private requireRecord(id: SessionId): IdentityRecord {
    const record = this.chats.get(id)
    if (record === undefined) throw new IdentityError('forbidden', 'Chat has no application authority')
    return record
  }

  private checkBinding(record: Exclude<IdentityRecord, { state: 'reserved' }>, header: SessionHeader): void {
    if (!matchesBinding(record, header)) throw new IdentityError('unavailable', 'Chat source does not match its authority')
  }

  private checkOwner(actual: ApplicationOwner, claimed: ApplicationOwner): void {
    if (!sameOwner(actual, claimed)) throw new IdentityError('forbidden', 'Chat is not owned by this caller')
  }

  private assertOpen(): void {
    if (this.closed) throw new IdentityError('unavailable', 'Karaka authority is closed')
  }
}

/**
 * Mount application authority without local files or startup Session enumeration.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const identity = new KarakaIdentity(ctx)
    ctx.provide('karakaIdentity', identity)
    return () => identity.close()
  })
}
