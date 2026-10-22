import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { KarakaIdentity, ApplicationId, TenantId, UserId } from '../src/index.ts'
import { fixture, owner } from './helpers.ts'

describe('application authority', () => {
  it('records ownership and refuses each foreign owner component', async () => {
    const { authority, create } = await fixture()
    const session = await create()
    expect(await authority.authorize(session.id, owner)).toEqual(session.header)
    for (const claimed of [
      { ...owner, applicationId: ApplicationId('other') },
      { ...owner, tenantId: TenantId('other') },
      { ...owner, userId: UserId('other') },
    ]) {
      await expect(authority.reserve(session.id, claimed)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(authority.restore(session.id, claimed)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(authority.authorize(session.id, claimed)).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it('starts empty and requires explicit verified restoration without activating Sessions', async () => {
    const { ctx, stored, persistence } = await fixture()
    const root = Session.create(SessionId('cold-root'))
    const child = Session.create(SessionId('cold-child'), [], { ...Session.create(SessionId('cold-child')).header, parentSession: root.id })
    stored.set(root.id, root.header)
    stored.set(child.id, child.header)
    const restarted = new KarakaIdentity(ctx)
    try {
      expect(persistence.list).not.toHaveBeenCalled()
      expect(await restarted.ownerOfId(root.id)).toBeUndefined()
      expect(await restarted.ownerOfId(child.id)).toBeUndefined()
      expect(restarted.ownerOfCached(root)).toBeUndefined()
      await expect(restarted.authorize(root.id, owner)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(restarted.reserve(root.id, owner)).rejects.toMatchObject({ code: 'forbidden' })
      expect(await restarted.restore(root.id, owner)).toEqual(root.header)
      expect(await restarted.reserve(root.id, owner)).toBe('existing')
      expect(await restarted.ownerOfId(child.id)).toEqual(owner)
      expect(restarted.ownerOfCached(child)).toEqual(owner)
      expect(ctx.sessions.get(root.id)).toBeUndefined()
      expect(ctx.sessions.get(child.id)).toBeUndefined()
      expect(persistence.list).not.toHaveBeenCalled()
    } finally { await restarted.close() }
  })

  it('refuses to restore missing, unpublished, or child Sessions without adopting them', async () => {
    const { ctx, authority, stored, create } = await fixture()
    const live = ctx.sessions.create(SessionId('unpublished'))
    await expect(authority.restore(live.id, owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.restore(SessionId('missing'), owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.authorize(SessionId('missing'), owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.authorizeSession(live, owner)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await authority.ownerOfId(SessionId('missing'))).toBeUndefined()
    const parent = await create()
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
    stored.set(child.id, child.header)
    await expect(authority.restore(child.id, owner)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await authority.ownerOf(live)).toBeUndefined()
    expect(await authority.ownerOf(child)).toEqual(owner)
  })

  it('inherits a child owner and refuses missing ancestors or conflicting child reservations', async () => {
    const { ctx, authority, create } = await fixture()
    const orphan = ctx.sessions.create(SessionId('orphan'), { meta: { parentSession: SessionId('missing') } })
    expect(await authority.ownerOf(orphan)).toBeUndefined()
    expect(authority.ownerOfCached(orphan)).toBeUndefined()
    const parent = await create()
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
    expect(await authority.ownerOf(child)).toEqual(owner)
    expect(authority.ownerOfCached(child)).toEqual(owner)
    await authority.markReady(child, owner)
    await expect(authority.authorizeSession(child, { ...owner, userId: UserId('foreign') })).rejects.toMatchObject({ code: 'forbidden' })
    const id = SessionId('foreign-child')
    const foreign = { ...owner, userId: UserId('foreign') }
    await authority.reserve(id, foreign)
    const conflicting = ctx.sessions.create(id, { meta: { parentSession: parent.id } })
    await expect(authority.bind(conflicting, foreign)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('checks both direct child and inherited root ownership when a child was explicitly reserved', async () => {
    const { ctx, authority, create } = await fixture()
    const parent = await create()
    const id = SessionId('reserved-child')
    await authority.reserve(id, owner)
    const child = ctx.sessions.create(id, { meta: { parentSession: parent.id } })
    await authority.bind(child, owner)
    expect(await authority.ownerOf(child)).toEqual(owner)
    expect(authority.ownerOfCached(child)).toEqual(owner)
  })

  it('rejects changed persisted or live source fields before restoring ownership', async () => {
    const { authority, stored, create } = await fixture()
    const root = await create()
    for (const changed of [
      { ...root.header, createdAt: root.header.createdAt + 1 },
      { ...root.header, agentPreset: 'other' },
    ]) {
      stored.set(root.id, changed)
      await expect(authority.restore(root.id, owner)).rejects.toMatchObject({ code: 'unavailable' })
    }
    stored.set(root.id, root.header)
    expect(await authority.restore(root.id, owner)).toEqual(root.header)
    const replaced = Session.create(root.id, [], { ...root.header, createdAt: root.header.createdAt + 1 })
    await expect(authority.ownerOf(replaced)).rejects.toMatchObject({ code: 'unavailable' })
    expect(() => authority.ownerOfCached(replaced)).toThrow('source does not match')
  })

  it('refuses persisted headers that disagree with an unowned live Session', async () => {
    const { ctx, authority, stored } = await fixture()
    const live = ctx.sessions.create(SessionId('different-live'))
    stored.set(live.id, { ...live.header, createdAt: live.header.createdAt + 1 })
    await expect(authority.restore(live.id, owner)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await authority.ownerOfId(live.id)).toBeUndefined()
  })

  it('serializes one chat through failures while allowing another chat to progress', async () => {
    const { authority } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const error = new Error('create failed')
    const order: string[] = []
    const first = authority.withChatLock(SessionId('chat'), async () => {
      order.push('first')
      entered.resolve(undefined)
      await release.promise
      throw error
    })
    const failed = expect(first).rejects.toBe(error)
    await entered.promise
    const second = authority.withChatLock(SessionId('chat'), async () => { order.push('second') })
    try {
      await authority.withChatLock(SessionId('other'), async () => { order.push('other') })
      expect(order).toEqual(['first', 'other'])
    } finally {
      release.resolve(undefined)
      await failed
      await second
    }
    expect(order).toEqual(['first', 'other', 'second'])
  })

  it('keeps reserved materializations fail-closed and allows a failed unpublished creation to retry', async () => {
    const { ctx, authority, stored, create } = await fixture()
    const ready = await create()
    expect(await authority.reserve(ready.id, owner)).toBe('existing')
    await authority.bind(ready, owner)
    await authority.markReady(ready, owner)
    const id = SessionId('reserved')
    expect(await authority.reserve(id, owner)).toBe('create')
    expect(await authority.reserve(id, owner)).toBe('create')
    const session = ctx.sessions.create(id)
    expect(authority.ownerOfCached(session)).toBeUndefined()
    await expect(authority.authorizeSession(session, owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.reserve(id, owner)).rejects.toMatchObject({ code: 'unavailable' })
    stored.set(id, session.header)
    await expect(authority.restore(id, owner)).rejects.toMatchObject({ code: 'unavailable' })
    const attempted = Session.create(SessionId('unmaterialized'))
    await authority.reserve(attempted.id, owner)
    await authority.bind(attempted, owner)
    expect(await authority.reserve(attempted.id, owner)).toBe('create')
    const retry = Session.create(attempted.id, [], { ...attempted.header, createdAt: attempted.header.createdAt + 1 })
    await authority.bind(retry, owner)
    expect(await authority.ownerOf(retry)).toEqual(owner)
  })

  it('refuses missing acknowledged data and binding without a valid reservation or parent', async () => {
    const { ctx, authority, stored } = await fixture()
    const ready = Session.create(SessionId('ready'))
    stored.set(ready.id, ready.header)
    await authority.restore(ready.id, owner)
    stored.delete(ready.id)
    await expect(authority.reserve(ready.id, owner)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(authority.bind(ctx.sessions.create(SessionId('unreserved')), owner)).rejects.toMatchObject({ code: 'forbidden' })
    const missing = SessionId('missing-parent-child')
    await authority.reserve(missing, owner)
    await expect(authority.bind(ctx.sessions.create(missing, { meta: { parentSession: SessionId('absent') } }), owner)).rejects.toMatchObject({ code: 'forbidden' })
    const parent = ctx.sessions.create(SessionId('unowned-parent'))
    const child = SessionId('unowned-parent-child')
    await authority.reserve(child, owner)
    await expect(authority.bind(ctx.sessions.create(child, { meta: { parentSession: parent.id } }), owner)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects cyclic lineage in asynchronous and cached lookups', async () => {
    const { authority, stored } = await fixture()
    const id = SessionId('cyclic')
    const cyclic = Session.create(id, [], { ...Session.create(id).header, parentSession: id })
    stored.set(id, cyclic.header)
    await expect(authority.ownerOf(cyclic)).rejects.toThrow('Cyclic chat lineage')
    expect(() => authority.ownerOfCached(cyclic)).toThrow('Cyclic chat lineage')
  })

  it('does not acknowledge failed flushes, absent data, or mismatched durable headers', async () => {
    const { ctx, authority, stored } = await fixture()
    const id = SessionId('pending')
    await authority.reserve(id, owner)
    const session = ctx.sessions.prepare(id)
    const detach = ctx.sessions.enter(session)
    await authority.bind(session, owner)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
    try {
      await expect(authority.markReady(session, owner)).rejects.toThrow('no durability provider')
      flush.mockResolvedValue(true)
      await expect(authority.markReady(session, owner)).rejects.toThrow('Flushed chat data is unavailable')
      stored.set(id, { ...session.header, createdAt: session.header.createdAt + 1 })
      await expect(authority.markReady(session, owner)).rejects.toThrow('source does not match')
      stored.delete(id)
      detach()
      expect(await authority.reserve(id, owner)).toBe('create')
    } finally { flush.mockRestore(); detach() }
  })

  it('waits for admitted operations during close and refuses subsequent authority calls', async () => {
    const { authority } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const pending = authority.withChatLock(SessionId('pending'), async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    const close = authority.close()
    const settled = vi.fn()
    void close.then(settled)
    try {
      await expect(authority.reserve(SessionId('other'), owner)).rejects.toMatchObject({ code: 'unavailable' })
      expect(() => authority.ownerOfCached(Session.create(SessionId('closed')))).toThrow('authority is closed')
      expect(settled).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await pending
      await close
    }
    expect(settled).toHaveBeenCalledOnce()
    await expect(authority.withChatLock(SessionId('closed'), async () => {})).rejects.toMatchObject({ code: 'unavailable' })
  })
})
