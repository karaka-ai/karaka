/** Stage the validated runtime as an npm bundle without publishing or install hooks. */
import { globSync } from 'node:fs'
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const [artifactArg, destinationArg, version] = process.argv.slice(2)
if (!artifactArg || !destinationArg || !version) throw new Error('Usage: node stage-npm.mjs <built runtime> <new output> <release version>')
const artifact = await realpath(resolve(artifactArg))
const output = resolve(destinationArg)
const graph = JSON.parse(await readFile(resolve(artifact, 'LOCAL-ARTIFACT.json'), 'utf8'))
const originals = new Map()
for (const file of globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'native/system/packages/*/package.json', 'node_modules/.pnpm/*/node_modules/*/package.json', 'node_modules/.pnpm/*/node_modules/@*/*/package.json'], { cwd: root })) {
  const source = resolve(root, dirname(file))
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
  originals.set(`${manifest.name}@${manifest.version}`, source)
}
const nodes = new Map()
for (const item of graph.packages) {
  const source = resolve(artifact, item.path)
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'))
  nodes.set(source, { source, manifest, workspace: item.workspace, links: new Map() })
}
for (const node of nodes.values()) {
  for (const name of graph.packages.find(item => resolve(artifact, item.path) === node.source).dependencies) {
    if (name === '@karaka-ai/cli') continue
    const source = await realpath(resolve(node.source, 'node_modules', name))
    const dependency = nodes.get(source)
    if (!dependency) throw new Error(`Dependency missing from artifact inventory: ${name}`)
    node.links.set(name, dependency)
  }
}
const agent = nodes.get(artifact)
const reachable = new Set()
function visit(node) {
  if (reachable.has(node)) return
  reachable.add(node)
  for (const child of node.links.values()) visit(child)
}
visit(agent)
const primary = new Map()
for (const node of reachable) if (node !== agent && !primary.has(node.manifest.name)) primary.set(node.manifest.name, node)
const releaseVersion = node => node.manifest.name.startsWith('@karaka-ai/') && node.manifest.name !== '@karaka-ai/sdk' ? version : node.manifest.version
await mkdir(output)
const placements = []
async function place(node, target, visible) {
  await mkdir(target, { recursive: true })
  await cp(node.source, target, {
    recursive: true,
    filter: file => {
      const parts = relative(node.source, file).split(sep)
      return !parts.some(part => ['node_modules', '.packages', '.git', '.build', 'test', 'tests', '__tests__', 'e2e'].includes(part)) && !parts.some(part => part === '.env' || part.startsWith('.env.') || part === '.npmrc' || part.endsWith('.pem')) && !file.endsWith('LOCAL-ARTIFACT.json')
    },
  })
  const original = originals.get(`${node.manifest.name}@${node.manifest.version}`)
  if (original) for (const file of globSync(['README*', 'LICENSE*', 'LICENCE*', 'NOTICE*', 'COPYING*'], { cwd: original })) {
    await cp(resolve(original, file), resolve(target, file), { recursive: true, dereference: true })
  }
  const manifest = { ...node.manifest, version: releaseVersion(node) }
  // Release manifests describe only the exact runtime graph; source manifests stay untouched.
  for (const field of ['scripts', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies', 'packageManager', 'pnpm', 'overrides', 'workspaces', 'resolutions']) delete manifest[field]
  manifest.dependencies = Object.fromEntries([...node.links].map(([name, dependency]) => [name, releaseVersion(dependency)]))
  manifest.bundleDependencies = Object.keys(manifest.dependencies)
  if (node === agent) {
    delete manifest.private
    manifest.dependencies = Object.fromEntries([...primary].map(([name, dependency]) => [name, releaseVersion(dependency)]))
    manifest.bundleDependencies = Object.keys(manifest.dependencies)
    manifest.license = 'MIT'
    manifest.engines = { node: '^22.19.0 || >=24.0.0' }
    manifest.os = ['linux']; manifest.cpu = ['x64']; manifest.libc = ['glibc']
    manifest.publishConfig = { access: 'public', tag: 'next' }
    manifest.repository = { type: 'git', url: 'git+https://github.com/karaka-ai/karaka.git' }
    manifest.files = [...manifest.files, 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'BUNDLED-PACKAGES.json']
  }
  await writeFile(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  placements.push({ name: manifest.name, version: manifest.version, license: manifest.license, path: relative(output, target) || '.', repository: manifest.repository })
  if (node === agent) return
  const scope = new Map(visible)
  scope.set(node.manifest.name, node)
  for (const [name, child] of node.links) {
    if (scope.get(name) === child || child === agent) continue
    // Only differing external versions need nesting. Shared upstream packages stay at the root.
    if (child.workspace) throw new Error(`Workspace identity would split: ${name}`)
    await place(child, resolve(target, 'node_modules', name), scope)
  }
}
await place(agent, output, primary)
for (const [name, node] of primary) await place(node, resolve(output, 'node_modules', name), primary)
await cp(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'))
await writeFile(resolve(output, 'BUNDLED-PACKAGES.json'), JSON.stringify({ upstreamCommit: graph.upstreamCommit, runtime: 'linux-x64-glibc', packages: placements }, null, 2) + '\n')
await writeFile(resolve(output, 'README.md'), `# Karaka Agent\n\nApplication server built from unchanged DeepSeek Harness ${graph.upstreamCommit} with Karaka identity and transport plugins.\n\nThis prerelease supports Linux x64 with glibc 2.28 or newer and Node.js ^22.19.0 or >=24.0.0. Other platforms are not included. Install the matching @karaka-ai/cli prerelease to scaffold and launch a project.\n\nThe browser client is exported from @karaka-ai/agent/browser. Browser deployments must configure JWT verification and allowed origins.\n\nThe package bundles its exact runtime dependencies; no install hooks or upstream package publication are required. DSH source files remain unchanged. See BUNDLED-PACKAGES.json and each dependency's license notices. Bundled dependencies retain their own licenses.\n\nAuthoritative chats use upstream JSONL with a separate Karaka ownership store; back up both. No historical SQLite migration is included.\n`)
console.log(`Staged ${placements.length} package placements at ${output}; pack with npm pack --ignore-scripts`)
