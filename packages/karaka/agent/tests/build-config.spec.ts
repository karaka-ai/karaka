import { describe, expect, it } from 'vitest'

interface ConfigModule {
  readonly default: (...args: unknown[]) => unknown
  readonly declarationPath: (specifier: string, resolveRuntime: (request: string) => string) => string
  readonly workspaceTypeRuntimePath: (specifier: string, resolveRuntime: (request: string) => string) => string
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
}

describe('Agent build config', () => {
  it('skips the host-only package during Client config discovery', async () => {
    const configUrl = new URL('../tsdown.config.ts', import.meta.url).href
    const loaded: unknown = await import(configUrl)
    expect(isConfigModule(loaded)).toBe(true)
    if (!isConfigModule(loaded)) throw new Error('Agent tsdown config has no default function export')

    expect(loaded.default({ env: { DSH_BUILD_FACE: 'client' } }, {})).toEqual({ entry: '' })
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
  })
})
