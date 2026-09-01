import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
/** Installed Karaka CLI package version. */
export const karakaVersion = readPackageVersion()

/**
 * Create a separate Karaka agent workspace without replacing existing files.
 * @param directory - target directory, relative to the current process by default.
 * @returns absolute workspace path.
 */
export function initKarakaProject(directory = 'apps/agents'): string {
  const root = resolve(directory)
  const files = new Map<string, string>([
    ['package.json', JSON.stringify({
      name: 'karaka-agents',
      private: true,
      type: 'module',
      scripts: { start: 'karaka start', dev: 'karaka start' },
      dependencies: { '@karaka/cli': karakaVersion, '@karaka/harness': karakaVersion },
    }, undefined, 2) + '\n'],
    ['karaka.cordis.yml', KARAKA_CONFIG],
    ['agents/support/preset.yml', 'name: Support\ndescription: General application support\norder: 1\n'],
    ['agents/support/agent.cordis.yml', SUPPORT_AGENT],
  ])
  for (const [relative, content] of files) {
    const path = join(root, relative)
    if (existsSync(path)) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  ensureGitIgnore(root, '.karaka/')
  return root
}

/** Prepared profile paths used by the CLI launcher. */
export interface KarakaProfile {
  readonly home: string
  readonly profileDir: string
}

/**
 * Prepare a project-local Harness home whose profile can resolve the CLI's Karaka bundle dependency.
 * @param project - application project root.
 * @returns Harness home and profile paths.
 */
export function prepareKarakaProfile(project = process.cwd()): KarakaProfile {
  const home = resolve(project, '.karaka')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(home, 0o700)
  const template = PROFILE_TEMPLATES.karaka
  if (template === undefined) throw new Error('Karaka profile template is unavailable')
  const profileDir = resolve(home, 'profiles/karaka')
  initProfile(profileDir, template.bundles, template.patchReload)
  linkProjectDependencies(profileDir, project)
  linkProfileBundle(profileDir, '@karaka/harness')
  return { home, profileDir }
}

/**
 * Run the Karaka profile through the existing dsh launcher.
 * @param config - deployment patch path relative to the current project.
 * @returns child-process exit code.
 */
export async function startKarakaProject(config = 'karaka.cordis.yml'): Promise<number> {
  const project = process.cwd()
  const { home } = prepareKarakaProfile(project)
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
  const bin = resolve(dirname(dshManifest), 'lib/bin.js')
  const child = spawn(process.execPath, [bin, '--profile', 'karaka', '--patch', resolve(project, config)], {
    cwd: project,
    env: { ...process.env, DSH_HOME: home },
    stdio: 'inherit',
  })
  return ownKarakaChild(child)
}

interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

/**
 * Forward supervisor shutdown to the persistent Harness child; a second signal forces termination.
 * @param child - spawned dsh profile process.
 * @param signals - process-like signal source, replaceable by lifecycle tests.
 * @returns child-process exit code.
 */
export function ownKarakaChild(child: ChildProcess, signals: SignalSource = process): Promise<number> {
  return new Promise<number>((resolveExit, reject) => {
    let forwarded = false
    let forced = false
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (!forwarded) {
        forwarded = true
        child.kill(signal)
      } else if (!forced) {
        forced = true
        child.kill('SIGKILL')
      }
    }
    const onInterrupt = (): void => { forward('SIGINT') }
    const onTerminate = (): void => { forward('SIGTERM') }
    const cleanup = (): void => {
      signals.off('SIGINT', onInterrupt)
      signals.off('SIGTERM', onTerminate)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      const signalNumber = signal === null
        ? undefined
        : (osConstants.signals as Partial<Record<NodeJS.Signals, number>>)[signal]
      resolveExit(signal === null ? code ?? 1 : 128 + (signalNumber ?? 0))
    }
    signals.on('SIGINT', onInterrupt)
    signals.on('SIGTERM', onTerminate)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function linkProfileBundle(profileDir: string, packageName: string): void {
  const manifest = require.resolve(`${packageName}/package.json`)
  linkProfilePackage(profileDir, packageName, dirname(manifest))
}

function linkProjectDependencies(profileDir: string, project: string): void {
  const manifestPath = join(project, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, unknown>
      optionalDependencies?: Record<string, unknown>
    }
    : {}
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const statePath = join(profileDir, '.karaka-project-links.json')
  for (const packageName of readProjectLinkState(statePath)) {
    if (!names.has(packageName) || !existsSync(projectPackagePath(project, packageName))) {
      unlinkManagedProfilePackage(profileDir, packageName)
    }
  }
  const linked: string[] = []
  for (const packageName of names) {
    const target = projectPackagePath(project, packageName)
    if (!existsSync(target)) continue
    linkProfilePackage(profileDir, packageName, target, false)
    linked.push(packageName)
  }
  writeFileSync(statePath, `${JSON.stringify(linked.sort(), undefined, 2)}\n`)
}

function readProjectLinkState(path: string): string[] {
  if (!existsSync(path)) return []
  const state = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!Array.isArray(state)) {
    throw new Error(`Karaka project-link state is invalid: ${path}`)
  }
  const names = state.filter((name): name is string => typeof name === 'string')
  if (names.length !== state.length) throw new Error(`Karaka project-link state is invalid: ${path}`)
  return names
}

function unlinkManagedProfilePackage(profileDir: string, packageName: string): void {
  const link = projectPackagePath(profileDir, packageName)
  try {
    if (!lstatSync(link).isSymbolicLink()) {
      throw new Error(`Karaka profile package path is not a managed link: ${link}`)
    }
    unlinkSync(link)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function projectPackagePath(project: string, packageName: string): string {
  const modules = resolve(project, 'node_modules')
  const target = resolve(modules, packageName)
  const nested = relative(modules, target)
  if (nested.length === 0 || nested.startsWith('..') || isAbsolute(nested)) {
    throw new Error(`Karaka project declares an invalid package name: ${packageName}`)
  }
  return target
}

function linkProfilePackage(
  profileDir: string,
  packageName: string,
  target: string,
  dereferenceTarget = true,
): void {
  const link = projectPackagePath(profileDir, packageName)
  const linkedTarget = dereferenceTarget ? realpathSync.native(target) : resolve(target)
  try {
    const entry = lstatSync(link)
    if (!entry.isSymbolicLink()) {
      throw new Error(`Karaka profile package path is not a managed link: ${link}`)
    }
    if (dereferenceTarget) {
      try {
        if (realpathSync.native(link) === realpathSync.native(target)) return
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    unlinkSync(link)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(linkedTarget, link, 'junction')
}

function readPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('@karaka/cli package version is unavailable')
  }
  return manifest.version
}

function ensureGitIgnore(root: string, entry: string): void {
  const path = join(root, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (current.split(/\r?\n/u).includes(entry)) return
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  writeFileSync(path, `${current}${separator}${entry}\n`)
}

const KARAKA_CONFIG = `# Final Cordis patch for this Karaka deployment.
- id: server-auth
  config:
    applications:
      - id: application
        chatCredential: KARAKA_CHAT_TOKEN
        toolCredential: KARAKA_TOOL_TOKEN
`

const SUPPORT_AGENT = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful support agent.
    complete: true
    includeRuntimeContext: false

- id: tools
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: native
    allow: []
`
