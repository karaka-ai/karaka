import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@karaka/cordis'
import Include, { applyEntryPatches } from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karaka-loader-'))
  roots.push(root)
  return root
}

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${path}/`).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(join(path, 'cordis.yml')).href },
  })
  await ctx.loader.await()
  return ctx
}

describe('Include patch semantics', () => {
  it('allows a later patch to configure an entry inserted earlier in the same list', () => {
    const source = [{ id: 'existing', name: './existing.mjs', config: { value: 1 } }]
    const result = applyEntryPatches(source, [
      { insert: [{ id: 'added', name: './added.mjs', config: { value: 1 } }] },
      { id: 'added', name: './added.mjs', config: { value: 2 } },
    ], () => undefined)

    expect(result).toEqual([
      { id: 'existing', name: './existing.mjs', config: { value: 1 } },
      { id: 'added', name: './added.mjs', config: { value: 2 } },
    ])
    expect(source).toEqual([{ id: 'existing', name: './existing.mjs', config: { value: 1 } }])
  })
})

describe('Loader and Include transactions', () => {
  it('keeps the last accepted tree after a candidate plugin fails', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'provider.mjs'), [
      'export function apply(ctx, config) {',
      '  if (config.fail) throw new Error("candidate rejected")',
      '  ctx.provide("selectedValue", config.value)',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'cordis.yml'), '- id: provider\n  name: ./provider.mjs\n  config:\n    value: accepted\n')

    const ctx = await boot(root)
    try {
      expect(ctx.get('selectedValue')).toBe('accepted')
      const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')?.subtree as Include

      writeFileSync(join(root, 'cordis.yml'), '- id: provider\n  name: ./provider.mjs\n  config:\n    fail: true\n')
      await expect(include.refresh()).rejects.toThrow('candidate rejected')
      expect(ctx.get('selectedValue')).toBe('accepted')

      writeFileSync(join(root, 'cordis.yml'), '- id: provider\n  name: ./provider.mjs\n  config:\n    value: recovered\n')
      await include.refresh()
      expect(ctx.get('selectedValue')).toBe('recovered')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('evaluates disabled expressions against the entry context', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'plugin.mjs'), 'export function apply(ctx) { ctx.provide("expressionLoaded", true) }\n')
    writeFileSync(join(root, 'cordis.yml'), [
      '- id: disabled',
      '  name: ./plugin.mjs',
      '  disabled: !!js process.version.length > 0',
      '- id: enabled',
      '  name: ./plugin.mjs',
      '  disabled: !!js process.version.length === 0',
      '',
    ].join('\n'))

    const ctx = await boot(root)
    try {
      const entries = [...ctx.loader.entries()]
      expect(entries.find(entry => entry.options.id === 'disabled')?.disabled).toBe(true)
      expect(entries.find(entry => entry.options.id === 'enabled')?.disabled).toBe(false)
      expect(ctx.get('expressionLoaded')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves expressions after injections are ready and again after replacement', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'provider.mjs'), 'export function apply(ctx, config) { ctx.provide("phase", config) }\n')
    writeFileSync(join(root, 'reader.mjs'), [
      'export const inject = ["phase"]',
      'export function apply(ctx, config) { ctx.provide("resolvedValue", config.value) }',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'cordis.yml'), [
      '- id: reader',
      '  name: ./reader.mjs',
      '  inject: [phase]',
      '  config:',
      '    value: !!js ctx.get("phase").value',
      '- id: provider',
      '  name: ./provider.mjs',
      '  config:',
      '    value: first',
      '',
    ].join('\n'))

    const ctx = await boot(root)
    try {
      expect(ctx.get('resolvedValue')).toBe('first')
      const provider = [...ctx.loader.entries()].find(entry => entry.options.id === 'provider')
      expect(provider).toBeDefined()
      await provider?.update({ disabled: true })
      await provider?.update({ config: { value: 'second' } })
      await provider?.update({ disabled: false })
      await ctx.loader.await()
      expect(ctx.get('resolvedValue')).toBe('second')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes concurrent refreshes and commits the final candidate', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'provider.mjs'), [
      'export async function apply(ctx, config) {',
      '  if (config.delay) await new Promise(resolve => setTimeout(resolve, config.delay))',
      '  ctx.provide("serialValue", config.value)',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'cordis.yml'), '- id: provider\n  name: ./provider.mjs\n  config:\n    value: first\n')

    const ctx = await boot(root)
    try {
      const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')?.subtree as Include
      writeFileSync(join(root, 'cordis.yml'), '- id: provider\n  name: ./provider.mjs\n  config:\n    value: second\n    delay: 30\n')
      const second = include.refresh()
      await new Promise(resolve => setTimeout(resolve, 5))
      writeFileSync(join(root, 'cordis.yml'), '- id: provider\n  name: ./provider.mjs\n  config:\n    value: third\n')
      const third = include.refresh()
      await Promise.all([second, third])
      expect(ctx.get('serialValue')).toBe('third')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drains a pending config write during disposal', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'plugin.mjs'), 'export function apply() {}\n')
    writeFileSync(join(root, 'cordis.yml'), '- id: plugin\n  name: ./plugin.mjs\n')
    const ctx = await boot(root)
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.id === 'plugin')
    await plugin?.fiber?.dispose()
    await ctx.fiber.dispose()
    expect(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'cordis.yml'), 'utf8')))
      .toContain('disabled: true')
  })
})
