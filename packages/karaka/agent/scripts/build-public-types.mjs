import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'

const packageDir = resolve(import.meta.dirname, '..')
const repositoryDir = resolve(packageDir, '../../..')
const libDir = resolve(packageDir, 'lib')
const publicDir = resolve(libDir, 'public')
const privateDir = resolve(libDir, 'public-types')
const require = createRequire(resolve(packageDir, 'package.json'))
const manifest = JSON.parse(readFileSync(resolve(libDir, 'public-type-manifest.json'), 'utf8'))
const workspaces = workspacePackages()

rmSync(privateDir, { recursive: true, force: true })
removeDeclarations(publicDir)

const packages = new Map()
const queue = []
for (const entry of manifest) registerPackage(entry.specifier, entry.declaration)

for (let index = 0; index < queue.length; index += 1) {
  const pkg = queue[index]
  for (const source of declarationFiles(pkg.sourceDir)) {
    const destination = resolve(pkg.destinationDir, relative(pkg.sourceDir, source))
    mkdirSync(dirname(destination), { recursive: true })
    const rewritten = readFileSync(source, 'utf8')
      .replace(/(['"])(@deepseek-ai\/dsh-[a-z0-9-]+(?:\/[^'"]+)?)\1/gu, (_match, quote, specifier) => {
        const targetDeclaration = declarationPath(specifier, source)
        const targetPackage = registerPackage(specifier, targetDeclaration)
        const target = resolve(
          targetPackage.destinationDir,
          relative(targetPackage.sourceDir, targetDeclaration),
        ).replace(/\.d\.ts$/u, '.js')
        const path = relative(dirname(destination), target).replaceAll(sep, '/')
        return `${quote}${path.startsWith('.') ? path : `./${path}`}${quote}`
      })
      .replace(/@deepseek-ai\/dsh-([a-z0-9-]+)/gu, '@karaka/agent/$1')
      .replace(/^\/\/# sourceMappingURL=.*\n?/gmu, '')
    writeFileSync(destination, rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`)
  }
}

for (const entry of manifest) {
  const pkg = registerPackage(entry.specifier, entry.declaration)
  const facade = resolve(publicDir, `${entry.subpath}.d.ts`)
  const specifier = relativeSpecifier(facade, copiedRuntimeTarget(pkg, entry.declaration))
  const augmentations = declarationFiles(pkg.sourceDir)
    .filter(source => source !== entry.declaration && readFileSync(source, 'utf8').includes('declare module '))
    .map(source => relativeSpecifier(facade, copiedRuntimeTarget(pkg, source)))
    .sort()
  mkdirSync(dirname(facade), { recursive: true })
  writeFileSync(facade, [
    ...augmentations.map(augmentation => `import '${augmentation}'`),
    `export * from '${specifier}'`,
    ...(entry.hasDefault ? [`export { default } from '${specifier}'`] : []),
    '',
  ].join('\n'))
}

function copiedRuntimeTarget(pkg, declaration) {
  return resolve(pkg.destinationDir, relative(pkg.sourceDir, declaration)).replace(/\.d\.ts$/u, '.js')
}

function relativeSpecifier(importer, target) {
  const path = relative(dirname(importer), target).replaceAll(sep, '/')
  return path.startsWith('.') ? path : `./${path}`
}

function registerPackage(specifier, declaration) {
  const name = packageName(specifier)
  const existing = packages.get(name)
  if (existing !== undefined) return existing
  const marker = `${sep}lib${sep}types${sep}`
  const index = declaration.lastIndexOf(marker)
  if (index === -1) throw new Error(`cannot locate declaration root for ${specifier}`)
  const sourceDir = declaration.slice(0, index + marker.length - 1)
  const key = name.replace(/^@/u, '').replaceAll('/', '-')
  const pkg = { name, sourceDir, destinationDir: resolve(privateDir, key) }
  packages.set(name, pkg)
  queue.push(pkg)
  return pkg
}

function packageName(specifier) {
  const match = /^(@[^/]+\/[^/]+)/u.exec(specifier)
  if (match?.[1] === undefined) throw new Error(`public type dependency is not a package: ${specifier}`)
  return match[1]
}

function declarationPath(specifier, importer) {
  let runtimePath
  try {
    runtimePath = (importer === undefined ? require : createRequire(importer)).resolve(specifier)
  } catch (error) {
    const name = packageName(specifier)
    const workspace = workspaces.get(name)
    if (workspace === undefined) throw error
    const subpath = specifier.slice(name.length)
    const target = subpath === '' ? workspace.manifest.types : workspace.manifest.exports?.[`.${subpath}`]?.types
    if (typeof target !== 'string') throw error
    return resolve(workspace.dir, target)
  }
  const marker = `${sep}lib${sep}`
  const index = runtimePath.lastIndexOf(marker)
  if (index === -1) throw new Error(`cannot locate declarations for ${specifier}`)
  const declaration = runtimePath.includes(`${marker}types${sep}`)
    ? runtimePath
    : `${runtimePath.slice(0, index)}${marker}types${sep}${runtimePath.slice(index + marker.length)}`
  return declaration.replace(/\.js$/u, '.d.ts')
}

function workspacePackages() {
  const result = new Map()
  const packagesDir = resolve(repositoryDir, 'packages')
  for (const group of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = resolve(packagesDir, group.name)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = resolve(groupDir, entry.name)
      try {
        const packageManifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
        if (typeof packageManifest.name === 'string') result.set(packageManifest.name, { dir, manifest: packageManifest })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return result
}

function declarationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? declarationFiles(path) : path.endsWith('.d.ts') ? [path] : []
  })
}

function removeDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) removeDeclarations(path)
    else if (entry.name.endsWith('.d.ts')) rmSync(path)
  }
}
