import { existsSync, globSync, readFileSync } from 'node:fs'

const expected = new Set([
  '@karaka/cordis',
  '@karaka/cosmokit',
  '@karaka/schemastery',
  '@karaka/cordis-plugin-loader',
  '@karaka/cordis-plugin-include',
  '@karaka/cordis-plugin-group',
  '@karaka/cordis-plugin-timer',
  '@karaka/cordis-plugin-hmr',
  '@karaka/cordis-plugin-logger-console',
])

for (const manifestPath of globSync('vendor/*/package.json')) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!expected.has(manifest.name)) throw new Error(`${manifestPath}: unexpected foundation package ${manifest.name}`)
  expected.delete(manifest.name)
  if (manifest.private === true) throw new Error(`${manifestPath}: publishable packages cannot be private`)
  if (manifest.publishConfig?.access !== 'public') throw new Error(`${manifestPath}: publishConfig.access must be public`)
  if (manifest.engines?.node !== '^22.19.0 || >=24.0.0') throw new Error(`${manifestPath}: Node.js engine range is missing or inconsistent`)
  if (manifest.sideEffects !== false) throw new Error(`${manifestPath}: sideEffects must describe the package as tree-shakeable`)
  if (!existsSync(manifestPath.replace('package.json', 'LICENSE'))) throw new Error(`${manifestPath}: LICENSE is missing`)
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith(['@deepseek', '-ai/'].join(''))) throw new Error(`${manifestPath}: stale dependency ${name}`)
    }
  }
}

if (expected.size > 0) throw new Error(`missing foundation packages: ${[...expected].join(', ')}`)
