/** One kernel-held writer per authority root; process exit releases ownership. */
import { mkdir, open, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/**
 * The permanent lock file must never be deleted while a server may hold it.
 * @param root - Directory containing the authority JSON file.
 * @returns Descriptor whose close releases the lock; no expiry or stale-PID takeover.
 */
export async function lockAuthority(root: string): Promise<FileHandle> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'karaka-identity.lock')
  const handle = await open(path, 'a', 0o600)
  try {
    await tryLockExclusive(handle.fd)
    const held = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    if (held.dev !== current.dev || held.ino !== current.ino) throw new Error('Karaka authority lock file was replaced')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
