import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  boot: vi.fn(),
  installBundledPlugins: vi.fn(),
  installFailLoud: vi.fn(),
  loadLayeredEnv: vi.fn(),
  loadOverlayPatches: vi.fn(),
}))

vi.mock('@deepseek-ai/dsh-app-boot', () => ({
  boot: mocks.boot,
  installFailLoud: mocks.installFailLoud,
  loadLayeredEnv: mocks.loadLayeredEnv,
  loadOverlayPatches: mocks.loadOverlayPatches,
}))

vi.mock('../src/plugins.ts', () => ({
  installBundledPlugins: mocks.installBundledPlugins,
}))

import { launchAgent } from '../src/launch.ts'

interface FakeContext {
  readonly fiber: { readonly dispose: ReturnType<typeof vi.fn> }
  readonly loader: { readonly builtins: Record<string, unknown> }
  readonly provide: ReturnType<typeof vi.fn>
}

function context(dispose: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)): FakeContext {
  return {
    fiber: { dispose },
    loader: { builtins: {} },
    provide: vi.fn(),
  }
}

function signalHarness() {
  const listeners = new Map<string, () => void>()
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
    listeners.set(event, listener)
    return process
  }) as typeof process.on)
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  return { exit, listeners }
}

function configureBoot(host: FakeContext, root: FakeContext): void {
  mocks.boot.mockImplementation(async (
    _name: string,
    _rootConfig: string,
    _patches: unknown,
    configure: (ctx: FakeContext) => void,
  ) => {
    configure(host)
    return root
  })
}

describe('Karaka Agent launch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    mocks.boot.mockReset()
    mocks.installBundledPlugins.mockReset()
    mocks.installFailLoud.mockReset()
    mocks.loadLayeredEnv.mockReset().mockReturnValue({ source: 'test' })
    mocks.loadOverlayPatches.mockReset().mockImplementation((_name: string, path: string) => [path])
  })

  it('boots the layered composition and disposes it on SIGTERM', async () => {
    const host = context()
    const root = context()
    configureBoot(host, root)
    const { exit, listeners } = signalHarness()

    await expect(launchAgent('/deployment/karaka.cordis.yml')).resolves.toBe(root)

    expect(mocks.loadLayeredEnv).toHaveBeenCalledWith('karaka-agent')
    expect(mocks.loadOverlayPatches).toHaveBeenCalledTimes(3)
    expect(mocks.boot).toHaveBeenCalledWith(
      'karaka-agent',
      expect.stringMatching(/packages[/\\]karaka[/\\]agent[/\\]cordis\.yml$/u),
      expect.any(Array),
      expect.any(Function),
      expect.stringMatching(/^file:\/\/\/(?:[A-Za-z]:\/)?deployment\/karaka\.cordis\.yml$/u),
    )
    expect(mocks.installBundledPlugins).toHaveBeenCalledWith(host.loader)
    expect(host.provide).toHaveBeenCalledWith('launchEnvironment', { source: 'test' })

    listeners.get('SIGTERM')?.()
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(0) })
    expect(root.fiber.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['SIGTERM', 1],
    ['SIGINT', 130],
  ] as const)('maps a rejected %s cleanup to exit %s', async (signal, expected) => {
    const root = context(vi.fn().mockRejectedValue(new Error('dispose failed')))
    configureBoot(context(), root)
    const { exit, listeners } = signalHarness()
    await launchAgent('/deployment/karaka.cordis.yml')

    listeners.get(signal)?.()

    await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(expected) })
  })

  it('forces the signal exit code when shutdown is already pending', async () => {
    const dispose = vi.fn(() => new Promise<void>(() => {}))
    configureBoot(context(), context(dispose))
    const { exit, listeners } = signalHarness()
    await launchAgent('/deployment/karaka.cordis.yml')

    listeners.get('SIGTERM')?.()
    listeners.get('SIGINT')?.()

    expect(exit).toHaveBeenCalledWith(130)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('forces exit when cleanup exceeds the shutdown deadline', async () => {
    configureBoot(context(), context(vi.fn(() => new Promise<void>(() => {}))))
    const { exit, listeners } = signalHarness()
    await launchAgent('/deployment/karaka.cordis.yml')

    listeners.get('SIGINT')?.()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(exit).toHaveBeenCalledWith(130)
  })

  it('installs fail-loud cleanup before boot owns a context', async () => {
    const root = context()
    const host = context()
    let failLoudCleanup: (() => Promise<void>) | undefined
    let continueBoot: (() => void) | undefined
    mocks.installFailLoud.mockImplementation((_name: string, _process: NodeJS.Process, cleanup: () => Promise<void>) => {
      failLoudCleanup = cleanup
    })
    mocks.boot.mockImplementation(async (
      _name: string,
      _rootConfig: string,
      _patches: unknown,
      configure: (ctx: FakeContext) => void,
    ) => {
      await new Promise<void>((resolve) => { continueBoot = resolve })
      configure(host)
      return root
    })
    signalHarness()

    const launching = launchAgent('/deployment/karaka.cordis.yml')
    await expect(failLoudCleanup?.()).resolves.toBeUndefined()
    expect(root.fiber.dispose).not.toHaveBeenCalled()
    continueBoot?.()
    await launching

    await expect(failLoudCleanup?.()).resolves.toBeUndefined()
    expect(root.fiber.dispose).toHaveBeenCalledOnce()
  })
})
