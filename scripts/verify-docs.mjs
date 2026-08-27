import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const failures = []
const english = globSync('{README.md,CONTRIBUTING.md,docs/**/*.md,examples/foundation/README.md,.agents/notes/{implemented,proposed,rejected}/**/*.md}', {
  exclude: path => path.endsWith('.zh.md'),
})

for (const file of english) {
  const chinese = file.replace(/\.md$/, '.zh.md')
  const record = file.replace(/\.md$/, '.i18n.yaml')
  if (!existsSync(chinese)) failures.push(`${file}: missing ${chinese}`)
  if (!existsSync(record)) failures.push(`${file}: missing ${record}`)
  if (existsSync(chinese) && existsSync(record)) {
    const hashes = Object.fromEntries(
      readFileSync(record, 'utf8').split('\n').flatMap((line) => {
        const match = /^([^#][^:]*): ([0-9a-f]{40})$/.exec(line)
        return match ? [[match[1], match[2]]] : []
      }),
    )
    for (const path of [file, chinese]) {
      const content = readFileSync(path)
      const actual = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
      if (hashes[basename(path)] !== actual) failures.push(`${record}: stale hash for ${basename(path)}`)
    }
  }
}

for (const file of globSync('{README*.md,CONTRIBUTING*.md,docs/**/*.md,examples/foundation/README*.md,.agents/notes/{implemented,proposed,rejected}/**/*.md}')) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]+)?\)/g)) {
    const target = match[1]
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue
    if (!existsSync(resolve(dirname(file), target))) failures.push(`${file}: missing link target ${target}`)
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
