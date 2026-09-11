import { describe, expect, it } from 'vitest'
import { CordisCatalogProjector } from '../src/cordis-catalog.ts'
import type { SourceDeclarationModel } from '../src/model.ts'

function catalog(definitions: readonly string[]): string {
  const declarations: SourceDeclarationModel[] = definitions.map((text, index) => ({
    face: 'host', package: `@fixture/types-${String(index)}`, name: 'PromptPart', kind: 'alias',
    location: { file: `packages/fixture/types-${String(index)}/src/types.ts`, line: 1, column: 1 },
    text,
  }))
  const projector = new CordisCatalogProjector({
    face: 'host', packages: [], graph: { nodes: [], declarations: [] },
  }, declarations, {
    linkedTypePages: {}, foundationTypeNames: new Set(), typeLinkExemptions: {},
    inheritedEvents: [], inheritedServices: [],
  })
  return projector.renderRuntimeApi({
    events: [],
    services: [{
      key: 'fixture', type: 'Fixture', abstract: false, doc: 'Accepts prompts.', source: 'fixture.ts:1',
      methods: [{ signature: 'send(content: PromptPart[]): void', jsDoc: '/** Accepts prompts. */' }],
    }],
  })
}

describe('Cordis inspect type names', () => {
  it('retains one declaration when packages expose the same complete text', () => {
    const declaration = "export type PromptPart = { readonly type: 'image'; readonly data: string };"
    const output = catalog([declaration, declaration])
    expect(output.match(/name: 'PromptPart'/gu)).toHaveLength(1)
    expect(output).toContain('readonly data: string')
  })

  it('omits a name when any declaration disagrees', () => {
    const text = 'export type PromptPart = string;'
    expect(catalog([text, 'export type PromptPart = number;', text])).not.toContain("name: 'PromptPart'")
  })

  it('compares complete declarations before shortening the displayed text', () => {
    const prefix = `export type PromptPart = { ${'field: string; '.repeat(120)}`
    expect(catalog([`${prefix} tail: string }`, `${prefix} tail: number }`]))
      .not.toContain("name: 'PromptPart'")
    const output = catalog([`${prefix} tail: string }`, `${prefix} tail: string }`])
    expect(output).toContain("name: 'PromptPart'")
    expect(output).toContain('truncated')
  })
})
