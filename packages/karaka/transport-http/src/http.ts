/** Node HTTP body and SSE operations owned by the Karaka application transport. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApplicationChatEvent } from '@karaka-ai/sdk'

/** Read and validate one object-rooted JSON request body. */
export function readObject(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      signal.removeEventListener('abort', onSignal)
    }
    const fail = (error: unknown): void => {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onData = (chunk: Buffer | Uint8Array): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > maxBytes) {
        fail(badRequest(`request body exceeds ${String(maxBytes)} bytes`))
        return
      }
      chunks.push(bytes)
    }
    const onEnd = (): void => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('request body must be an object')
        }
        cleanup()
        resolve(parsed as Record<string, unknown>)
      } catch (error: unknown) {
        fail(badRequest(error instanceof Error ? error.message : 'invalid JSON request body'))
      }
    }
    const onError = (error: Error): void => { fail(error) }
    const onAborted = (): void => { fail(new Error('request body was aborted')) }
    const onSignal = (): void => { fail(signal.reason ?? new Error('request body was cancelled')) }
    if (signal.aborted) {
      onSignal()
      return
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
    signal.addEventListener('abort', onSignal, { once: true })
  })
}

/** Write one SSE event and wait for transport backpressure when necessary. */
export async function writeEvent(
  response: ServerResponse,
  event: ApplicationChatEvent,
  signal: AbortSignal,
): Promise<void> {
  if (response.write(`data: ${JSON.stringify(event)}\n\n`)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new Error('SSE response closed before draining')) }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('SSE write cancelled'))
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/** Send one JSON response. */
export function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

/** Create a transport error that maps to the public bad-request response. */
export function badRequest(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST' })
}
