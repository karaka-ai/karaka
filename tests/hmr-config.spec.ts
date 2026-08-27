import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@karaka/cordis'
import Hmr from '@karaka/cordis-plugin-hmr'
import Loader, { type ModuleLoaderV2 } from '@karaka/cordis-plugin-loader'
import Timer from '@karaka/cordis-plugin-timer'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function eventually(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for watched config refresh')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('exact config watching', () => {
  it('watches a path under missing parents and drains the last refresh on disposal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'karaka-hmr-'))
    roots.push(root)
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    await ctx.plugin(Loader)
    ctx.loader.internal = {
      version: 'v2',
      loadCache: new Map(),
    } as unknown as ModuleLoaderV2
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { base: root, root: [], ignored: [], debounce: 5 })

    const filename = join(root, 'missing', 'nested', 'config.yml')
    let refreshes = 0
    let release: (() => void) | undefined
    const dispose = await ctx.hmr.registerConfig(filename, async () => {
      refreshes++
      if (refreshes === 2) await new Promise<void>(resolve => { release = resolve })
    })

    mkdirSync(join(root, 'missing', 'nested'), { recursive: true })
    writeFileSync(filename, 'first\n')
    await eventually(() => refreshes >= 1)
    writeFileSync(filename, 'second\n')
    await eventually(() => refreshes >= 2)

    let settled = false
    const disposing = dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await disposing
    expect(refreshes).toBe(2)

    await ctx.fiber.dispose()
  })

  it('does not refresh an existing Include during the main watcher scan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'karaka-hmr-scan-'))
    roots.push(root)
    writeFileSync(join(root, 'plugin.mjs'), 'export function apply() {}\n')
    writeFileSync(join(root, 'cordis.yml'), '- id: plugin\n  name: ./plugin.mjs\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    await ctx.plugin(Loader)
    const Include = (await import('@karaka/cordis-plugin-include')).default
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
    await ctx.loader.await()
    const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')?.subtree as unknown as { refresh(): Promise<void> }
    let refreshes = 0
    include.refresh = async () => { refreshes++ }

    ctx.loader.internal = { version: 'v2', loadCache: new Map() } as unknown as ModuleLoaderV2
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { base: root, root: ['.'], ignored: [], debounce: 5 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(refreshes).toBe(0)
    await ctx.fiber.dispose()
  })
})
