import { createHash } from 'node:crypto'
import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const english = globSync('{README.md,CONTRIBUTING.md,docs/**/*.md,examples/foundation/README.md,packages/*/README.md,.agents/notes/{implemented,proposed,rejected}/**/*.md}', {
  exclude: path => path.endsWith('.zh.md'),
})

for (const file of english) {
  const chinese = file.replace(/\.md$/, '.zh.md')
  const record = file.replace(/\.md$/, '.i18n.yaml')
  const lines = [
    '# Bilingual-pair consistency record. Both files are authoritative.',
    `${basename(file)}: ${blobHash(readFileSync(file))}`,
    `${basename(chinese)}: ${blobHash(readFileSync(chinese))}`,
    '',
  ]
  writeFileSync(record, lines.join('\n'))
}

function blobHash(content) {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}
