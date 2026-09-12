#!/usr/bin/env node
/** Karaka profile initialization followed by the unchanged DSH CLI. */
import { mkdir, readFile, realpath, writeFile, symlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
let patch: string | undefined
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1] !== undefined && patch === undefined) patch = resolve(args[++i]!)
  else throw new Error('Usage: karaka-agent [--config <Cordis patch>]')
}
const home = resolve(process.env.KARAKA_HOME ?? process.env.DSH_HOME ?? '.karaka')
const profile = resolve(home, 'profiles/karaka')
await mkdir(profile, { recursive: true, mode: 0o700 })
const manifestPath = resolve(profile, 'package.json')
try {
  await writeFile(manifestPath, JSON.stringify({
    name: 'karaka-profile', private: true,
    dependencies: { '@karaka-ai/agent': `file:${packageRoot}` },
    dsh: { profile: { bundles: ['@karaka-ai/agent'], patchReload: 'startup' } },
  }, null, 2) + '\n', { flag: 'wx' })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.dsh?.profile?.bundles?.includes('@karaka-ai/agent')) throw new Error('Existing Karaka profile does not select @karaka-ai/agent')
}
const link = resolve(profile, 'node_modules/@karaka-ai/agent')
await mkdir(dirname(link), { recursive: true })
try { await symlink(packageRoot, link, process.platform === 'win32' ? 'junction' : 'dir') }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  if (await realpath(link) !== await realpath(packageRoot)) {
    throw new Error('Existing Karaka profile points to another installation; update its package link explicitly before launching')
  }
}
const dshBin = resolve(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const child = spawn(process.execPath, [dshBin, '--profile', 'karaka', ...patch === undefined ? [] : ['--patch', patch]], {
  stdio: 'inherit',
  env: {
    ...process.env, DSH_HOME: home,
    KARAKA_PRESET_ROOT: resolve(packageRoot, 'presets'),
    KARAKA_AGENTS_DIR: process.env.KARAKA_AGENTS_DIR ?? resolve(process.cwd(), 'agents'),
  },
})
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill(stopping ? 'SIGKILL' : signal)
    stopping = true
  })
}
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (128 + (signal === null ? 0 : constants.signals[signal]))
})
