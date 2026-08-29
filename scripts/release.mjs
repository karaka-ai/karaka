import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const action = process.argv[2]
if (action !== 'pack' && action !== 'publish') {
  console.error('usage: node scripts/release.mjs <pack|publish>')
  process.exit(2)
}

const root = resolve(import.meta.dirname, '..')
const packages = [
  'cosmokit',
  'schemastery',
  'loader',
  'cordis',
  'include',
  'group',
  'timer',
  'hmr',
  'logger-console',
].map(directory => resolve(root, 'vendor', directory))
packages.push(...['authentication', 'entitlement', 'storage', 'agent-runtime'].map(directory => resolve(root, 'packages', directory)))

if (action === 'pack') {
  const destination = resolve(root, '.artifacts')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  for (const cwd of packages) run(['pack', '--pack-destination', destination], cwd)
  runNode(resolve(root, 'scripts', 'verify-packed.mjs'))
} else {
  for (const cwd of packages) run(['publish', '--access', 'public', '--no-git-checks'], cwd)
}

function run(args, cwd) {
  const result = spawnSync('pnpm', args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function runNode(script) {
  const result = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
