import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** Keep all three published entries self-contained; the manifest publishes no chunks. */
export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/bin.js'] },
  { ...shared, entry: ['lib/types/invariant.js'] },
])
