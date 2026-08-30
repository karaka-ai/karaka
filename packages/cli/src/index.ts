import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@karaka/cordis'
import Include from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'

declare module '@karaka/cordis' {
  interface Events {
    /** Validate the complete settled plugin graph before startup succeeds. */
    'karaka/ready'(): void | Promise<void>
  }
}

export const START_USAGE = 'Usage: karaka start --config <path>'

export interface StartOptions {
  /** Setup YAML path, absolute or relative to `cwd`. */
  config: string
  /** Invocation directory used for a relative config path. */
  cwd?: string
}

export type ShutdownSignal = 'SIGINT' | 'SIGTERM'

/** The process signal surface used by the long-running command. */
export interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown
  off(signal: ShutdownSignal, listener: () => void): unknown
}

/** Parse the deliberately small startup command. */
export function parseStartArgs(args: readonly string[]): StartOptions {
  if (args[0] !== 'start') throw new Error(START_USAGE)

  let config: string | undefined
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!
    let value: string | undefined
    if (argument === '--config') {
      value = args[++index]
    } else if (argument.startsWith('--config=')) {
      value = argument.slice('--config='.length)
    } else {
      throw new Error(`unknown argument: ${argument}\n${START_USAGE}`)
    }
    if (!value) throw new Error(`--config requires a path\n${START_USAGE}`)
    if (config !== undefined) throw new Error(`--config may only be provided once\n${START_USAGE}`)
    config = value
  }

  if (config === undefined) throw new Error(`--config is required\n${START_USAGE}`)
  return { config }
}

/** Create one root Cordis graph and settle every plugin from the setup file. */
export async function bootKaraka(options: StartOptions): Promise<Context> {
  const configPath = resolve(options.cwd ?? process.cwd(), options.config)
  if (!['.yaml', '.yml'].includes(extname(configPath))) {
    throw new Error(`Karaka setup must be a .yaml or .yml file: ${configPath}`)
  }
  const ctx = new Context()
  ctx.baseUrl = new URL('.', pathToFileURL(configPath)).href

  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    await ctx.serial('karaka/ready')
    return ctx
  } catch (cause) {
    await ctx.fiber.dispose()
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`failed to load Karaka setup ${configPath}: ${detail}`, { cause })
  }
}

/** Boot Karaka, remain alive, and dispose the graph on a termination signal. */
export async function runKaraka(
  options: StartOptions,
  signals: SignalSource = process,
): Promise<ShutdownSignal> {
  const ctx = await bootKaraka(options)

  return new Promise<ShutdownSignal>((resolveRun, rejectRun) => {
    const keepAlive = setInterval(() => undefined, 2 ** 31 - 1)
    let shuttingDown = false
    const listeners: Record<ShutdownSignal, () => void> = {
      SIGINT: () => shutdown('SIGINT'),
      SIGTERM: () => shutdown('SIGTERM'),
    }

    const removeListeners = () => {
      signals.off('SIGINT', listeners.SIGINT)
      signals.off('SIGTERM', listeners.SIGTERM)
      clearInterval(keepAlive)
    }

    const shutdown = (signal: ShutdownSignal) => {
      if (shuttingDown) return
      shuttingDown = true
      void (async () => {
        try {
          await ctx.parallel('exit', signal)
        } finally {
          try {
            await ctx.fiber.dispose()
          } finally {
            removeListeners()
          }
        }
      })().then(() => resolveRun(signal), rejectRun)
    }

    signals.once('SIGINT', listeners.SIGINT)
    signals.once('SIGTERM', listeners.SIGTERM)
  })
}
