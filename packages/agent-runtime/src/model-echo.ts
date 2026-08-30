import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import type { ModelProvider, ModelRequest } from './index.ts'

/** YAML-serializable echo model configuration. */
export interface Config {
  id?: string
  prefix?: string
}

export const Config: Schema<Config> = Schema.object({
  id: Schema.string().default('echo'),
  prefix: Schema.string().default('Echo: '),
})

/** Deterministic model provider for local composition and tests. */
export class EchoModelProvider implements ModelProvider {
  readonly id: string
  private readonly prefix: string

  constructor(config: Config) {
    this.id = config.id ?? 'echo'
    this.prefix = config.prefix ?? 'Echo: '
  }

  async generate(request: Readonly<ModelRequest>) {
    const message = request.messages.findLast(item => item.role === 'user')
    return {
      message: {
        role: 'assistant' as const,
        content: `${this.prefix}${message?.content ?? ''}`,
      },
    }
  }
}

/** Contribute one deterministic echo model. */
export const plugin = {
  name: 'model-echo',
  inject: ['agentModels'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.agentModels.register(new EchoModelProvider(config))
  },
}

export default plugin
