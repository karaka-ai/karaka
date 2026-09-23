/** HTTP byte limits and response settlement without host ports or process-global hooks. */
import { EventEmitter, getEventListeners } from 'node:events'
import { IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { badRequest, json, readObject, writeEvent, writeJsonEvent } from '../src/http.ts'

function requestBody() {
  const socket = new Socket()
  const request = new IncomingMessage(socket)
  onTestFinished(() => { request.destroy(); socket.destroy() })
  return request
}

/** Model only the response callbacks used by the framing functions. */
function responseBody(accept = true) {
  const response = Object.assign(new EventEmitter(), {
    write: vi.fn((_text: string) => accept),
    writeHead: vi.fn(),
    end: vi.fn(),
  }) satisfies EventEmitter & Pick<ServerResponse, 'write' | 'writeHead' | 'end'>
  return { response, http: response as ServerResponse }
}

function expectRequestCleanup(request: IncomingMessage, signal: AbortSignal) {
  for (const event of ['data', 'end', 'error', 'aborted']) expect(request.listenerCount(event)).toBe(0)
  expect(getEventListeners(signal, 'abort')).toHaveLength(0)
}

describe('JSON request bodies', () => {
  it('accepts a split multibyte object exactly at its byte limit', async () => {
    const request = requestBody()
    const bytes = Buffer.from('{"text":"猫"}')
    const signal = new AbortController().signal
    const pending = readObject(request, bytes.length, signal)
    request.emit('data', bytes.subarray(0, 10))
    request.emit('data', new Uint8Array(bytes.subarray(10)))
    request.emit('end')
    await expect(pending).resolves.toEqual({ text: '猫' })
    expectRequestCleanup(request, signal)
  })

  it.each(['', '{', 'null', '[]', '"text"', '1'])('rejects non-object JSON %j', async (body) => {
    const request = requestBody()
    const signal = new AbortController().signal
    const rejected = expect(readObject(request, 100, signal)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    request.emit('data', Buffer.from(body))
    request.emit('end')
    await rejected
    expectRequestCleanup(request, signal)
  })

  it('rejects a body one byte past the limit and releases listeners', async () => {
    const request = requestBody()
    const signal = new AbortController().signal
    const rejected = expect(readObject(request, 1, signal)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    request.emit('data', Buffer.from('{}'))
    await rejected
    expectRequestCleanup(request, signal)
  })

  it.each(['error', 'aborted'] as const)('settles on request %s', async (event) => {
    const request = requestBody()
    const signal = new AbortController().signal
    const rejected = expect(readObject(request, 100, signal)).rejects.toThrow(event === 'error' ? 'network failure' : 'aborted')
    request.emit(event, new Error('network failure'))
    await rejected
    expectRequestCleanup(request, signal)
  })

  it('names cancellation when the AbortSignal carries a null reason', async () => {
    const request = requestBody()
    const controller = new AbortController()
    const rejected = expect(readObject(request, 100, controller.signal)).rejects.toThrow('request body was cancelled')
    controller.abort(null)
    await rejected
    expectRequestCleanup(request, controller.signal)
  })

  it.each([false, true])('honors cancellation, already aborted: %s', async (alreadyAborted) => {
    const request = requestBody()
    const controller = new AbortController()
    if (alreadyAborted) controller.abort('cancelled by caller')
    const rejected = expect(readObject(request, 100, controller.signal)).rejects.toThrow('cancelled by caller')
    if (!alreadyAborted) controller.abort('cancelled by caller')
    await rejected
    expectRequestCleanup(request, controller.signal)
  })
})

describe('JSON and SSE responses', () => {
  it('sends a complete JSON response with the supplied status', () => {
    const { response, http } = responseBody()
    json(http, 403, { code: 'CHAT_FORBIDDEN' })
    expect(response.writeHead).toHaveBeenCalledWith(403, { 'content-type': 'application/json; charset=utf-8' })
    expect(response.end).toHaveBeenCalledWith('{"code":"CHAT_FORBIDDEN"}')
    expect(badRequest('invalid body')).toMatchObject({ message: 'invalid body', code: 'BAD_REQUEST' })
  })

  it('frames an accepted application event without waiting for drain', async () => {
    const { response, http } = responseBody()
    const signal = new AbortController().signal
    await writeEvent(http, { type: 'snapshot', cursor: 0 }, signal)
    expect(response.write).toHaveBeenCalledWith('data: {"type":"snapshot","cursor":0}\n\n')
    expect(response.eventNames()).toEqual([])
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it.each(['drain', 'close', 'error', 'abort'] as const)('settles a blocked write on %s and removes listeners', async (event) => {
    const { response, http } = responseBody(false)
    const controller = new AbortController()
    const pending = writeJsonEvent(http, { ok: true, value: '猫' }, controller.signal)
    const settled = event === 'drain' ? expect(pending).resolves.toBeUndefined() : expect(pending).rejects.toThrow()
    expect(response.listenerCount('drain')).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    if (event === 'abort') controller.abort(new Error('cancelled'))
    else response.emit(event, new Error('network failure'))
    await settled
    expect(response.eventNames()).toEqual([])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('rejects a blocked write when cancellation predates the drain wait', async () => {
    const { response, http } = responseBody(false)
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(writeJsonEvent(http, {}, controller.signal)).rejects.toThrow('SSE write cancelled')
    expect(response.eventNames()).toEqual([])
  })
})
