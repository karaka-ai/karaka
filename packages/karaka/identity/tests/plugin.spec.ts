import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply, inject } from '../src/index.ts'
import { bindingOf } from '../src/records.ts'
import { fixture, owner } from './helpers.ts'

// Kernel exclusion is covered by POSIX lock tests; Windows exercises plugin cleanup with native acquisition stubbed.
vi.mock('@deepseek-ai/node-addon-system/flock', async (original) => {
  const native = await original<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return { ...native, tryLockExclusive: process.platform === 'win32' ? vi.fn(async () => {}) : native.tryLockExclusive }
})

it('requires an absolute authority directory', async () => {
  const { ctx } = await fixture(false)
  await expect(apply(ctx, { root: 'relative' })).rejects.toThrow('must be an absolute path')
})

it('mounts and releases its durable authority and exclusive writer lock', async () => {
  const { ctx, root } = await fixture(false)
  const directory = join(root, 'mounted')
  const first = await ctx.plugin({ inject, apply }, { root: directory })
  const identity = first.ctx.karakaIdentity
  await identity.reserve(SessionId('chat'), owner)
  await first.dispose()
  await expect(identity.reserve(SessionId('closed'), owner)).rejects.toThrow('authority is closed')
  const next = await ctx.plugin({ inject, apply }, { root: directory })
  await expect(next.ctx.karakaIdentity.reserve(SessionId('chat'), owner)).resolves.toBe('create')
  await next.dispose()
})

it('releases startup resources after malformed records or missing acknowledged data', async () => {
  const { ctx, root } = await fixture(false)
  const directory = join(root, 'failed')
  await mkdir(directory)
  const file = join(directory, 'karaka_identity.json')
  await writeFile(file, 'invalid json')
  await expect(apply(ctx, { root: directory })).rejects.toThrow()
  const id = SessionId('lost')
  const binding = bindingOf(Session.create(id).header)
  await writeFile(file, JSON.stringify({ unit: { name: 'karaka_identity', version: 1 }, global: null, tables: { chats: { [id]: { state: 'ready', owner, binding } } } }))
  await expect(apply(ctx, { root: directory })).rejects.toThrow('Acknowledged Karaka chat data is missing')
  await writeFile(file, JSON.stringify({ unit: { name: 'karaka_identity', version: 1 }, global: null, tables: { chats: {} } }))
  await apply(ctx, { root: directory })
  await expect(ctx.karakaIdentity.reserve(SessionId('retry'), owner)).resolves.toBe('create')
})
