import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  initKarakaProject,
  karakaVersion,
  ownKarakaChild,
  prepareKarakaRuntime,
} from '@karaka/cli'

describe('karaka init', () => {
  it('reports the installed CLI version used by release probes', () => {
    expect(karakaVersion).toBe('0.1.2-alpha.2')
  })

  it('creates Agent configuration without overwriting project edits', () => {
    const target = join(mkdtempSync(join(tmpdir(), 'karaka-init-')), 'agents-app')
    const root = initKarakaProject(target)

    expect(readFileSync(join(root, 'karaka.cordis.yml'), 'utf8')).not.toContain('@deepseek-ai/')
    expect(readFileSync(join(root, 'agents/support/preset.yml'), 'utf8')).toContain('name: Support')
    const agent = readFileSync(join(root, 'agents/support/agent.cordis.yml'), 'utf8')
    expect(agent).toContain('@karaka/agent/persona')
    expect(agent).toContain('@karaka/agent/agent-tool-presentation')
    expect(agent).toContain('allow: []')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.karaka/\n')

    writeFileSync(join(root, 'agents/support/agent.cordis.yml'), '# developer edit\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.karaka/\n')
    initKarakaProject(target)
    expect(readFileSync(join(root, 'agents/support/agent.cordis.yml'), 'utf8')).toBe('# developer edit\n')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.karaka/\n')
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@karaka/cli': '0.1.2-alpha.2' },
    })
  })

  it('prepares a private project home and resolves the Agent executable', () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-runtime-'))
    const prepared = prepareKarakaRuntime(project)

    if (process.platform !== 'win32') expect(statSync(prepared.home).mode & 0o077).toBe(0)
    expect(prepared.bin).toMatch(/packages[/\\]karaka[/\\]agent[/\\]lib[/\\]bin\.js$/u)
  })
})

describe('Agent child ownership', () => {
  it('forwards supervisor termination and removes listeners', async () => {
    const signals = new EventEmitter()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    })
    const exit = ownKarakaChild(child as never, signals)

    signals.emit('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    signals.emit('SIGINT')
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    signals.emit('SIGINT')
    expect(child.kill).toHaveBeenCalledTimes(2)
    child.emit('exit', 0, null)

    await expect(exit).resolves.toBe(0)
    expect(signals.listenerCount('SIGTERM')).toBe(0)
    expect(signals.listenerCount('SIGINT')).toBe(0)
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('preserves the %s child exit status', async (signal, expected) => {
    const signals = new EventEmitter()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    })
    const exit = ownKarakaChild(child as never, signals)

    child.emit('exit', null, signal)

    await expect(exit).resolves.toBe(expected)
  })
})
