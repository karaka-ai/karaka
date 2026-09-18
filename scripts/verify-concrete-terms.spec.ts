import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findConcreteTermViolations, readTrackedSource } from './verify-concrete-terms.ts'

const blockedTerm = 'prove' + 'nance'

describe('concrete terminology policy', () => {
  it('rejects case variants in paths, prose, and identifiers', () => {
    expect(findConcreteTermViolations(`docs/${blockedTerm}-notes.md`, [
      'origin metadata',
      blockedTerm.toUpperCase(),
      `Assistant${blockedTerm[0]?.toUpperCase()}${blockedTerm.slice(1)}`,
    ].join('\n'))).toEqual([
      { file: `docs/${blockedTerm}-notes.md`, line: null },
      { file: `docs/${blockedTerm}-notes.md`, line: 2 },
      { file: `docs/${blockedTerm}-notes.md`, line: 3 },
    ])
  })

  it('scans text that contains an embedded NUL', () => {
    expect(findConcreteTermViolations('packages/example/src/source.ts', `scope\0${blockedTerm}`))
      .toEqual([{ file: 'packages/example/src/source.ts', line: 1 }])
  })

  it('normalizes compatibility characters before scanning', () => {
    const fullwidthTerm = blockedTerm.split('')
      .map(character => String.fromCodePoint(character.charCodeAt(0) + 0xfee0))
      .join('')
    expect(findConcreteTermViolations('packages/example/src/source.ts', fullwidthTerm))
      .toEqual([{ file: 'packages/example/src/source.ts', line: 1 }])
  })

  it.skipIf(process.platform === 'win32')('reads the target of a dangling tracked symlink', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'dsh-concrete-terms-'))
    try {
      symlinkSync(`../${blockedTerm}-target`, join(repoRoot, 'tracked-link'))
      expect(findConcreteTermViolations(
        'tracked-link',
        readTrackedSource(repoRoot, 'tracked-link') ?? '',
      )).toEqual([{ file: 'tracked-link', line: 1 }])
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('accepts exact replacement terms', () => {
    expect(findConcreteTermViolations(
      'packages/example/src/origin.ts',
      'provider metadata; source-event references; artifact identity; browser-zone evidence',
    )).toEqual([])
  })

  it('excludes vendored sources and frozen Agent Notes', () => {
    expect(findConcreteTermViolations(`vendor/example/${blockedTerm}.ts`, blockedTerm)).toEqual([])
    expect(findConcreteTermViolations(
      `.agents/notes/archived/process/${blockedTerm}.md`,
      blockedTerm,
    )).toEqual([])
    expect(findConcreteTermViolations(
      '.agents/notes/implemented/process/current.md',
      blockedTerm,
    )).toEqual([{ file: '.agents/notes/implemented/process/current.md', line: 1 }])
  })

  it('preserves historical identifiers only in alpha and RC release schema snapshots', () => {
    for (const channel of ['alpha', 'rc']) {
      expect(findConcreteTermViolations(
        `docs/persistence-changes/releases/dsh-v0.1.2-${channel}.1.schema.json`,
        `{"names":["Historical${blockedTerm}"]}`,
      )).toEqual([])
    }
    for (const file of [
      'docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.md',
      'docs/persistence-changes/releases/dsh-v0.1.2-alpha.1.zh.md',
      'docs/persistence-changes/releases/README.md',
      'docs/persistence-changes/releases/manifest.json',
      'docs/persistence-changes/releases/other.schema.json',
      'docs/persistence-changes/2026-09-11-initial.schema.json',
      'docs/persistence-schema.json',
      'packages/example/src/types.ts',
    ]) {
      expect(findConcreteTermViolations(file, blockedTerm)).toEqual([{ file, line: 1 }])
    }
  })
})
