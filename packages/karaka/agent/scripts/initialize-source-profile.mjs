/** Initialize the Karaka source profile without replacing any existing configuration. */
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.argv[2]
if (!home) throw new Error('Usage: node initialize-source-profile.mjs <harness-home>')
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const profile = resolve(home, 'profiles/karaka')
await mkdir(profile, { recursive: true, mode: 0o700 })
await writeFile(resolve(profile, 'package.json'), JSON.stringify({
  name: 'karaka-source-profile', private: true,
  dependencies: { '@karaka-ai/agent': `file:${packageRoot}` },
  dsh: { profile: { bundles: ['@karaka-ai/agent'], patchReload: 'startup' } },
}, null, 2) + '\n', { flag: 'wx' })
await writeFile(resolve(profile, 'cordis.patch.yml'), '[]\n', { flag: 'wx' })
const link = resolve(profile, 'node_modules/@karaka-ai/agent')
await mkdir(dirname(link), { recursive: true })
await symlink(packageRoot, link, 'dir')
console.log(`Karaka profile initialized at ${profile}`)
