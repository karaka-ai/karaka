import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { badRequest, json, readObject, writeEvent } from '../src/http.ts'

function request(): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage
}

function response(write = vi.fn(() => true)): {
  readonly value: ServerResponse
  readonly emitter: EventEmitter
  readonly write: ReturnType<typeof vi.fn>
  readonly writeHead: ReturnType<typeof vi.fn>
  readonly end: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter()
  const writeHead = vi.fn()
  const end = vi.fn()
  return {
    value: Object.assign(emitter, { write, writeHead, end }) as unknown as ServerResponse,
    emitter,
    write,
    writeHead,
    end,
  }
}

describe('HTTP request bodies', () => {
  it('reads Buffer and Uint8Array chunks into one object', async () => {
    for (const chunk of [Buffer.from('{"ok":true}'), new TextEncoder().encode('{"ok":true}')]) {
      const input = request()
      const body = readObject(input, 100, new AbortController().signal)
      input.emit('data', chunk)
      input.emit('end')
      await expect(body).resolves.toEqual({ ok: true })
      expect(input.listenerCount('data')).toBe(0)
    }
  })

  it.each(['null', '1', '[]'])('rejects non-object JSON %s', async (source) => {
    const input = request()
    const body = readObject(input, 100, new AbortController().signal)
    input.emit('data', Buffer.from(source))
    input.emit('end')
    await expect(body).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects oversized, malformed, and non-Error parser failures', async () => {
    const oversized = request()
    const oversizedBody = readObject(oversized, 1, new AbortController().signal)
    oversized.emit('data', Buffer.from('{}'))
    await expect(oversizedBody).rejects.toThrow(/exceeds 1 byte/u)

    const malformed = request()
    const malformedBody = readObject(malformed, 100, new AbortController().signal)
    malformed.emit('data', Buffer.from('{'))
    malformed.emit('end')
    await expect(malformedBody).rejects.toThrow()

    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw 'invalid' })
    const unusual = request()
    const unusualBody = readObject(unusual, 100, new AbortController().signal)
    unusual.emit('data', Buffer.from('{}'))
    unusual.emit('end')
    await expect(unusualBody).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    parse.mockRestore()
  })

  it('propagates request errors and aborts', async () => {
    const failed = request()
    const failure = readObject(failed, 100, new AbortController().signal)
    failed.emit('error', new Error('socket failed'))
    await expect(failure).rejects.toThrow('socket failed')

    const unusual = request()
    const unusualFailure = readObject(unusual, 100, new AbortController().signal)
    unusual.emit('error', 'socket failed')
    await expect(unusualFailure).rejects.toThrow('socket failed')

    const aborted = request()
    const abort = readObject(aborted, 100, new AbortController().signal)
    aborted.emit('aborted')
    await expect(abort).rejects.toThrow(/body was aborted/u)
  })

  it('rejects active and already-aborted signals', async () => {
    for (const reason of [new Error('cancelled'), 'cancelled']) {
      const controller = new AbortController()
      const body = readObject(request(), 100, controller.signal)
      controller.abort(reason)
      await expect(body).rejects.toMatchObject(reason instanceof Error ? { message: 'cancelled' } : {})
    }

    const signal = Object.assign(new EventTarget(), { aborted: true, reason: undefined }) as AbortSignal
    await expect(readObject(request(), 100, signal)).rejects.toThrow(/body was cancelled/u)
  })
})

describe('SSE response writes', () => {
  const event = { type: 'snapshot' as const, cursor: 1 }

  it('writes immediately when the response accepts the frame', async () => {
    const output = response()
    await writeEvent(output.value, event, new AbortController().signal)
    expect(output.write).toHaveBeenCalledWith('data: {"type":"snapshot","cursor":1}\n\n')
  })

  it('waits for drain after backpressure', async () => {
    const output = response(vi.fn(() => false))
    const writing = writeEvent(output.value, event, new AbortController().signal)
    output.emitter.emit('drain')
    await expect(writing).resolves.toBeUndefined()
  })

  it('rejects close and response errors while draining', async () => {
    for (const [name, value] of [
      ['close', undefined],
      ['error', new Error('write failed')],
    ] as const) {
      const output = response(vi.fn(() => false))
      const writing = writeEvent(output.value, event, new AbortController().signal)
      output.emitter.emit(name, value)
      await expect(writing).rejects.toThrow(name === 'close' ? /closed/u : 'write failed')
    }
  })

  it('rejects active and already-aborted writes', async () => {
    for (const reason of [new Error('cancelled'), 'cancelled']) {
      const output = response(vi.fn(() => false))
      const controller = new AbortController()
      const writing = writeEvent(output.value, event, controller.signal)
      controller.abort(reason)
      await expect(writing).rejects.toThrow('cancelled')
    }

    const output = response(vi.fn(() => false))
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(writeEvent(output.value, event, controller.signal)).rejects.toThrow('already cancelled')
  })
})

describe('HTTP responses', () => {
  it('serializes JSON and brands bad requests', () => {
    const output = response()
    json(output.value, 202, { accepted: true })
    expect(output.writeHead).toHaveBeenCalledWith(202, { 'content-type': 'application/json; charset=utf-8' })
    expect(output.end).toHaveBeenCalledWith('{"accepted":true}')
    expect(badRequest('invalid')).toMatchObject({ message: 'invalid', code: 'BAD_REQUEST' })
  })
})
