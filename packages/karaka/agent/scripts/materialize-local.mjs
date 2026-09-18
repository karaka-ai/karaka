/** Copy built packages and their installed dependency graph without registry resolution. */
import { globSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSourceRevision } from './source-revision.mjs'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const [destination, cliDirectory] = process.argv.slice(2)
if (!destination || !cliDirectory) throw new Error('Usage: node materialize-local.mjs <new artifact directory> <built CLI repository>')
const sourceRevision = readSourceRevision(root)
const output = resolve(destination)
const workspaces = new Map()
for (const file of globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'native/system/package.json', 'native/system/packages/*/package.json'], { cwd: root })) {
  const source = resolve(root, dirname(file))
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
  if (workspaces.has(manifest.name)) throw new Error(`Duplicate workspace package ${manifest.name}`)
  workspaces.set(manifest.name, source)
}
workspaces.set('@karaka-ai/cli', await realpath(resolve(cliDirectory)))
const nodes = new Map()
const pending = []
const omitted = []
await mkdir(output)
await mkdir(resolve(output, '.packages'))

async function locate(name, from) {
  if (workspaces.has(name)) return workspaces.get(name)
  const require = createRequire(resolve(from, 'package.json'))
  for (const search of require.resolve.paths(name) ?? []) {
    const candidate = resolve(search, name)
    try {
      await readFile(resolve(candidate, 'package.json'))
      return await realpath(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  return undefined
}
function compatible(manifest) {
  const matches = (values, current) => !values || (!values.includes(`!${current}`) && (!values.some(value => !value.startsWith('!')) || values.includes(current) || values.includes('any')))
  return matches(manifest.os, process.platform) && matches(manifest.cpu, process.arch)
}
async function include(source, atRoot = false) {
  source = await realpath(source)
  if (nodes.has(source)) return nodes.get(source)
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
  const workspace = workspaces.get(manifest.name) === source
  const key = workspace ? manifest.name : `${manifest.name}@${manifest.version}:${source}`
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12)
  const target = atRoot ? output : resolve(output, '.packages', `${manifest.name.replaceAll('/', '+')}-${hash}`)
  const node = { source, target, manifest, workspace, links: new Map() }
  nodes.set(source, node)
  pending.push(node)
  await copyPublished(node)
  return node
}
async function copyPublished(node) {
  const { source, target, manifest, workspace } = node
  await mkdir(target, { recursive: true })
  const patterns = manifest.files ?? ['*', '.*']
  const exclusions = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const entries = new Set(['package.json', ...globSync(['LICENSE*', 'LICENCE*', 'COPYING*', 'NOTICE*', ...patterns.filter(pattern => !pattern.startsWith('!'))], { cwd: source })])
  for (const entry of entries) {
    const from = resolve(source, entry)
    if (relative(source, from).startsWith('..') || isAbsolute(relative(source, from))) throw new Error(`Package files escape ${manifest.name}`)
    await cp(from, resolve(target, entry), {
      recursive: true, dereference: true,
      filter: path => {
        const rel = relative(source, path)
        if (rel.split(sep).some(part => part === 'node_modules' || part === '.git' || part === '.build')) return false
        if (workspace && rel.split(sep).some(part => part === 'tests' || part === 'e2e')) return false
        return !exclusions.some(pattern => matchesGlob(rel, pattern))
      },
    })
  }
}
const agent = await include(workspaces.get('@karaka-ai/agent'), true)
const cli = await include(workspaces.get('@karaka-ai/cli'))
agent.links.set('@karaka-ai/cli', cli)
cli.links.set('@karaka-ai/agent', agent)
while (pending.length) {
  const node = pending.shift()
  const manifest = node.manifest
  const requirements = new Map()
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) requirements.set(name, true)
  for (const name of Object.keys(manifest.peerDependencies ?? {})) requirements.set(name, manifest.peerDependenciesMeta?.[name]?.optional === true)
  for (const name of Object.keys(manifest.dependencies ?? {})) requirements.set(name, false)
  for (const [name, optional] of requirements) {
    const source = await locate(name, node.source)
    if (source === undefined) {
      if (!optional) throw new Error(`${manifest.name} requires unavailable installed package ${name}`)
      omitted.push({ consumer: manifest.name, name, reason: 'optional package is not installed' })
      continue
    }
    const dependency = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
    if (!compatible(dependency)) {
      if (!optional) throw new Error(`${manifest.name} requires ${name} on an incompatible platform`)
      omitted.push({ consumer: manifest.name, name, reason: 'optional package targets another platform' })
      continue
    }
    node.links.set(name, await include(source))
  }
}
for (const node of nodes.values()) {
  for (const [name, dependency] of node.links) {
    const link = resolve(node.target, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    const target = relative(dirname(link), dependency.target)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
// The profile's installation resolver and independent CLI both locate this exact server.
const self = resolve(output, 'node_modules/@karaka-ai/agent')
await symlink(relative(dirname(self), output), self, process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(resolve(output, 'LOCAL-ARTIFACT.json'), JSON.stringify({
  runtime: '@karaka-ai/agent', cli: 'node_modules/@karaka-ai/cli/lib/bin.js',
  ...sourceRevision,
  platform: process.platform, architecture: process.arch, published: false,
  packages: [...nodes.values()].map(node => ({ name: node.manifest.name, version: node.manifest.version, workspace: node.workspace, path: relative(output, node.target) || '.', dependencies: [...node.links.keys()] })),
  omitted,
}, null, 2) + '\n')
console.log(`Local Karaka artifact: ${output} (${nodes.size} canonical installed packages)`)
