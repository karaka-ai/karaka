import { globSync, readFileSync } from 'node:fs'

const files = globSync('**/*', {
  exclude: path => path.startsWith('legacy/') || path.startsWith('.agents/notes/archived/') || path.includes('/lib/') || path.startsWith('node_modules/'),
})
const forbidden = new RegExp([['@deepseek', '-ai'].join(''), ['@karaka/', 'dsh-'].join('')].join('|'))
const failures = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (forbidden.test(text)) failures.push(file)
}

if (failures.length > 0) {
  console.error(`legacy identifiers remain in active files:\n${failures.join('\n')}`)
  process.exit(1)
}
