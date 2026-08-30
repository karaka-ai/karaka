import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** Build the kernel and application packages from TypeScript's emitted JavaScript. */
export default defineConfig([
  {
    ...shared,
    workspace: ['vendor/*'],
    entry: ['lib/types/index.js'],
  },
  {
    ...shared,
    workspace: ['packages/cli'],
    entry: ['lib/types/bin.js'],
  },
  {
    ...shared,
    workspace: ['packages/authentication'],
    entry: ['lib/types/index.js', 'lib/types/authentication-jwks.js', 'lib/types/authentication-host.js'],
  },
  {
    ...shared,
    workspace: ['packages/entitlement'],
    entry: ['lib/types/index.js', 'lib/types/local.js'],
  },
  {
    ...shared,
    workspace: ['packages/storage'],
    entry: ['lib/types/index.js', 'lib/types/default.js', 'lib/types/local.js'],
  },
  {
    ...shared,
    workspace: ['packages/agent-runtime'],
    entry: ['lib/types/index.js', 'lib/types/model-echo.js', 'lib/types/session-storage.js'],
  },
  {
    ...shared,
    workspace: ['packages/model-openai'],
    entry: ['lib/types/index.js'],
  },
  {
    ...shared,
    workspace: ['packages/tool'],
    entry: ['lib/types/index.js', 'lib/types/core.js'],
  },
  {
    ...shared,
    workspace: ['packages/sdk'],
    entry: ['lib/types/index.js'],
  },
  {
    ...shared,
    workspace: ['packages/transport'],
    entry: ['lib/types/index.js', 'lib/types/http.js'],
  },
])
