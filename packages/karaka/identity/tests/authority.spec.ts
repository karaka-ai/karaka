import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { KarakaIdentity, ApplicationId, TenantId, UserId } from '../src/index.ts'
import { bindingOf } from '../src/records.ts'
import { fixture, owner } from './helpers.ts'

describe('application authority', () => {
  it('persists ownership and refuses each foreign owner component', async () => {
    const { authority, domain, create } = await fixture()
    const session = await create()
    expect(domain.table('chats').get(session.id)).toMatchObject({ state: 'ready', owner })
    expect(await authority.authorize(session.id, owner)).toEqual(session.header)
    for (const claimed of [
      { ...owner, applicationId: ApplicationId('other') },
      { ...owner, tenantId: TenantId('other') },
      { ...owner, userId: UserId('other') },
    ]) {
      await expect(authority.reserve(session.id, claimed)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(authority.authorize(session.id, claimed)).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it('refuses to claim an existing unowned Session or expose a missing chat', async () => {
    const { ctx, authority, domain } = await fixture()
    const session = ctx.sessions.create(SessionId('unowned'))
    await expect(authority.reserve(session.id, owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.authorize(SessionId('missing'), owner)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await authority.ownerOf(session)).toBeUndefined()
    expect(domain.table('chats').get(session.id)).toBeUndefined()
  })

  it('inherits a child owner without writing a second authority record', async () => {
    const { ctx, authority, domain, create } = await fixture()
    const parent = await create()
    const child = ctx.sessions.create(SessionId('child'), { meta: { parentSession: parent.id } })
    expect(await authority.ownerOf(child)).toEqual(owner)
    expect(authority.ownerOfCached(child)).toEqual(owner)
    await authority.markReady(child, owner)
    expect(domain.table('chats').get(child.id)).toBeUndefined()
    await expect(authority.authorizeSession(child, { ...owner, userId: UserId('foreign') })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refuses missing ancestors and conflicting child ownership', async () => {
    const { ctx, authority, create } = await fixture()
    const orphan = ctx.sessions.create(SessionId('orphan'), { meta: { parentSession: SessionId('missing') } })
    expect(await authority.ownerOf(orphan)).toBeUndefined()
    const parent = await create()
    const id = SessionId('foreign-child')
    const foreign = { ...owner, userId: UserId('foreign') }
    await authority.reserve(id, foreign)
    const child = ctx.sessions.create(id, { meta: { parentSession: parent.id } })
    await expect(authority.bind(child, foreign)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refuses acknowledged missing data and mismatched source headers during recovery', async () => {
    const { ctx, domain, stored, create } = await fixture()
    const session = await create()
    stored.delete(session.id)
    await expect(new KarakaIdentity(ctx, domain).initialize()).rejects.toMatchObject({ code: 'unavailable' })
    stored.set(session.id, { ...session.header, createdAt: session.header.createdAt + 1 })
    await expect(new KarakaIdentity(ctx, domain).initialize()).rejects.toMatchObject({ code: 'unavailable' })
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

  it('reuses a bound materialized chat and keeps reservation recovery fail-closed', async () => {
    const { ctx, authority, domain, stored, create } = await fixture()
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
    await expect(new KarakaIdentity(ctx, domain).initialize()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('retries an unmaterialized bound attempt but refuses missing acknowledged data', async () => {
    const { ctx, authority, domain } = await fixture()
    const id = SessionId('unmaterialized')
    const header = Session.create(id).header
    await domain.table('chats').put(id, { state: 'bound', owner, binding: bindingOf(header) })
    await new KarakaIdentity(ctx, domain).initialize()
    expect(await authority.reserve(id, owner)).toBe('create')
    expect(domain.table('chats').get(id)?.state).toBe('reserved')
    await new KarakaIdentity(ctx, domain).initialize()
    await domain.table('chats').put(id, { state: 'ready', owner, binding: bindingOf(header) })
    await expect(authority.reserve(id, owner)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects binding without a reservation, an absent parent, or an unowned parent', async () => {
    const { ctx, authority } = await fixture()
    await expect(authority.bind(ctx.sessions.create(SessionId('unreserved')), owner)).rejects.toMatchObject({ code: 'forbidden' })
    const missing = SessionId('missing-parent-child')
    await authority.reserve(missing, owner)
    await expect(authority.bind(ctx.sessions.create(missing, { meta: { parentSession: SessionId('absent') } }), owner)).rejects.toMatchObject({ code: 'forbidden' })
    const parent = ctx.sessions.create(SessionId('unowned-parent'))
    const child = SessionId('unowned-parent-child')
    await authority.reserve(child, owner)
    await expect(authority.bind(ctx.sessions.create(child, { meta: { parentSession: parent.id } }), owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.authorize(parent.id, owner)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(authority.authorizeSession(parent, owner)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('checks cold authority and cached lineage without activating Sessions', async () => {
    const { authority, domain, stored } = await fixture()
    const root = Session.create(SessionId('cold-root'))
    const child = Session.create(SessionId('cold-child'), [], { ...Session.create(SessionId('cold-child')).header, parentSession: root.id })
    await domain.table('chats').put(root.id, { state: 'ready', owner, binding: bindingOf(root.header) })
    stored.set(root.id, root.header)
    stored.set(child.id, child.header)
    expect(await authority.ownerOfId(child.id)).toEqual(owner)
    expect(authority.ownerOfCached(child)).toEqual(owner)
    expect(await authority.ownerOfId(SessionId('absent'))).toBeUndefined()
    expect(authority.ownerOfCached(Session.create(SessionId('ordinary')))).toBeUndefined()
    const orphan = Session.create(SessionId('orphan'), [], { ...child.header, id: SessionId('orphan'), parentSession: SessionId('absent') })
    expect(authority.ownerOfCached(orphan)).toBeUndefined()
  })

  it('rejects cycles and conflicting direct child records from durable authority', async () => {
    const { ctx, authority, domain, stored, create } = await fixture()
    const root = await create()
    const id = SessionId('bound-child')
    await authority.reserve(id, owner)
    const child = ctx.sessions.create(id, { meta: { parentSession: root.id } })
    await authority.bind(child, owner)
    expect(await authority.ownerOf(child)).toEqual(owner)
    expect(authority.ownerOfCached(child)).toEqual(owner)
    await domain.table('chats').put(id, { state: 'bound', owner: { ...owner, userId: UserId('foreign') }, binding: bindingOf(child.header) })
    await expect(authority.ownerOf(child)).rejects.toMatchObject({ code: 'forbidden' })
    expect(() => authority.ownerOfCached(child)).toThrow('not owned')
    const cyclicId = SessionId('cyclic')
    const cyclic = Session.create(cyclicId, [], { ...Session.create(cyclicId).header, parentSession: cyclicId })
    stored.set(cyclic.id, cyclic.header)
    await expect(authority.ownerOf(cyclic)).rejects.toThrow('Cyclic chat lineage')
    expect(() => authority.ownerOfCached(cyclic)).toThrow('Cyclic chat lineage')
  })

  it('does not acknowledge a chat when flushing or durable observation fails', async () => {
    const { ctx, authority, domain } = await fixture()
    const id = SessionId('pending')
    await authority.reserve(id, owner)
    const session = ctx.sessions.create(id)
    await authority.bind(session, owner)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
    try {
      await expect(authority.markReady(session, owner)).rejects.toThrow('no durability provider')
      flush.mockResolvedValue(true)
      await expect(authority.markReady(session, owner)).rejects.toThrow('Flushed chat data is unavailable')
      expect(domain.table('chats').get(id)?.state).toBe('bound')
    } finally {
      flush.mockRestore()
    }
  })

  it('settles admitted operations before closing storage and refuses subsequent authority calls', async () => {
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
      expect(settled).not.toHaveBeenCalled()
    } finally {
      release.resolve(undefined)
      await pending
      await close
    }
    expect(settled).toHaveBeenCalledOnce()
  })

})
