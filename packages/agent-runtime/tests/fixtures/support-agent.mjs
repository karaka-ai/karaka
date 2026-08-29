export default {
  name: 'support-agent',
  inject: ['agentRuntime'],
  apply(ctx) {
    ctx.agentRuntime.registerAgent({
      id: 'support',
      prompt: 'You are a helpful support agent.',
      model: 'support-model',
    })
  },
}
