import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { fileURLToPath } from 'node:url'

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
      dependencies: { '@karaka/cli': karakaVersion },
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

/** Prepared runtime paths used by the CLI launcher. */
export interface KarakaRuntime {
  readonly home: string
  readonly bin: string
}

/**
 * Prepare the private runtime home and resolve the Agent executable shipped with this CLI.
 * @param project - application project root.
 * @returns Agent home and executable path.
 */
export function prepareKarakaRuntime(project = process.cwd()): KarakaRuntime {
  const home = resolve(project, '.karaka')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(home, 0o700)
  return { home, bin: require.resolve('@karaka/agent/bin') }
}

/**
 * Run the installed Karaka Agent executable as the project's foreground child.
 * @param config - deployment patch path relative to the current project.
 * @returns child-process exit code.
 */
export async function startKarakaProject(config = 'karaka.cordis.yml'): Promise<number> {
  const project = process.cwd()
  const { home, bin } = prepareKarakaRuntime(project)
  const child = spawn(process.execPath, [bin, '--config', resolve(project, config)], {
    cwd: project,
    env: {
      ...process.env,
      KARAKA_HOME: home,
      KARAKA_AGENTS_DIR: process.env.KARAKA_AGENTS_DIR ?? resolve(project, 'agents'),
    },
    stdio: 'inherit',
  })
  return ownKarakaChild(child)
}

interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

/**
 * Forward supervisor shutdown to the persistent Agent child; a second signal forces termination.
 * @param child - spawned Agent process.
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
  name: '@karaka/agent/persona'
  config:
    text: You are a helpful support agent.
    complete: true
    includeRuntimeContext: false

- id: tools
  name: '@karaka/agent/agent-tool-presentation'
  config:
    mode: native
    allow: []
`
