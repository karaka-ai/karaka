import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import { chmod } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { openNodeTransport } from './http.ts'

/** YAML-serializable Unix domain socket configuration. */
export interface Config {
  path: string
  mode?: number
  basePath?: string
  maxBodyBytes?: number
  requestTimeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().required(),
  mode: Schema.natural().max(0o777).default(0o600),
  basePath: Schema.string().default('/v1'),
  maxBodyBytes: Schema.natural().min(1).default(65_536),
  requestTimeoutMs: Schema.natural().min(1).default(120_000),
})

/** Open one authenticated application boundary on a Unix domain socket. */
export const plugin = {
  name: 'transport-ipc',
  inject: ['agentRuntime', 'authentication'],
  Config,
  async apply(ctx: Context, config: Config) {
    const path = requireSocketPath(config.path)
    const mode = requireMode(config.mode ?? 0o600)
    const close = await openNodeTransport(ctx, config, server => server.listen(path))
    try {
      await chmod(path, mode)
    } catch (error) {
      await close()
      throw error
    }
    return close
  },
}

function requireSocketPath(value: string): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new TypeError('transport IPC path must be absolute')
  }
  return value
}

function requireMode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new TypeError('transport IPC mode must be an integer from 0 to 511')
  }
  return value
}

export default plugin
