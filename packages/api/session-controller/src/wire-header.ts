/** Shared browser Session header encoding. */
import type { SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type { SessionWireHeader } from './types.ts'

/**
 * Translate logical Session metadata to the numeric v0 browser wire.
 * @param header - validated logical metadata.
 * @param inheritedEventCount - exact inherited prefix length.
 * @returns metadata with its physical lineage representation.
 */
export function wireHeader(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
): SessionWireHeader {
  const { isSeeded, ...wire } = header
  return {
    ...wire,
    ...isSeeded ? { seedLength: inheritedEventCount } : {},
  }
}
