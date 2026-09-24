import { Context } from '@deepseek-ai/cordis'
import { Loader, type EntryOptions, type JsExpr } from '@deepseek-ai/cordis-plugin-loader'
import type { AppReady } from '@deepseek-ai/dsh-cmdline'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as startup from '../src/startup.ts'

function readiness() {
  const listeners = new Set<() => void>()
  const service: AppReady = {
    onReady(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    service,
    listeners,
    commit() {
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  const ready = readiness()
  const exit = vi.fn<(code: number) => void>()
  ctx.provide('appReady', ready.service)
  ctx.provide('appExit', exit)
  ctx.loader.builtins.startup = startup
  return { ctx, ready, exit }
}

// Include preserves YAML !!js nodes until Entry.disabled evaluates them.
function withDisabledExpression(options: EntryOptions, source: string): EntryOptions {
  Reflect.set(options, 'disabled', { __jsExpr: source } satisfies JsExpr)
  return options
}

function guard(): EntryOptions {
  return { id: 'startup', name: 'cordis:startup' }
}

it.each(['appReady', 'appExit', 'both'] as const)('rejects a missing %s launcher service in the startup owner', async (missing) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  if (missing === 'appExit') ctx.provide('appReady', readiness().service)
  if (missing === 'appReady') ctx.provide('appExit', vi.fn())
  expect(() => { startup.apply(ctx) }).toThrow('requires launcher readiness and exit services')
  expect(ctx.get('karakaStartup')).toBeUndefined()
})

it('admits only after enabled Loader entries activate and honors effective disabled expressions', async () => {
  const { ctx, ready, exit } = await fixture()
  const activated = vi.fn()
  ctx.loader.builtins.healthy = () => { activated() }
  await ctx.loader.root.update([
    guard(),
    withDisabledExpression({ id: 'healthy', name: 'cordis:healthy' }, 'false'),
    { id: 'disabled-import', name: 'cordis:missing', disabled: true },
    withDisabledExpression({ id: 'conditional-import', name: 'cordis:missing' }, 'true'),
  ])
  await ctx.loader.await()
  expect(activated).toHaveBeenCalledOnce()
  const admission = ctx.karakaStartup
  expect(admission.ready).toBe(false)
  expect(exit).not.toHaveBeenCalled()
  ready.commit()
  expect(admission.ready).toBe(true)
  expect(exit).not.toHaveBeenCalled()
  await ctx.loader.resolve('startup').fiber!.dispose()
  expect(admission.ready).toBe(false)
  expect(ctx.get('karakaStartup')).toBeUndefined()
  expect(ready.listeners.size).toBe(0)
})

it('withdraws a pending readiness callback when the guard is disposed', async () => {
  const { ctx, ready, exit } = await fixture()
  await ctx.loader.root.update([guard()])
  await ctx.loader.await()
  const admission = ctx.karakaStartup
  expect(ready.listeners.size).toBe(1)
  await ctx.loader.resolve('startup').fiber!.dispose()
  expect(ready.listeners.size).toBe(0)
  ready.commit()
  expect(admission.ready).toBe(false)
  expect(exit).not.toHaveBeenCalled()
})

it('keeps admission closed and requests failure exit when identity or authorization dependencies fail', async () => {
  const { ctx, ready, exit } = await fixture()
  const entered = vi.fn()
  ctx.loader.builtins.failedIdentity = () => { throw new Error('identity storage unavailable') }
  ctx.loader.builtins.needsAuth = { inject: ['serverAuth'], apply: entered }
  // A present service can still reject dependent activation through its check.
  ctx.reflect.provide('startup-held', {}, () => false)
  ctx.loader.builtins.held = { inject: ['startup-held'], apply: entered }
  await ctx.loader.root.update([
    guard(),
    { id: 'identity', name: 'cordis:failedIdentity' },
    { id: 'application', name: 'cordis:needsAuth' },
    { id: 'held', name: 'cordis:held' },
    { id: 'missing-import', name: 'cordis:missing' },
  ])
  await ctx.loader.await()
  expect(ctx.karakaStartup.ready).toBe(false)
  expect(entered).not.toHaveBeenCalled()
  ready.commit()
  expect(ctx.karakaStartup.ready).toBe(false)
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  const diagnostic = ctx.logger.buffer.flatMap(message => message.args as unknown[]).find(
    (value: unknown): value is string => typeof value === 'string' && value.startsWith('Karaka startup failed:'),
  )
  expect(diagnostic).toContain('identity (cordis:failedIdentity): inactive fiber (state 3)')
  expect(diagnostic).toContain('application (cordis:needsAuth): pending (waiting for: serverAuth)')
  expect(diagnostic).toContain('held (cordis:held): pending (waiting for: unknown)')
  expect(diagnostic).toContain('missing-import (cordis:missing): failed to import')
})

it.each([
  ['(() => { throw new Error("bad disabled expression") })()', 'bad disabled expression'],
  ['(() => { throw "disabled string failure" })()', 'disabled string failure'],
])('rejects a disabled expression that throws: %s', async (source, message) => {
  const { ctx, ready, exit } = await fixture()
  const rows: EntryOptions[] = [guard(), { id: 'conditional', name: 'cordis:missing', disabled: true }]
  await ctx.loader.root.update(rows)
  await ctx.loader.await()
  // Re-evaluate the effective getter at the launcher's settled-tree boundary.
  withDisabledExpression(ctx.loader.resolve('conditional').options, source)
  ready.commit()
  expect(ctx.karakaStartup.ready).toBe(false)
  expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(ctx.logger.buffer.flatMap(record => record.args as unknown[])).toContain(
    `Karaka startup failed:\nconditional (cordis:missing): disabled expression failed: ${message}`,
  )
})
