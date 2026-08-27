import { defineConfig } from 'tsdown'

/** Build the vendored foundation workspaces from TypeScript's emitted JavaScript. */
export default defineConfig({
  workspace: ['vendor/*'],
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
