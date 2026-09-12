/** Shared gap-free live Session event buffering. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'

/** Live Session events arriving while a durable snapshot is loaded. */
export class SessionEventFollower implements Disposable {
  private readonly buffered = new Deque<SessionEvent>()
  private snapshotCursor: SessionSeqCursor | undefined
  private wake: (() => void) | undefined
  private closed = false
  private readonly disposeEvent: () => void
  private readonly disposeCreated: () => void
  private readonly close = (): void => {
    this.closed = true
    this.notify()
  }
  private readonly onAbort = (): void => { this.notify() }

  constructor(
    ctx: Context,
    target: SessionId,
    private readonly signal: AbortSignal,
    private readonly active: Set<() => void>,
    private readonly gapError: (nextSeq: SessionSeq) => Error,
  ) {
    active.add(this.close)
    this.disposeEvent = ctx.on('session/event', (session, event) => {
      if (session.id !== target) return
      this.buffered.pushBack(event)
      this.notify()
    }, { global: true })
    this.disposeCreated = ctx.on('session/created', (session) => {
      if (session.id !== target) return
      const suffix = session.snapshotEvents(this.snapshotCursor === undefined
        ? session.firstLiveSeq
        : SessionLogOffset(this.snapshotCursor + 1))
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        this.buffered.pushFront(suffix[index] as SessionEvent)
      }
      this.notify()
    }, { global: true })
    signal.addEventListener('abort', this.onAbort, { once: true })
  }

  /**
   * Set the last event included in the opening snapshot.
   * @param cursor - final sequence included by the snapshot.
   */
  snapshotAt(cursor: SessionSeqCursor): void {
    this.snapshotCursor = cursor
  }

  /**
   * Yield each contiguous event after the opening snapshot.
   * @param nextOffset - first unread position after the snapshot.
   * @returns contiguous live Session events until cancellation or disposal.
   */
  async *eventsAfter(nextOffset: SessionLogOffset): AsyncIterable<SessionEvent> {
    while (!this.closed && !this.signal.aborted) {
      const event = this.buffered.popFront()
      if (event === undefined) {
        await new Promise<void>((resolve) => { this.wake = resolve })
        continue
      }
      const nextSeq = SessionSeq(nextOffset)
      if (event.seq < nextSeq) continue
      if (event.seq !== nextSeq) throw this.gapError(nextSeq)
      nextOffset = SessionLogOffset(nextOffset + 1)
      yield event
    }
  }

  [Symbol.dispose](): void {
    this.close()
    this.active.delete(this.close)
    this.signal.removeEventListener('abort', this.onAbort)
    this.disposeCreated()
    this.disposeEvent()
  }

  private notify(): void {
    const resume = this.wake
    this.wake = undefined
    resume?.()
  }
}
