import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootKaraka, parseStartArgs, runKaraka, type ShutdownSignal, type SignalSource } from '../src/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karaka-cli-'))
  roots.push(root)
  return root
}

class TestSignals implements SignalSource {
  private listeners = new Map<ShutdownSignal, () => void>()

  once(signal: ShutdownSignal, listener: () => void) {
    this.listeners.set(signal, listener)
  }

  off(signal: ShutdownSignal, listener: () => void) {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal)
  }

  has(signal: ShutdownSignal) {
    return this.listeners.has(signal)
  }

  send(signal: ShutdownSignal) {
    this.listeners.get(signal)?.()
  }
}

describe('Karaka CLI', () => {
  it('accepts only the explicit setup command', () => {
    expect(parseStartArgs(['start', '--config', 'karaka.yaml'])).toEqual({ config: 'karaka.yaml' })
    expect(parseStartArgs(['start', '--config=deployment.yml'])).toEqual({ config: 'deployment.yml' })
    expect(() => parseStartArgs(['start'])).toThrow('--config is required')
    expect(() => parseStartArgs(['serve', '--config', 'karaka.yaml'])).toThrow('Usage: karaka start')
    expect(() => parseStartArgs(['start', '--port', '3000'])).toThrow('unknown argument: --port')
  })

  it('keeps JSON as a low-level Include facility rather than a CLI setup format', async () => {
    await expect(bootKaraka({ config: 'karaka.json', cwd: temporaryRoot() }))
      .rejects.toThrow('setup must be a .yaml or .yml file')
  })

  it('loads plugins relative to the setup file and reverses their effects', async () => {
    const root = temporaryRoot()
    const deployment = join(root, 'deployment')
    await mkdir(deployment)
    writeFileSync(join(deployment, 'probe.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      'export function apply(ctx, config) {',
      "  ctx.provide('bootProbe', config.value)",
      "  ctx.effect(() => () => writeFileSync(new URL('./disposed', import.meta.url), 'yes'))",
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(deployment, 'karaka.yaml'), [
      '- name: ./probe.mjs',
      '  config:',
      '    value: ready',
      '',
    ].join('\n'))

    const ctx = await bootKaraka({ config: 'deployment/karaka.yaml', cwd: root })
    expect(ctx.get('bootProbe')).toBe('ready')
    await ctx.fiber.dispose()
    expect(readFileSync(join(deployment, 'disposed'), 'utf8')).toBe('yes')
  })

  it('stays active until a signal and then disposes the whole graph', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'probe.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      'export function apply(ctx) {',
      "  ctx.on('exit', signal => writeFileSync(new URL('./signal', import.meta.url), signal))",
      "  ctx.effect(() => () => writeFileSync(new URL('./disposed', import.meta.url), 'yes'))",
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'karaka.yaml'), '- name: ./probe.mjs\n')
    const signals = new TestSignals()

    const running = runKaraka({ config: 'karaka.yaml', cwd: root }, signals)
    await vi.waitFor(() => expect(signals.has('SIGTERM')).toBe(true))
    signals.send('SIGTERM')

    await expect(running).resolves.toBe('SIGTERM')
    expect(readFileSync(join(root, 'signal'), 'utf8')).toBe('SIGTERM')
    expect(readFileSync(join(root, 'disposed'), 'utf8')).toBe('yes')
    expect(signals.has('SIGINT')).toBe(false)
  })

  it('disposes a partial graph when startup fails', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'started.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      "export function apply(ctx) { ctx.effect(() => () => writeFileSync(new URL('./rolled-back', import.meta.url), 'yes')) }",
      '',
    ].join('\n'))
    writeFileSync(join(root, 'failed.mjs'), "export function apply() { throw new Error('rejected plugin') }\n")
    writeFileSync(join(root, 'karaka.yaml'), [
      '- name: ./started.mjs',
      '- name: ./failed.mjs',
      '',
    ].join('\n'))

    await expect(bootKaraka({ config: 'karaka.yaml', cwd: root })).rejects.toThrow('rejected plugin')
    expect(readFileSync(join(root, 'rolled-back'), 'utf8')).toBe('yes')
  })
})
