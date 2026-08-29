import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import type { AgentDefinition } from './index.ts'

/** YAML-serializable agent definition. */
export interface Config extends AgentDefinition {}

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().required(),
  prompt: Schema.string().required(),
  model: Schema.string().required(),
})

/** Contribute one declarative agent definition. */
export const plugin = {
  name: 'agent-definition',
  inject: ['agentRuntime'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.agentRuntime.registerAgent(config)
  },
}

export default plugin
