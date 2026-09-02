import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const packageDir = resolve(import.meta.dirname, '..')
const repositoryDir = resolve(packageDir, '../../..')
const libDir = resolve(packageDir, 'lib')
const publicDir = resolve(libDir, 'public')
const publicTypesDir = resolve(libDir, 'public-types')
const publicEntriesDir = resolve(libDir, 'public-entries')
const require = createRequire(import.meta.url)
const publicEntries = filesUnder(publicEntriesDir)
  .filter(path => path.endsWith('.ts'))
  .map(path => portableSubpath(relative(publicEntriesDir, path)).slice(0, -3))
const aliases = [...readFileSync(resolve(packageDir, 'src/plugins.ts'), 'utf8')
  .matchAll(/^  '@karaka-ai\/agent\/([^']+)': plugin\d+,$/gmu)]
  .map(match => match[1])

for (const subpath of publicEntries) {
  for (const extension of ['.js', '.d.ts']) {
    const output = resolve(publicDir, `${subpath}${extension}`)
    if (!filesUnder(libDir).includes(output)) throw new Error(`missing public output ${output}`)
  }
}
for (const alias of aliases) {
  if (!publicEntries.includes(alias)) throw new Error(`Loader alias @karaka-ai/agent/${alias} has no public entry`)
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

  const agentLink = resolve(project, 'node_modules/@karaka-ai/agent')
  mkdirSync(dirname(agentLink), { recursive: true })
  renameSync(resolve(unpackDir, 'package'), agentLink)
  linkDependencies(project, JSON.parse(readFileSync(resolve(agentLink, 'package.json'), 'utf8')).dependencies)
  writeFileSync(resolve(project, 'package.json'), '{"private":true,"type":"module"}\n')

  verifyTypes(project, 'consumer.ts', `import { defineTool } from '@karaka-ai/agent/tools'
import Storage, { storageBackendServiceKey, type StorageBackend } from '@karaka-ai/agent/storage'
import { defineDomain } from '@karaka-ai/agent/storage-domain'
import type { SessionPersistence } from '@karaka-ai/agent/session-persistence'

declare const backend: StorageBackend
declare const persistence: SessionPersistence
void [defineTool, Storage, storageBackendServiceKey, defineDomain, backend, persistence]
`)
  verifyTypes(project, 'session-projection-consumer.ts', `import type {
  SessionProjectionMap,
  SessionProjectionStateMap,
} from '@karaka-ai/agent/session-projection'
import '@karaka-ai/agent/subagent'

type Assert<T extends true> = T
type ClientProjectionsHaveHostState = Assert<
  keyof SessionProjectionMap extends keyof SessionProjectionStateMap ? true : false
>
declare const proof: ClientProjectionsHaveHostState
void proof
`)
  verifyTypes(project, 'deepseek-extension-consumer.ts', `import type { DeepSeekLlmApiExtensionMap } from '@karaka-ai/agent/deepseek-llm-api-extensions'
import '@karaka-ai/agent/plugin-package-inventory-deepseek'
import '@karaka-ai/agent/session-log-deepseek'

declare const packages: DeepSeekLlmApiExtensionMap['dsh_plugin_packages']
declare const sessionLog: DeepSeekLlmApiExtensionMap['dsh_session_log']
void [packages, sessionLog]
`)

  const pluginPath = resolve(project, 'plugins/storage-memory.mjs')
  mkdirSync(dirname(pluginPath), { recursive: true })
  writeFileSync(pluginPath, `import { storageBackendServiceKey } from '@karaka-ai/agent/storage'
import { writeFileSync } from 'node:fs'

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
  if (process.env.KARAKA_PLUGIN_READY) {
    ctx.inject(['webServer'], () => {
      writeFileSync(process.env.KARAKA_PLUGIN_READY, 'ready')
    })
  }
}
`)
  writeFileSync(resolve(project, 'run.mjs'), `import { Context } from '@karaka-ai/agent/cordis'
import Storage from '@karaka-ai/agent/storage'
import * as domainPlugin from '@karaka-ai/agent/storage-domain'

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

  const readyPath = resolve(project, 'plugin-ready')
  const configPath = resolve(project, 'karaka.cordis.yml')
  writeFileSync(configPath, `- id: storage-domain
  config:
    backend: memory

- insert:
    - id: customer-storage
      name: ./plugins/storage-memory.mjs
`)
  mkdirSync(resolve(project, 'agents/support'), { recursive: true })
  writeFileSync(resolve(project, 'agents/support/preset.yml'), 'name: Support\n')
  writeFileSync(resolve(project, 'agents/support/agent.cordis.yml'), '[]\n')
  await verifyKarakaPatch(project, agentLink, configPath, readyPath)
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

function verifyTypes(projectDir, filename, source) {
  writeFileSync(resolve(projectDir, filename), source)
  const config = resolve(projectDir, 'tsconfig.json')
  writeFileSync(config, `${JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2024',
      types: ['node'],
    },
    files: [filename],
  }, null, 2)}\n`)
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', config], {
    cwd: projectDir,
    stdio: 'inherit',
  })
}

async function verifyKarakaPatch(projectDir, agentDir, configPath, readyPath) {
  const child = spawn(process.execPath, [resolve(agentDir, 'lib/bin.js'), '--config', configPath], {
    cwd: projectDir,
    env: {
      ...process.env,
      KARAKA_AGENTS_DIR: resolve(projectDir, 'agents'),
      KARAKA_HOME: resolve(projectDir, '.karaka'),
      KARAKA_PLUGIN_READY: readyPath,
      KARAKA_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { resolveExit({ code, signal }) })
  })
  try {
    const deadline = Date.now() + 10_000
    while (!existsSync(readyPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const result = await exited
        throw new Error(`packed Karaka Agent exited before loading deployment plugin (${JSON.stringify(result)})\n${output}`)
      }
      if (Date.now() >= deadline) throw new Error(`packed Karaka Agent did not load deployment plugin\n${output}`)
      await new Promise(resolveWait => { setTimeout(resolveWait, 20) })
    }
    child.kill('SIGTERM')
    const result = await exited
    const cleanExit = result.code === 0
      || process.platform === 'win32' && result.code === null && result.signal === 'SIGTERM'
    if (!cleanExit) {
      throw new Error(`packed Karaka Agent shutdown failed (${JSON.stringify(result)})\n${output}`)
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function portableSubpath(path) {
  return path.replaceAll('\\', '/')
}

if (portableSubpath('nested\\entry') !== 'nested/entry') {
  throw new Error('public subpath normalization must replace Windows separators')
}
