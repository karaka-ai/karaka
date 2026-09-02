import { describe, expect, it } from 'vitest'
import agentBuildConfig from '../tsdown.config.ts'

describe('Agent build config', () => {
  it('skips the host-only package during Client config discovery', () => {
    const configure = agentBuildConfig as (input: {
      env: Record<string, string>
    }) => { entry?: unknown }

    expect(configure({ env: { DSH_BUILD_FACE: 'client' } })).toEqual({ entry: '' })
  })
})
