import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

run(require.resolve('typescript/bin/tsc'), ['-b'])
run(require.resolve('tsdown/run'), ['--env.KARAKA_AGENT_BUILD', 'runtime'])
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
run(resolve(packageDir, 'scripts/verify-public-api.mjs'), [])

function run(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
