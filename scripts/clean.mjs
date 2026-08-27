import { globSync, rmSync } from 'node:fs'

for (const path of [
  '.artifacts',
  'coverage',
  ...globSync('*.tsbuildinfo'),
  ...globSync('vendor/*/lib'),
  ...globSync('vendor/*/*.tsbuildinfo'),
  ...globSync('packages/*/lib'),
  ...globSync('packages/*/*.tsbuildinfo'),
]) {
  rmSync(path, { recursive: true, force: true })
}
