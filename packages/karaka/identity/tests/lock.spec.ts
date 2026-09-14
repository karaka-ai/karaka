import { mkdtemp, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { lockAuthority } from '../src/lock.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, stat: vi.fn(fs.stat) }
})

// The authority provider explicitly supports POSIX flock; Windows has no fallback.
it.skipIf(process.platform === 'win32')('allows another writer only after the authority lock closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'karaka-authority-lock-'))
  const handles = new Set<FileHandle>()
  onTestFinished(async () => {
    try { await Promise.all([...handles].map(handle => handle.close())) } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const first = await lockAuthority(root)
  handles.add(first)
  await expect(lockAuthority(root)).rejects.toThrow()
  await first.close()
  handles.delete(first)
  const next = await lockAuthority(root)
  handles.add(next)
  expect((await next.stat()).isFile()).toBe(true)
})


it.skipIf(process.platform === 'win32')('rejects an authority lock whose path was replaced after acquisition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'karaka-authority-replaced-'))
  onTestFinished(async () => {
    vi.mocked(stat).mockClear()
    await rm(root, { recursive: true, force: true })
  })
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(stat).mockImplementationOnce(async (path, options) => {
    await rename(path, join(root, 'held.lock'))
    await writeFile(path, '')
    return original.stat(path, options)
  })
  await expect(lockAuthority(root)).rejects.toThrow('lock file was replaced')
  const replacement = await lockAuthority(root)
  await replacement.close()
})
