import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'tsdown'
import { typertPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

const resolveFrom = createRequire(import.meta.url)
const packageDir = dirname(fileURLToPath(import.meta.url))
const outputDir = resolve(packageDir, 'lib')
const publicEntryDir = resolve(outputDir, 'public-entries')
const bundledWorkspaceModule = /^@deepseek-ai\/dsh-|^@karaka-ai\/(?:mcp-application|server-auth|transport-http)(?:\/|$)/

const contractModules: Readonly<Record<string, string>> = {
  attachment: '@deepseek-ai/dsh-attachment',
  authorization: '@deepseek-ai/dsh-authorization',
  'code-runtime': '@deepseek-ai/dsh-code-runtime',
  compaction: '@deepseek-ai/dsh-compaction',
  credentials: '@deepseek-ai/dsh-credentials',
  'file-reference': '@deepseek-ai/dsh-file-reference',
  fs: '@deepseek-ai/dsh-fs',
  jobs: '@deepseek-ai/dsh-jobs',
  sandbox: '@deepseek-ai/dsh-sandbox',
  scope: '@deepseek-ai/dsh-scope',
  'session-persistence': '@deepseek-ai/dsh-session-persistence',
  'session-query': '@deepseek-ai/dsh-session-query',
  'session-telemetry': '@deepseek-ai/dsh-session-telemetry',
  settings: '@deepseek-ai/dsh-settings',
  shell: '@deepseek-ai/dsh-shell',
  spill: '@deepseek-ai/dsh-spill',
  subprocess: '@deepseek-ai/dsh-subprocess',
  'typert-protocol': '@deepseek-ai/dsh-typert-protocol',
  workflow: '@deepseek-ai/dsh-workflow',
}

interface PublicModule {
  readonly subpath: string
  readonly specifier: string
}

/** Read the Loader's static namespace imports and exact Karaka aliases. */
function readBundledModules(): PublicModule[] {
  const source = readFileSync(resolve(packageDir, 'src/plugins.ts'), 'utf8')
  const imports = new Map(
    [...source.matchAll(/^import \* as (plugin\d+) from '([^']+)'$/gmu)]
      .map(match => {
        const identifier = match[1]
        const specifier = match[2]
        if (identifier === undefined || specifier === undefined) {
          throw new Error('Karaka Loader registry contains an invalid static import')
        }
        return [identifier, specifier] as const
      }),
  )
  const modules = [...source.matchAll(/^  '@karaka-ai\/agent\/([^']+)': (plugin\d+),$/gmu)]
    .map((match): PublicModule => {
      const subpath = match[1]
      const identifier = match[2]
      if (subpath === undefined || identifier === undefined) {
        throw new Error('Karaka Loader registry contains an invalid public alias')
      }
      const specifier = imports.get(identifier)
      if (specifier === undefined) throw new Error(`missing static import for @karaka-ai/agent/${subpath}`)
      return { subpath, specifier }
    })
  if (modules.length !== imports.size) {
    throw new Error(`Karaka Loader registry has ${modules.length} aliases for ${imports.size} static imports`)
  }
  return modules
}

/** Build the complete public module list without replacing Loader aliases with contract-only modules. */
function readPublicModules(): PublicModule[] {
  const modules = new Map(readBundledModules().map(module => [module.subpath, module.specifier]))
  for (const [subpath, specifier] of Object.entries(contractModules)) {
    const existing = modules.get(subpath)
    if (existing !== undefined && existing !== specifier) {
      throw new Error(`public subpath @karaka-ai/agent/${subpath} maps to both ${existing} and ${specifier}`)
    }
    modules.set(subpath, specifier)
  }
  return [...modules].map(([subpath, specifier]) => ({ subpath, specifier }))
}

/** Locate the declaration selected by one package export. */
function declarationPath(specifier: string): string {
  const runtimePath = resolveFrom.resolve(specifier)
  const marker = `${sep}lib${sep}`
  const index = runtimePath.lastIndexOf(marker)
  if (index === -1) throw new Error(`cannot locate declarations for ${specifier}`)
  const declaration = runtimePath.includes(`${marker}types${sep}`)
    ? runtimePath
    : `${runtimePath.slice(0, index)}${marker}types${sep}${runtimePath.slice(index + marker.length)}`
  return declaration.replace(/\.js$/u, '.d.ts')
}

/** Generate TypeScript facades so tsdown can inline private runtime and declaration dependencies. */
function writePublicEntries(modules: readonly PublicModule[]): Record<string, string> {
  rmSync(publicEntryDir, { recursive: true, force: true })
  const entries: Record<string, string> = {}
  const typeManifest: { subpath: string; specifier: string; declaration: string; hasDefault: boolean }[] = []
  for (const { subpath, specifier } of modules) {
    const entry = resolve(publicEntryDir, `${subpath}.ts`)
    mkdirSync(dirname(entry), { recursive: true })
    const declaration = readFileSync(declarationPath(specifier), 'utf8')
    const hasDefault = /\bexport\s+default\b|\bexport\s*\{[^}]*\bdefault\b[^}]*\}/su.test(declaration)
    writeFileSync(entry, [
      `export * from '${specifier}'`,
      ...(hasDefault ? [`export { default } from '${specifier}'`] : []),
      '',
    ].join('\n'))
    entries[subpath] = entry
    typeManifest.push({ subpath, specifier, declaration: declarationPath(specifier), hasDefault })
  }
  writeFileSync(resolve(outputDir, 'public-type-manifest.json'), `${JSON.stringify(typeManifest, null, 2)}\n`)
  return entries
}

/** Remove prior root JavaScript outputs without deleting tsc's `lib/types` inputs. */
const cleanRuntimeOutputs = {
  name: 'karaka-agent-clean-runtime-outputs',
  buildStart(): void {
    cleanOutputs(outputDir)
  },
}

/** Remove bundle outputs recursively while preserving tsc inputs and generated facade sources. */
function cleanOutputs(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'types' || entry.name === 'public-entries') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      cleanOutputs(path)
      continue
    }
    if (/\.(?:d\.ts|js)(?:\.map)?$/u.test(entry.name)) rmSync(path)
  }
}

/** Resolve bundled workspaces from tsc output so const enums are already lowered. */
const bundledWorkspaceResolver = {
  name: 'karaka-agent-workspace-artifacts',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string): string | null {
    if (!bundledWorkspaceModule.test(source)) return null
    const resolved = (importer === undefined ? resolveFrom : createRequire(importer)).resolve(source)
    const marker = `${sep}lib${sep}`
    if (resolved.includes(`${marker}types${sep}`)) return resolved
    const index = resolved.lastIndexOf(marker)
    if (index === -1) return resolved
    return `${resolved.slice(0, index)}${marker}types${sep}${resolved.slice(index + marker.length)}`
  },
}

/** Emit the public declarations after every runtime bundle, including workspace-wide builds. */
const publicDeclarations = {
  name: 'karaka-agent-public-declarations',
  closeBundle(): void {
    const script = resolve(packageDir, 'scripts/build-public-types.mjs')
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`public declaration build exited with status ${result.status ?? 'unknown'}`)
  },
}

const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: (specifier: string) => bundledWorkspaceModule.test(specifier),
  },
  plugins: [
    cleanRuntimeOutputs,
    bundledWorkspaceResolver,
    typertPlugin({ mode: 'workspace', faces: ['host'] }),
    publicDeclarations,
  ],
} satisfies UserConfig

/** Bundle every private DSH module into the public Agent artifact. */
export default defineConfig(({ env }) => {
  if (env?.DSH_BUILD_FACE === 'client') return { entry: '' }
  if (env?.DSH_BUILD_FACE !== undefined && env.DSH_BUILD_FACE !== 'host') {
    throw new Error('Karaka Agent DSH build face must be host or client')
  }
  if (env?.KARAKA_AGENT_BUILD !== undefined && env.KARAKA_AGENT_BUILD !== 'runtime') {
    throw new Error('Karaka Agent build requires the runtime mode')
  }
  const publicEntries = writePublicEntries(readPublicModules())
  return {
    ...shared,
    entry: {
      index: 'lib/types/index.js',
      bin: 'lib/types/bin.js',
      cordis: 'lib/types/cordis.js',
      invariant: 'lib/types/invariant.js',
      ...Object.fromEntries(
        Object.entries(publicEntries).map(([subpath, entry]) => [`public/${subpath}`, entry]),
      ),
    },
  }
})
