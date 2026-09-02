import { describe, expect, it } from 'vitest'

interface ConfigModule {
  readonly default: (...args: unknown[]) => unknown
}

function isConfigModule(value: unknown): value is ConfigModule {
  return typeof value === 'object'
    && value !== null
    && 'default' in value
    && typeof value.default === 'function'
}

describe('Agent build config', () => {
  it('skips the host-only package during Client config discovery', async () => {
    const configUrl = new URL('../tsdown.config.ts', import.meta.url).href
    const loaded: unknown = await import(configUrl)
    expect(isConfigModule(loaded)).toBe(true)
    if (!isConfigModule(loaded)) throw new Error('Agent tsdown config has no default function export')

    expect(loaded.default({ env: { DSH_BUILD_FACE: 'client' } }, {})).toEqual({ entry: '' })
  })
})
