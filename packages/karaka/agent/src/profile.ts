/** Create the Karaka profile without replacing user configuration or another installation. */
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function selectsKaraka(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.dsh) || !isRecord(value.dsh.profile)) return false
  const bundles: unknown = value.dsh.profile.bundles
  return Array.isArray(bundles) && bundles.includes('@karaka-ai/agent')
}

/**
 * Initialize a startup-only DSH profile and link the selected Karaka installation.
 * Existing manifests and patches are preserved; an incompatible profile or package link rejects.
 * @param home - Absolute Harness home used by the child DSH process.
 * @param packageRoot - Absolute root of the installed Karaka agent package.
 * @returns Completion after the profile and package link are available.
 */
export async function initializeProfile(home: string, packageRoot: string): Promise<void> {
  const profile = resolve(home, 'profiles/karaka')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  const manifestPath = resolve(profile, 'package.json')
  const manifest = {
    name: 'karaka-profile',
    private: true,
    dependencies: { '@karaka-ai/agent': `file:${packageRoot}` },
    dsh: { profile: { bundles: ['@karaka-ai/agent'], patchReload: 'startup' } },
  }
  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!selectsKaraka(existing)) throw new Error('Existing Karaka profile does not select @karaka-ai/agent')
  }

  const link = resolve(profile, 'node_modules/@karaka-ai/agent')
  await mkdir(dirname(link), { recursive: true })
  try {
    // Node ignores the link type on POSIX; Windows directory links use junctions.
    await symlink(packageRoot, link, 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await realpath(link) !== await realpath(packageRoot)) {
      throw new Error('Existing Karaka profile points to another installation; update its package link explicitly before launching')
    }
  }
}
