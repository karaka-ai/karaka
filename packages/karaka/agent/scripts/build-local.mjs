/** Emit Karaka packages against built upstream packages; no suites or verification hooks. */
import { build } from 'tsdown'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const require = createRequire(import.meta.url)
const declarationsOnly = process.argv.includes('--declarations-only')
const packages = {
  identity: ['index', 'session-reference'],
  'server-auth': ['index'],
  'browser-auth': ['index'],
  'mcp-application': ['index', 'tool-policy'],
  'transport-http': ['index'],
  agent: ['index', 'bin', 'tool-policy'],
}
if (!declarationsOnly) for (const [name, entries] of Object.entries(packages)) {
  const cwd = resolve(root, 'packages/karaka', name)
  await build({
    config: false, tsconfig: false, cwd,
    entry: Object.fromEntries(entries.map(entry => [entry, `src/${entry}.ts`])),
    outDir: 'lib', platform: 'node', format: 'esm', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//, /^@karaka-ai\//] },
  })

}
if (!declarationsOnly) for (const name of ['transport-http', 'agent']) {
  await build({
    config: false, tsconfig: false, cwd: resolve(root, 'packages/karaka', name),
    entry: { browser: 'src/browser.ts' }, outDir: 'lib', platform: 'browser',
    format: 'esm', target: 'es2022', fixedExtension: false, dts: false, clean: false,
    deps: { alwaysBundle: [/./] },
  })
}

// Public declarations are part of the artifact, not a separate verification pass.
const failures = []
for (const name of Object.keys(packages)) {
  const cwd = resolve(root, 'packages/karaka', name)
  const config = resolve(cwd, '.build/tsconfig.json')
  await mkdir(resolve(cwd, '.build'), { recursive: true })
  await writeFile(config, JSON.stringify({
    extends: '../../../../tsconfig.base.json',
    compilerOptions: {
      paths: {}, composite: false, incremental: false,
      rootDir: '../src', outDir: '../lib/types',
      declaration: true, declarationMap: false, emitDeclarationOnly: true,
    },
    include: ['../src/**/*.ts'],
  }, null, 2))
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', config], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) failures.push(name)
}
if (failures.length) throw new Error(`Declaration build failed: ${failures.join(', ')}`)
