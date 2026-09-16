/** Karaka admission readiness after the DSH launcher settles its plugin tree. */
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Application admission verdict; false before startup validation and during disposal. */
export interface KarakaStartup {
  /** Whether every enabled startup entry activated successfully. */
  readonly ready: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Karaka-owned startup verdict, distinct from the launcher's readiness signal. */
    karakaStartup: KarakaStartup
  }
}

/** Independent guard; application services may fail without preventing this plugin from loading. */
export const name = 'karaka-startup'
/** Launcher and Loader facts needed to audit the settled tree and request bounded shutdown. */
export const inject = ['loader', 'appReady', 'appExit']

// Cordis exports a const enum without a runtime object, as in DSH's startup audit.
const ACTIVE = 2 as FiberState.ACTIVE
const PENDING = 0 as FiberState.PENDING

/** Collect unusable enabled entries, including those in nested Includes. */
function startupFailures(loader: Loader): string[] {
  const failures: string[] = []
  for (const entry of loader.entries()) {
    const subject = `${entry.id} (${entry.options.name})`
    try {
      if (entry.disabled) continue
    } catch (error) {
      failures.push(`${subject}: disabled expression failed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const fiber = entry.fiber
    if (fiber === undefined) {
      failures.push(`${subject}: failed to import`)
    } else if (fiber.state === PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      failures.push(`${subject}: pending (waiting for: ${missing.join(', ') || 'unknown'})`)
    } else if (fiber.state !== ACTIVE) {
      failures.push(`${subject}: inactive fiber (state ${String(fiber.state)})`)
    }
  }
  return failures
}

/**
 * Keep Karaka ingress closed unless all enabled startup entries activate.
 * @param ctx - Context with the Loader and launcher readiness/exit services.
 */
export function apply(ctx: Context): void {
  const loader = ctx.loader
  const appReady = ctx.get('appReady')
  const appExit = ctx.get('appExit')
  if (appReady === undefined || appExit === undefined) {
    throw new Error('Karaka startup requires launcher readiness and exit services')
  }
  let ready = false
  ctx.effect(() => {
    const cancel = appReady.onReady(() => {
      const failures = startupFailures(loader)
      if (failures.length > 0) {
        ctx.logger.error(`Karaka startup failed:\n${failures.join('\n')}`)
        appExit(1)
        return
      }
      ready = true
    })
    return () => {
      ready = false
      cancel()
    }
  }, 'karaka-startup.readiness')
  ctx.provide('karakaStartup', { get ready() { return ready } })
}
