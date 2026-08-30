export default {
  name: 'support-agent',
  inject: ['agentRuntime', 'agentModels'],
  apply(ctx) {
    ctx.agentRuntime.registerAgent({
      id: 'support',
      prompt: 'You are a helpful support agent.',
      model: 'support-model',
    }, ctx.agentModels)
  },
}
