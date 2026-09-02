import { execFileSync } from 'node:child_process'
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const packageDir = resolve(import.meta.dirname, '..')
const repositoryDir = resolve(packageDir, '../../..')
const libDir = resolve(packageDir, 'lib')
const publicDir = resolve(libDir, 'public')
const publicTypesDir = resolve(libDir, 'public-types')
const require = createRequire(import.meta.url)
const publicEntries = filesUnder(resolve(libDir, 'public-entries'))
  .filter(path => path.endsWith('.ts'))
  .map(path => path.slice(resolve(libDir, 'public-entries').length + 1, -3))
const aliases = [...readFileSync(resolve(packageDir, 'src/plugins.ts'), 'utf8')
  .matchAll(/^  '@karaka\/agent\/([^']+)': plugin\d+,$/gmu)]
  .map(match => match[1])

for (const subpath of publicEntries) {
  for (const extension of ['.js', '.d.ts']) {
    const output = resolve(publicDir, `${subpath}${extension}`)
    if (!filesUnder(libDir).includes(output)) throw new Error(`missing public output ${output}`)
  }
}
for (const alias of aliases) {
  if (!publicEntries.includes(alias)) throw new Error(`Loader alias @karaka/agent/${alias} has no public entry`)
}

for (const path of filesUnder(libDir)) {
  const source = readFileSync(path, 'utf8')
  const isPublicDeclaration = path.endsWith('.d.ts')
    && (path.startsWith(`${publicDir}${process.platform === 'win32' ? '\\' : '/'}`)
      || path.startsWith(`${publicTypesDir}${process.platform === 'win32' ? '\\' : '/'}`))
  if (isPublicDeclaration && source.includes('@deepseek-ai/dsh-')) {
    throw new Error(`${path} exposes a private DSH declaration reference`)
  }
  const isShippedRuntime = path.endsWith('.js')
    && !path.includes(`${join('lib', 'types')}${process.platform === 'win32' ? '\\' : '/'}`)
    && !path.includes(`${join('lib', 'public-entries')}${process.platform === 'win32' ? '\\' : '/'}`)
  if (isShippedRuntime
    && /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@deepseek-ai\/dsh-/u.test(source)) {
    throw new Error(`${path} imports a private DSH runtime package`)
  }
}

const project = mkdtempSync(join(tmpdir(), 'karaka-public-api-'))
try {
  const archiveDir = resolve(project, 'archive')
  const unpackDir = resolve(project, 'unpacked')
  mkdirSync(archiveDir)
  mkdirSync(unpackDir)
  execFileSync('pnpm', ['pack', '--pack-destination', archiveDir], {
    cwd: packageDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const archives = readdirSync(archiveDir).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error(`expected one packed Agent archive, received ${String(archives.length)}`)
  }
  const archive = resolve(archiveDir, archives[0])
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  if (members.some(member => member.includes('/public-entries/') || member.endsWith('.ts') && !member.endsWith('.d.ts'))) {
    throw new Error('packed Agent contains build-only TypeScript sources')
  }
  execFileSync('tar', ['-xzf', archive, '-C', unpackDir])

  const agentLink = resolve(project, 'node_modules/@karaka/agent')
  mkdirSync(dirname(agentLink), { recursive: true })
  renameSync(resolve(unpackDir, 'package'), agentLink)
  linkDependencies(project, JSON.parse(readFileSync(resolve(agentLink, 'package.json'), 'utf8')).dependencies)
  writeFileSync(resolve(project, 'package.json'), '{"private":true,"type":"module"}\n')

  writeFileSync(resolve(project, 'consumer.ts'), `import { defineTool } from '@karaka/agent/tools'
import Storage, { storageBackendServiceKey, type StorageBackend } from '@karaka/agent/storage'
import { defineDomain } from '@karaka/agent/storage-domain'
import type { SessionPersistence } from '@karaka/agent/session-persistence'

declare const backend: StorageBackend
declare const persistence: SessionPersistence
void [defineTool, Storage, storageBackendServiceKey, defineDomain, backend, persistence]
`)
  writeFileSync(resolve(project, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2024',
      types: ['node'],
    },
    include: ['consumer.ts'],
  }, null, 2)}\n`)
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', resolve(project, 'tsconfig.json')], {
    cwd: project,
    stdio: 'inherit',
  })

  const pluginPath = resolve(project, 'plugins/storage-memory.mjs')
  mkdirSync(dirname(pluginPath), { recursive: true })
  writeFileSync(pluginPath, `import { storageBackendServiceKey } from '@karaka/agent/storage'

export const name = 'storage-memory'
export const inject = ['storage']
export function apply(ctx) {
  const records = new Map()
  const backend = {
    kv: { open: async () => ({
      loadAll: async () => ({ tables: { rows: Object.fromEntries(records) }, global: null }),
      putRecord: async (_table, key, value) => { records.set(key, value) },
      deleteRecord: async (_table, key) => { records.delete(key) },
      setGlobal: async () => {},
      close: async () => {},
    }) },
    close: async () => { globalThis.__karakaBackendClosed = true },
  }
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('memory', backend)
    return async () => {
      unregister()
      try {
        ctx.storage.backend.get('memory')
        throw new Error('local storage provider remained registered after disposal')
      } catch (error) {
        if (error instanceof Error && error.message === 'local storage provider remained registered after disposal') throw error
      }
      globalThis.__karakaBackendUnregistered = true
      await backend.close()
    }
  })
  ctx.provide(storageBackendServiceKey('memory'), backend)
}
`)
  writeFileSync(resolve(project, 'run.mjs'), `import { Context } from '@karaka/agent/cordis'
import Storage from '@karaka/agent/storage'
import * as domainPlugin from '@karaka/agent/storage-domain'

const localPlugin = await import('./plugins/storage-memory.mjs')
const ctx = new Context()
const storageFiber = await ctx.plugin(Storage)
const backendFiber = await ctx.plugin(localPlugin)
const domainFiber = await ctx.plugin(domainPlugin, { backend: 'memory' })
const spec = domainPlugin.defineDomain({
    name: 'consumer',
    version: 1,
    tables: { rows: { valueSchema: { parse: value => value } } },
  })
const domain = await ctx.storageDomain.open(spec)
await domain.table('rows').put('record', { value: 1 })
if (domain.table('rows').get('record').value !== 1) throw new Error('local storage provider did not serve storage-domain')
await domainFiber.dispose()
await backendFiber.dispose()
if (globalThis.__karakaBackendClosed !== true) throw new Error('local storage provider did not close on disposal')
if (globalThis.__karakaBackendUnregistered !== true) throw new Error('local storage provider did not unregister on disposal')
await storageFiber.dispose()
`)
  execFileSync(process.execPath, [resolve(project, 'run.mjs')], { cwd: project, stdio: 'inherit' })
} finally {
  rmSync(project, { recursive: true, force: true })
}

console.log(`verify-public-api: ${publicEntries.length} packed public subpaths and local storage provider passed`)

function linkDependencies(projectDir, dependencies) {
  for (const name of Object.keys(dependencies)) {
    const source = resolve(packageDir, 'node_modules', ...name.split('/'))
    const target = resolve(projectDir, 'node_modules', ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, 'junction')
  }
  const nodeTypes = resolve(projectDir, 'node_modules/@types/node')
  mkdirSync(dirname(nodeTypes), { recursive: true })
  symlinkSync(resolve(repositoryDir, 'node_modules/@types/node'), nodeTypes, 'junction')
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}
