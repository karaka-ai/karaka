#!/usr/bin/env node
/** Karaka profile initialization followed by the unchanged DSH CLI. */
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { initializeProfile } from './profile.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
let patch: string | undefined
for (let i = 0; i < args.length; i++) {
  const argument = args[i]
  const next = args[i + 1]
  if (argument !== '--config' || next === undefined || patch !== undefined) {
    throw new Error('Usage: karaka-agent [--config <Cordis patch>]')
  }
  patch = resolve(next)
  i += 1
}
const home = resolve(process.env.KARAKA_HOME ?? process.env.DSH_HOME ?? '.karaka')
await initializeProfile(home, packageRoot)
const dshBin = resolve(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const child = spawn(process.execPath, [dshBin, '--profile', 'karaka', ...patch === undefined ? [] : ['--patch', patch]], {
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: home },
})
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill(stopping ? 'SIGKILL' : signal)
    stopping = true
  })
}
child.once('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (128 + (signal === null ? 0 : constants.signals[signal]))
})
