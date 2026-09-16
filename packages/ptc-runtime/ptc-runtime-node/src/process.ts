/** Node child execution over an inherited control channel; no Harness services run here. */
import type { Duplex } from 'node:stream'
import { JsonChannel } from './channel.ts'
import { runProgram } from './bootstrap.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import type { PatchableStream } from './bootstrap.ts'
import type { ReplyMessage, ProgramBootData, ProgramToHost } from './protocol.ts'

/** Process-owned environment and output streams consumed by the child bootstrap. */
export interface ProgramProcess {
  env: NodeJS.ProcessEnv
  stdout: PatchableStream
  stderr: PatchableStream
  exitCode: string | number | null | undefined
}

/**
 * Run one host-supplied program after the control handshake.
 * @param stream - Inherited, already-adopted control endpoint.
 * @param maxMessageBytes - Host-validated maximum frame and queued-write bytes.
 * @param processState - Environment, output streams and exit status of this Node child.
 * @returns After the program has settled and its control output has flushed.
 */
export async function runNodeMain(stream: Duplex, maxMessageBytes: number, processState: ProgramProcess): Promise<void> {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0 || maxMessageBytes > 0xffff_ffff) throw new Error('invalid control message limit')
  for (const key of Object.keys(processState.env)) {
    if (!STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase())) Reflect.deleteProperty(processState.env, key)
  }
  // Windows native process creation still needs SystemRoot in the OS environment.
  processState.env = Object.create(null) as NodeJS.ProcessEnv
  const boot = Promise.withResolvers<ProgramBootData>()
  const listeners: Array<(message: ReplyMessage) => void> = []
  let started = false
  let failed = false
  const channel = new JsonChannel(stream, maxMessageBytes, (raw) => {
    if (!started) {
      started = true
      if (typeof raw !== 'object' || raw === null || (raw as { type?: unknown }).type !== 'boot') {
        boot.reject(new Error('expected program boot frame'))
        return
      }
      boot.resolve((raw as { data: ProgramBootData }).data)
      return
    }
    for (const listener of listeners) listener(raw as ReplyMessage)
  }, (error) => {
    failed = true
    boot.reject(error)
    channel.close()
    processState.exitCode = 1
  })
  const pending = new Set<Promise<void>>()
  const send = (message: ProgramToHost): void => {
    const task = channel.send(message).catch(() => {
      failed = true
      channel.close()
      processState.exitCode = 1
    }).finally(() => { pending.delete(task) })
    pending.add(task)
  }
  try {
    await channel.send({ type: 'ready' })
    const data = await boot.promise
    await runProgram({
      postMessage: send,
      on: (_event, listener) => { listeners.push(listener) },
    }, data, { stdout: processState.stdout, stderr: processState.stderr })
    while (pending.size > 0) await Promise.all(pending)
    await channel.drain()
  } finally {
    channel.close()
    // Transport callbacks can set failed while the awaited program executes.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (failed) processState.exitCode = 1
  }
}
