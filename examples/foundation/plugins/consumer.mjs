export const name = 'greeting-consumer'
export const inject = ['greeter']

export function apply(ctx) {
  ctx.provide('exampleGreeting', ctx.greeter.greet('Karaka'))
}
