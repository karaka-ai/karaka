#!/usr/bin/env node

import { parseStartArgs, runKaraka, START_USAGE } from './index.ts'

const args = process.argv.slice(2)

if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write(`${START_USAGE}\n`)
} else {
  try {
    const signal = await runKaraka(parseStartArgs(args))
    process.exitCode = signal === 'SIGINT' ? 130 : 143
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`karaka: ${detail}\n`)
    process.exitCode = 1
  }
}
