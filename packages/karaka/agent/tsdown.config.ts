import { createRequire } from 'node:module'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

const resolveFrom = createRequire(import.meta.url)
const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), 'lib')
const bundledWorkspaceModule = /^@deepseek-ai\/dsh-|^@karaka\/(?:mcp-application|server-auth|transport-http)(?:\/|$)/

/** Remove prior root JavaScript outputs without deleting tsc's `lib/types` inputs. */
const cleanRuntimeOutputs = {
  name: 'karaka-agent-clean-runtime-outputs',
  buildStart(): void {
    for (const entry of readdirSync(outputDir, { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.js.map'))) {
        rmSync(resolve(outputDir, entry.name))
      }
    }
  },
}

/** Resolve bundled workspaces from tsc output so const enums are already lowered. */
const bundledWorkspaceResolver = {
  name: 'karaka-agent-workspace-artifacts',
  enforce: 'pre' as const,
  resolveId(source: string): string | null {
    if (!bundledWorkspaceModule.test(source)) return null
    const resolved = resolveFrom.resolve(source)
    const marker = `${sep}lib${sep}`
    if (resolved.includes(`${marker}types${sep}`)) return resolved
    const index = resolved.lastIndexOf(marker)
    if (index === -1) return resolved
    return `${resolved.slice(0, index)}${marker}types${sep}${resolved.slice(index + marker.length)}`
  },
}

const shared = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: (specifier: string) => bundledWorkspaceModule.test(specifier),
  },
  plugins: [cleanRuntimeOutputs, bundledWorkspaceResolver, typertPlugin({ mode: 'workspace', faces: ['host'] })],
}

/** Bundle every private DSH module into the public Agent artifact. */
export default defineConfig({
  ...shared,
  entry: {
    index: 'lib/types/index.js',
    bin: 'lib/types/bin.js',
    cordis: 'lib/types/cordis.js',
    invariant: 'lib/types/invariant.js',
  },
})
