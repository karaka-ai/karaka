import { Duplex, PassThrough } from 'node:stream'
import { expect, it, onTestFinished } from 'vitest'
import { JsonChannel } from '../src/channel.ts'
import { runNodeMain } from '../src/process.ts'
import type { ProgramProcess } from '../src/process.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'

function endpoints() {
  const first = new PassThrough()
  const second = new PassThrough()
  const child = Duplex.from({ readable: first, writable: second })
  const host = Duplex.from({ readable: second, writable: first })
  child.on('error', () => {})
  host.on('error', () => {})
  onTestFinished(() => { child.destroy(); host.destroy() })
  return { child, host }
}
function processState(): ProgramProcess { return { env: { FIXTURE_SECRET: 'test' }, stdout: { write: () => true }, stderr: { write: () => true }, exitCode: undefined } }

it('clears process environment, dispatches a binding reply and flushes the terminal frame', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const nativeEnvironment = state.env
  nativeEnvironment.SystemRoot = 'C:\\Windows'
  nativeEnvironment.PATH = '/native/bin'
  nativeEnvironment.TMP = 'C:\\sandbox-temp'
  nativeEnvironment.TEMP = 'C:\\sandbox-temp'
  const messages: Record<string, unknown>[] = []
  const peer = new JsonChannel(host, 4096, (raw) => {
    const message = raw as Record<string, unknown>
    messages.push(message)
    if (message.type === 'ready') void peer.send({ type: 'boot', data: { code: 'console.log("ready"); return await tools.echo({});', namespaces: [{ global: 'tools', names: ['echo'] }], maxOutputBytes: 1024 } })
    if (message.type === 'call') void peer.send({ type: 'reply', id: message.id, ok: true, value: encodePtcJsonWire(42) })
  }, () => {})
  onTestFinished(() => { peer.close() })
  await runNodeMain(child, 4096, state)
  expect(state.env).toEqual({})
  expect(state.env).not.toBe(nativeEnvironment)
  expect(Object.getPrototypeOf(state.env)).toBeNull()
  expect(nativeEnvironment).toEqual({ SystemRoot: 'C:\\Windows', PATH: '/native/bin', TMP: 'C:\\sandbox-temp', TEMP: 'C:\\sandbox-temp' })
  expect(state.exitCode).toBeUndefined()
  expect(decodePtcJsonWire(messages.find(message => message.type === 'done')?.value)).toBe(42)
})

it.each([0, -1, 1.5, 4294967296])('rejects an invalid bootstrap frame limit %i', async (limit) => {
  const { child } = endpoints()
  await expect(runNodeMain(child, limit, processState())).rejects.toThrow('invalid control message limit')
})

it('rejects an unexpected first control frame', async () => {
  const { child, host } = endpoints()
  const peer = new JsonChannel(host, 4096, () => { void peer.send({ type: 'reply' }) }, () => {})
  onTestFinished(() => { peer.close() })
  await expect(runNodeMain(child, 4096, processState())).rejects.toThrow('expected program boot')
})

it('records an I/O failure before the boot frame', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const peer = new JsonChannel(host, 4096, () => { peer.close() }, () => {})
  await expect(runNodeMain(child, 4096, state)).rejects.toBeInstanceOf(Error)
  expect(state.exitCode).toBe(1)
})

it('contains program writes that exceed queued control output', async () => {
  const { child, host } = endpoints()
  const state = processState()
  const peer = new JsonChannel(host, 1024, (raw) => {
    if ((raw as { type: string }).type === 'ready') void peer.send({ type: 'boot', data: { code: 'for(let i=0;i<30;i++) console.log("x".repeat(100));', namespaces: [], maxOutputBytes: 8000 } })
  }, () => {})
  onTestFinished(() => { peer.close() })
  await runNodeMain(child, 1024, state)
  expect(state.exitCode).toBe(1)
})
