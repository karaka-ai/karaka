import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, '.artifacts')
const consumer = mkdtempSync(join(tmpdir(), 'karaka-packed-consumer-'))

try {
  const dependencies = {}
  const tarballs = new Set(readdirSync(artifacts))
  for (const entry of readdirSync(resolve(root, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = JSON.parse(readFileSync(resolve(root, 'vendor', entry.name, 'package.json'), 'utf8'))
    const tarball = `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`
    if (!tarballs.has(tarball)) throw new Error(`missing package artifact: ${tarball}`)
    dependencies[manifest.name] = `file:${resolve(artifacts, tarball)}`
  }

  writeFileSync(resolve(consumer, 'package.json'), `${JSON.stringify({
    name: 'karaka-packed-consumer',
    private: true,
    type: 'module',
    dependencies,
    devDependencies: { '@types/node': '^22.20.0' },
  }, null, 2)}\n`)
  writeFileSync(resolve(consumer, 'pnpm-workspace.yaml'), `${JSON.stringify({ overrides: dependencies }, null, 2)}\n`)
  writeFileSync(resolve(consumer, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      types: ['node'],
    },
    include: ['smoke.mts', 'smoke.cts'],
  }, null, 2)}\n`)
  writeFileSync(resolve(consumer, 'smoke.mts'), `
import { Context } from '@karaka/cordis'
import * as CosmoKit from '@karaka/cosmokit'
import Group from '@karaka/cordis-plugin-group'
import Hmr from '@karaka/cordis-plugin-hmr'
import Include from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'
import LoggerConsole from '@karaka/cordis-plugin-logger-console'
import Timer from '@karaka/cordis-plugin-timer'
import Schema from '@karaka/schemastery'

const exports = [Context, Group, Hmr, Include, Loader, LoggerConsole, Timer, Schema]
if (exports.some(value => typeof value !== 'function')) throw new Error('a package entry point did not export its public constructor or plugin')
if (Object.keys(CosmoKit).length === 0) throw new Error('CosmoKit exported no utilities')

const ctx = new Context()
await ctx.plugin(Timer)
await ctx.fiber.dispose()
`)
  writeFileSync(resolve(consumer, 'smoke.cts'), `
import Schema = require('@karaka/schemastery')

const schema = Schema.string()
if (schema('packed') !== 'packed') throw new Error('the CommonJS Schemastery export failed')
`)
  writeFileSync(resolve(consumer, 'smoke.cjs'), `
const Schema = require('@karaka/schemastery')
if (Schema.string()('packed') !== 'packed') throw new Error('the CommonJS Schemastery export failed')
`)

  run('pnpm', ['install', '--prefer-offline', '--ignore-scripts', '--strict-peer-dependencies'], consumer)
  run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(consumer, 'tsconfig.json')], consumer)
  run(process.execPath, [resolve(consumer, 'smoke.mts')], consumer)
  run(process.execPath, [resolve(consumer, 'smoke.cjs')], consumer)
} finally {
  rmSync(consumer, { recursive: true, force: true })
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
