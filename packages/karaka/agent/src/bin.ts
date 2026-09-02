#!/usr/bin/env node
/** Self-executing entry for the Karaka Agent process. */

/* v8 ignore file -- packed-process tests exercise this entry. */

import { isAbsolute, resolve } from 'node:path'

function readConfig(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--config' || args[1] === undefined || !isAbsolute(args[1])) {
    throw new Error('usage: @karaka-ai/agent/bin --config <absolute path>')
  }
  return args[1]
}

const configPath = readConfig(process.argv.slice(2))
const home = process.env.KARAKA_HOME
if (home === undefined || home.length === 0) {
  throw new Error('KARAKA_HOME is required')
}
process.env.DSH_HOME = resolve(home)

const { launchAgent } = await import('./launch.ts')
await launchAgent(configPath)
