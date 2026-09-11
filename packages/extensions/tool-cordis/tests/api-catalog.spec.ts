import { describe, expect, it } from 'vitest'
import { queryServiceApi } from '../src/api-catalog.ts'

describe('Host Cordis prompt inspection', () => {
  it.each(['sessionController', 'subagents'])('describes uploaded image fields for %s callers', (service) => {
    const result = queryServiceApi(service) as {
      referencedTypes: readonly { name: string; declaration: string }[]
    }
    const prompt = result.referencedTypes.find(type => type.name === 'PromptContentPart')
    expect(prompt?.declaration).toContain("readonly type: 'image'")
    expect(prompt?.declaration).toContain('readonly mediaType: ImageMediaType')
    expect(prompt?.declaration).toContain('readonly data: string')
    expect(prompt?.declaration).not.toContain('readonly attachment:')
  })
})
