import { describe, expect, it } from 'vitest'
import { runtime } from '../src/index.ts'

describe('Karaka Agent runtime', () => {
  it('publishes the package runtime marker', () => {
    expect(runtime).toBe('karaka-agent')
  })
})
