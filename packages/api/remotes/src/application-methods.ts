/** Application chat methods whose owner is derived from authenticated invocation context. */
export const APPLICATION_REMOTE_METHODS = [
  'applicationAgents', 'applicationCreate', 'applicationPrompt',
  'applicationHistory', 'applicationFollow', 'applicationCancel',
] as const

/** Application chat capability selected by a deployment. */
export type ApplicationRemoteMethod = typeof APPLICATION_REMOTE_METHODS[number]
