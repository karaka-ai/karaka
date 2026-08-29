import { Context, type Context as CordisContext } from '@karaka/cordis'
import Storage, { type StorageProvider } from '@karaka/storage'
import StorageLocal from '@karaka/storage/local'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

describe('Storage', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('persists versioned JSON records across provider restarts and rejects stale updates', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'karaka-storage-'))
    directories.push(directory)
    const path = join(directory, 'storage.sqlite')
    const first = await createLocalContext(path)

    try {
      await expect(first.storage.create({
        namespace: 'tests',
        key: 'record',
        value: { answer: 41 },
      })).resolves.toEqual({
        namespace: 'tests',
        key: 'record',
        value: { answer: 41 },
        version: 1,
      })
      await expect(first.storage.update({
        namespace: 'tests',
        key: 'record',
        value: { answer: 42 },
        expectedVersion: 1,
      })).resolves.toMatchObject({ value: { answer: 42 }, version: 2 })
      await expect(first.storage.update({
        namespace: 'tests',
        key: 'record',
        value: { answer: 43 },
        expectedVersion: 1,
      })).rejects.toMatchObject({ code: 'CONFLICT' })
    } finally {
      await first.fiber.dispose()
    }

    const second = await createLocalContext(path)
    try {
      await expect(second.storage.read({ namespace: 'tests', key: 'record' })).resolves.toEqual({
        namespace: 'tests',
        key: 'record',
        value: { answer: 42 },
        version: 2,
      })
    } finally {
      await second.fiber.dispose()
    }
  })

  it.each([
    ['disposal', false],
    ['replacement', true],
  ])('drains an in-flight provider operation during %s', async (_case, replaceProvider) => {
    const ctx = new Context()
    const started = deferred<void>()
    const finish = deferred<void>()

    try {
      await ctx.plugin(Storage)
      const providerPlugin = ctx.plugin(createDelayedProvider(started, finish))
      await providerPlugin

      const read = ctx.storage.read({ namespace: 'tests', key: 'record' })
      await started.promise
      let disposed = false
      const disposal = providerPlugin.dispose().then(() => {
        disposed = true
      })

      await expect.poll(async () => {
        try {
          await ctx.storage.read({ namespace: 'tests', key: 'other' })
          return 'AVAILABLE'
        } catch (error) {
          return (error as { code?: string }).code
        }
      }).toBe('UNAVAILABLE')
      expect(disposed).toBe(false)

      if (replaceProvider) await ctx.plugin(createStaticProvider())
      finish.resolve()
      await expect(read).resolves.toMatchObject({ value: { done: true } })
      await disposal
      expect(disposed).toBe(true)
      if (replaceProvider) {
        await expect(ctx.storage.read({ namespace: 'tests', key: 'new' }))
          .resolves.toMatchObject({ value: { replacement: true } })
      }
    } finally {
      finish.resolve()
      await ctx.fiber.dispose()
    }
  })
})

async function createLocalContext(path: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageLocal, { path })
  return ctx
}

function createDelayedProvider(started: ReturnType<typeof deferred<void>>, finish: ReturnType<typeof deferred<void>>) {
  return {
    name: 'delayed-storage',
    inject: ['storage'],
    apply(ctx: CordisContext) {
      const provider: StorageProvider = {
        name: 'delayed',
        async read(key) {
          started.resolve()
          await finish.promise
          return { ...key, value: { done: true }, version: 1 }
        },
        async create(record) {
          return { ...record, version: 1 }
        },
        async update(record) {
          return { ...record, version: record.expectedVersion + 1 }
        },
      }
      ctx.storage.register(provider)
    },
  }
}

function createStaticProvider() {
  return {
    name: 'replacement-storage',
    inject: ['storage'],
    apply(ctx: CordisContext) {
      ctx.storage.register({
        name: 'replacement',
        async read(key) {
          return { ...key, value: { replacement: true }, version: 1 }
        },
        async create(record) {
          return { ...record, version: 1 }
        },
        async update(record) {
          return { ...record, version: record.expectedVersion + 1 }
        },
      })
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}
