import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: mocks.spawn }
})

import {
  initKarakaProject,
  karakaVersion,
  ownKarakaChild,
  prepareKarakaRuntime,
  startKarakaProject,
} from '@karaka-ai/cli'
import * as CliInvariant from '../src/invariant.ts'

function fakeChild(): EventEmitter & {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  })
}

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
    expect(agent).toContain('@karaka-ai/agent/persona')
    expect(agent).toContain('@karaka-ai/agent/agent-tool-presentation')
    expect(agent).toContain('allow: []')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.karaka/\n')
    expect(statSync(join(root, 'plugins')).isDirectory()).toBe(true)

    writeFileSync(join(root, 'agents/support/agent.cordis.yml'), '# developer edit\n')
    writeFileSync(join(root, '.gitignore'), 'node_modules/')
    initKarakaProject(target)
    expect(readFileSync(join(root, 'agents/support/agent.cordis.yml'), 'utf8')).toBe('# developer edit\n')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.karaka/\n')
    initKarakaProject(target)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.karaka/\n')
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@karaka-ai/agent': '0.1.2-alpha.2', '@karaka-ai/cli': '0.1.2-alpha.2' },
    })
  })

  it('prepares a private project home and resolves the Agent executable', () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-runtime-'))
    const prepared = prepareKarakaRuntime(project)

    if (process.platform !== 'win32') expect(statSync(prepared.home).mode & 0o077).toBe(0)
    expect(prepared.bin).toMatch(/packages[/\\]karaka[/\\]agent[/\\]lib[/\\]bin\.js$/u)
  })

  it('uses the process directory by default and preserves a newline-terminated gitignore', () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-default-runtime-'))
    vi.spyOn(process, 'cwd').mockReturnValue(project)
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n')

    expect(prepareKarakaRuntime().home).toBe(join(project, '.karaka'))
    initKarakaProject(project)
    expect(readFileSync(join(project, '.gitignore'), 'utf8')).toBe('node_modules/\n.karaka/\n')
  })

  it('starts the same-version Agent with default and explicit project settings', async () => {
    const project = mkdtempSync(join(tmpdir(), 'karaka-start-'))
    vi.spyOn(process, 'cwd').mockReturnValue(project)
    const inheritedAgentsDir = process.env.KARAKA_AGENTS_DIR
    delete process.env.KARAKA_AGENTS_DIR
    const first = fakeChild()
    mocks.spawn.mockReturnValueOnce(first)

    const defaultExit = startKarakaProject()
    const defaultCall = mocks.spawn.mock.calls.at(-1) as unknown as [
      string, string[], { cwd: string; env: NodeJS.ProcessEnv; stdio: string },
    ]
    expect(defaultCall[0]).toBe(process.execPath)
    expect(defaultCall[1]).toEqual([
      expect.stringMatching(/agent[/\\]lib[/\\]bin\.js$/u), '--config', join(project, 'karaka.cordis.yml'),
    ])
    expect(defaultCall[2]).toMatchObject({
      cwd: project,
      env: {
        KARAKA_HOME: join(project, '.karaka'),
        KARAKA_AGENTS_DIR: join(project, 'agents'),
      },
      stdio: 'inherit',
    })
    first.emit('exit', 0, null)
    await expect(defaultExit).resolves.toBe(0)

    process.env.KARAKA_AGENTS_DIR = '/deployment/agents'
    const second = fakeChild()
    mocks.spawn.mockReturnValueOnce(second)
    const explicitExit = startKarakaProject('deployment.yml')
    const explicitCall = mocks.spawn.mock.calls.at(-1) as unknown as [
      string, string[], { env: NodeJS.ProcessEnv },
    ]
    expect(explicitCall[0]).toBe(process.execPath)
    expect(explicitCall[1]).toEqual([expect.any(String), '--config', join(project, 'deployment.yml')])
    expect(explicitCall[2].env.KARAKA_AGENTS_DIR).toBe('/deployment/agents')
    second.emit('exit', null, null)
    await expect(explicitExit).resolves.toBe(1)

    if (inheritedAgentsDir === undefined) delete process.env.KARAKA_AGENTS_DIR
    else process.env.KARAKA_AGENTS_DIR = inheritedAgentsDir
  })
})

describe('Agent child ownership', () => {
  it('forwards supervisor termination and removes listeners', async () => {
    const signals = new EventEmitter()
    const child = fakeChild()
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
    const child = fakeChild()
    const exit = ownKarakaChild(child as never, signals)

    child.emit('exit', null, signal)

    await expect(exit).resolves.toBe(expected)
  })

  it('rejects spawn errors and ignores signals after the child has settled', async () => {
    const signals = new EventEmitter()
    const child = fakeChild()
    const exit = ownKarakaChild(child as never, signals)
    const error = new Error('spawn failed')

    child.emit('error', error)

    await expect(exit).rejects.toBe(error)
    child.exitCode = 1
    signals.emit('SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('uses the process signal source and preserves an unknown signal as a signal exit', async () => {
    const child = fakeChild()
    const exit = ownKarakaChild(child as never)

    child.emit('exit', null, 'UNKNOWN')

    await expect(exit).resolves.toBe(128)
  })

  it('does not forward after the child already carries a signal code', async () => {
    const signals = new EventEmitter()
    const child = fakeChild()
    child.signalCode = 'SIGTERM'
    const exit = ownKarakaChild(child as never, signals)

    signals.emit('SIGINT')
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('exit', null, 'SIGTERM')
    await expect(exit).resolves.toBe(143)
  })
})

describe('CLI invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(CliInvariant)

    expect(() => {
      ctx.invariants.register('@karaka-ai/cli', () => {})
    }).toThrow(/already registered/u)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
