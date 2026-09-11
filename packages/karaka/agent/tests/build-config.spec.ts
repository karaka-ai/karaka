import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface ConfigModule {
  readonly default: (...args: unknown[]) => unknown
  readonly declarationPath: (specifier: string, resolveRuntime: (request: string) => string) => string
  readonly workspaceTypeRuntimePath: (specifier: string, resolveRuntime: (request: string) => string) => string
  readonly cleanOutputs: (directory: string) => void
}

function isConfigModule(value: unknown): value is ConfigModule {
  return typeof value === 'object'
    && value !== null
    && 'default' in value
    && typeof value.default === 'function'
    && 'declarationPath' in value
    && typeof value.declarationPath === 'function'
    && 'workspaceTypeRuntimePath' in value
    && typeof value.workspaceTypeRuntimePath === 'function'
    && 'cleanOutputs' in value
    && typeof value.cleanOutputs === 'function'
}

describe('Agent build config', () => {
  it('preserves the Client artifact during a Host rebuild', async () => {
    const loaded: unknown = await import(new URL('../tsdown.config.ts', import.meta.url).href)
    if (!isConfigModule(loaded)) throw new Error('Agent tsdown config has no output cleaner')
    const directory = await mkdtemp(join(tmpdir(), 'karaka-build-clean-'))
    try {
      for (const name of ['types', 'public-entries', 'browser-types', 'public']) {
        await mkdir(join(directory, name))
        await writeFile(join(directory, name, 'index.d.ts'), 'export {}\n')
      }
      for (const name of ['browser.js', 'browser.js.map', 'browser.d.ts', 'browser.d.ts.map', 'index.js', 'index.d.ts', 'manifest.json']) {
        await writeFile(join(directory, name), '')
      }
      loaded.cleanOutputs(directory)
      expect((await readdir(directory)).sort()).toEqual([
        'browser-types', 'browser.d.ts', 'browser.d.ts.map', 'browser.js', 'browser.js.map', 'manifest.json', 'public', 'public-entries', 'types',
      ])
      expect(await readdir(join(directory, 'public'))).toEqual([])
      expect(await readdir(join(directory, 'browser-types'))).toEqual(['index.d.ts'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('builds a standalone ESM browser entry during Client config discovery', async () => {
    const configUrl = new URL('../tsdown.config.ts', import.meta.url).href
    const loaded: unknown = await import(configUrl)
    expect(isConfigModule(loaded)).toBe(true)
    if (!isConfigModule(loaded)) throw new Error('Agent tsdown config has no default function export')

    expect(loaded.default({ env: { DSH_BUILD_FACE: 'client' } }, {})).toMatchObject({ entry: { browser: 'src/client/browser.ts' }, platform: 'browser', format: ['esm'] })
  })

  it('locates workspace declarations before their runtime bundles exist', async () => {
    const configUrl = new URL('../tsdown.config.ts', import.meta.url).href
    const loaded: unknown = await import(configUrl)
    expect(isConfigModule(loaded)).toBe(true)
    if (!isConfigModule(loaded)) throw new Error('Agent tsdown config has no declaration locator')

    const declaration = loaded.declarationPath('@deepseek-ai/dsh-agent', () => {
      throw new Error('runtime bundle is absent')
    })
    expect(declaration.replaceAll('\\', '/')).toMatch(/\/packages\/core\/agent\/lib\/types\/index\.d\.ts$/u)

    const runtime = loaded.workspaceTypeRuntimePath('@deepseek-ai/cordis-plugin-hmr', () => {
      throw new Error('runtime bundle is absent')
    })
    expect(runtime.replaceAll('\\', '/')).toMatch(/\/vendor\/hmr\/lib\/types\/index\.js$/u)

    const sdk = loaded.workspaceTypeRuntimePath('@karaka-ai/sdk', () => {
      throw new Error('SDK runtime bundle is absent')
    })
    expect(sdk.replaceAll('\\', '/')).toMatch(/\/packages\/karaka\/sdk\/lib\/types\/index\.js$/u)
  })
})
