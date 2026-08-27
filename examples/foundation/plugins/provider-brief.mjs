import { GreeterService } from './contract.mjs'

export const name = 'brief-greeter'

export function apply(ctx) {
  ctx.plugin(class extends GreeterService {
    constructor(providerContext) {
      super(providerContext, who => `Hi ${who}.`)
    }
  })
}
