import { fstatSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { expect, it, onTestFinished, vi } from 'vitest'
import { lockAuthority } from '../src/lock.ts'

// These tests exercise descriptor ownership around the native call; actual kernel exclusion is tested separately on POSIX.
vi.mock('@deepseek-ai/node-addon-system/flock', () => ({ tryLockExclusive: vi.fn(async (_fd: number) => {}) }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, stat: vi.fn(fs.stat) }
})

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'karaka-lock-orchestration-'))
  onTestFinished(async () => {
    vi.mocked(tryLockExclusive).mockReset().mockResolvedValue(undefined)
    vi.mocked(stat).mockClear()
    await rm(root, { recursive: true, force: true })
  })
  return root
}

it('returns a live descriptor after acquisition and closes it when the caller releases ownership', async () => {
  const root = await directory()
  const handle = await lockAuthority(root)
  const fd = handle.fd
  try {
    expect(tryLockExclusive).toHaveBeenCalledWith(fd)
    expect(fstatSync(fd).isFile()).toBe(true)
  } finally {
    await handle.close()
  }
  expect(() => fstatSync(fd)).toThrow()
})

it('closes the descriptor when the native lock operation rejects', async () => {
  const root = await directory()
  const error = new Error('native acquisition failed')
  vi.mocked(tryLockExclusive).mockRejectedValueOnce(error)
  await expect(lockAuthority(root)).rejects.toBe(error)
  const fd = vi.mocked(tryLockExclusive).mock.calls.at(-1)?.[0]
  if (fd === undefined) throw new Error('native lock was not called')
  expect(() => fstatSync(fd)).toThrow()
})

it('closes the descriptor when path metadata identifies another inode', async () => {
  const root = await directory()
  const replacement = join(root, 'replacement.lock')
  await writeFile(replacement, '')
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(stat).mockResolvedValueOnce(await actual.stat(replacement, { bigint: true }))
  await expect(lockAuthority(root)).rejects.toThrow('lock file was replaced')
  const fd = vi.mocked(tryLockExclusive).mock.calls.at(-1)?.[0]
  if (fd === undefined) throw new Error('native lock was not called')
  expect(() => fstatSync(fd)).toThrow()
})
