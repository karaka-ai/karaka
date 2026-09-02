/** Karaka Agent process boot and shutdown. */

import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot, installFailLoud, loadLayeredEnv, loadOverlayPatches,
} from '@deepseek-ai/dsh-app-boot'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { installBundledPlugins } from './plugins.ts'

const NAME = 'karaka-agent'
const SHUTDOWN_TIMEOUT_MS = 5_000

interface ProcessShutdown {
  interrupt(code: number): void
}

function createProcessShutdown(dispose: () => Promise<void>): ProcessShutdown {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  const forceExit = (code: number): void => {
    if (timeout !== undefined) clearTimeout(timeout)
    process.exit(code)
  }

  return {
    interrupt(code) {
      if (pending !== undefined) {
        forceExit(code)
        return
      }
      timeout = setTimeout(() => { forceExit(code) }, SHUTDOWN_TIMEOUT_MS)
      pending = dispose().then(
        () => { forceExit(code) },
        () => { forceExit(code === 0 ? 1 : code) },
      )
    },
  }
}

/**
 * Boot the bundled Karaka composition with one deployment patch.
 * @param configPath - absolute path to the deployment's Cordis patch file.
 * @returns the settled Cordis root context.
 */
export async function launchAgent(configPath: string): Promise<Context> {
  const environment = loadLayeredEnv(NAME)
  const rootConfig = fileURLToPath(new URL('../cordis.yml', import.meta.url))
  const patches = [
    ...loadOverlayPatches(NAME, fileURLToPath(new URL('../base.cordis.patch.yml', import.meta.url))),
    ...loadOverlayPatches(NAME, fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
    ...loadOverlayPatches(NAME, configPath),
  ]
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const interrupt = (code: number): void => { shutdown.interrupt(code) }
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => { await app.current?.fiber.dispose() })

  const ctx = await boot(NAME, rootConfig, structuredClone(patches), (hostCtx) => {
    app.current = hostCtx
    installBundledPlugins(hostCtx.loader)
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
  }, pathToFileURL(configPath).href)
  app.current = ctx
  return ctx
}
