import { globSync, rmSync } from 'node:fs'

for (const path of [
  '.artifacts',
  'coverage',
  ...globSync('*.tsbuildinfo'),
  ...globSync('vendor/*/lib'),
  ...globSync('vendor/*/*.tsbuildinfo'),
]) {
  rmSync(path, { recursive: true, force: true })
}
