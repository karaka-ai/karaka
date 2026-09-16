/** Preserve allow/deny intent at the preset boundary without replacing DSH Tools. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import * as Presentation from '@deepseek-ai/dsh-agent-tool-presentation'
import { applicationToolNames, registerPolicy } from './policy.ts'

export const name = 'karaka-tool-policy'
export const inject = ['tools']
/** Tool presentation and inherited allow/deny lists for one Agent preset. */
export interface Config {
  /** Tool presentation mode. Default: native. */
  mode: 'native' | 'ptc' | 'both'
  /** Allowed public names; omission preserves an ancestor's restriction. */
  allow?: string[]
  /** Denied public names; deny overrides allow throughout the scope chain. */
  deny?: string[]
}
export const Config = z.object({
  mode: z.union(['native', 'ptc', 'both']).default('native'),
  // An omitted list must stay omitted; Schemastery otherwise defaults arrays to [].
  allow: (z.array(String) as z<string[] | undefined>).default(undefined),
  deny: (z.array(String) as z<string[] | undefined>).default(undefined),
}) as z<Config>

/** Mount tool presentation and reversible Agent-scoped restrictions. */
export function apply(ctx: Context, config: Config): void {
  Presentation.apply(ctx, { mode: config.mode })
  if (config.allow === undefined && config.deny === undefined) return
  const application = applicationToolNames(ctx)
  ctx.tools.restrict({
    ...config.allow === undefined ? {} : { allow: config.allow.filter(name => !application.has(name)) },
    ...config.deny === undefined ? {} : { deny: config.deny.filter(name => !application.has(name)) },
  })
  ctx.effect(() => registerPolicy(ctx, {
    ...config.allow === undefined ? {} : { allow: [...config.allow] },
    ...config.deny === undefined ? {} : { deny: [...config.deny] },
  }), 'karaka-tool-policy')
}
