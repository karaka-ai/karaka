/** Bundle Karaka exports from the JavaScript emitted by each compiler face. */
import type { UserConfig } from 'tsdown'

/**
 * Select emitted Node entries or a self-contained browser module.
 * @param entries - Host export and executable names under lib/types.
 * @param face - Requested repository build face.
 * @param browser - Whether the package exports a browser entry.
 * @returns Bundle settings for the selected compiler face.
 */
export function karakaBundle(entries: readonly string[], face: unknown, browser = false): UserConfig {
  if (face !== undefined && face !== 'host' && face !== 'client') throw new Error(`Unknown build face: ${String(face)}`)
  const client = face === 'client'
  return {
    entry: client ? (browser ? ['lib/types/browser.js'] : '') : entries.map(name => `lib/types/${name}.js`),
    outDir: 'lib',
    format: ['esm'],
    platform: client ? 'browser' : 'node',
    target: client ? 'es2022' : 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: client ? { alwaysBundle: [/./] } : { neverBundle: [/^@deepseek-ai\//, /^@karaka-ai\//] },
  }
}
