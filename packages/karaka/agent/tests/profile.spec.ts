/** Profile initialization preserves deployment configuration and installation identity. */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { name } from '../src/index.ts'
import { initializeProfile } from '../src/profile.ts'

// Privileged hosts can bypass permission failures; isolate the two filesystem
// operations here to verify propagation of an actual I/O rejection.
vi.mock('node:fs/promises', async (importOriginal) => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>()
  return { ...filesystem, writeFile: vi.fn(filesystem.writeFile), symlink: vi.fn(filesystem.symlink) }
})

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'karaka-profile-'))
  roots.push(root)
  const home = join(root, 'home')
  const packageRoot = join(root, 'package')
  const profile = join(home, 'profiles/karaka')
  await mkdir(packageRoot)
  await mkdir(profile, { recursive: true })
  return { home, packageRoot, profile, manifest: join(profile, 'package.json') }
}

describe(name + ' profile initialization', () => {
  it('creates a startup profile resolving the requested installation', async () => {
    const { home, packageRoot, profile, manifest } = await fixture()
    await initializeProfile(home, packageRoot)
    const stored: unknown = JSON.parse(await readFile(manifest, 'utf8'))
    expect(stored).toEqual({
      name: 'karaka-profile',
      private: true,
      dependencies: { '@karaka-ai/agent': `file:${packageRoot}` },
      dsh: { profile: { bundles: ['@karaka-ai/agent'], patchReload: 'startup' } },
    })
    expect(await realpath(join(profile, 'node_modules/@karaka-ai/agent'))).toBe(await realpath(packageRoot))
  })

  it('preserves an existing profile, dependency choices, and user patch on repeated launch', async () => {
    const { home, packageRoot, profile, manifest } = await fixture()
    const contents = JSON.stringify({
      name: 'deployment',
      dependencies: { '@karaka-ai/agent': 'file:custom-installation', extension: '1.0.0' },
      dsh: { profile: { bundles: ['@karaka-ai/agent', 'extension'], patchReload: 'startup' } },
    })
    const patch = join(profile, 'cordis.patch.yml')
    await writeFile(manifest, contents)
    await writeFile(patch, '# Deployment-owned patch\n')
    await initializeProfile(home, packageRoot)
    await initializeProfile(home, packageRoot)
    expect(await readFile(manifest, 'utf8')).toBe(contents)
    expect(await readFile(patch, 'utf8')).toBe('# Deployment-owned patch\n')
  })

  it.each([
    null,
    {},
    { dsh: {} },
    { dsh: { profile: {} } },
    { dsh: { profile: { bundles: '@karaka-ai/agent' } } },
    { dsh: { profile: { bundles: ['another-bundle'] } } },
  ])('rejects a stored manifest that does not select Karaka: %j', async (value) => {
    const { home, packageRoot, manifest } = await fixture()
    const contents = JSON.stringify(value)
    await writeFile(manifest, contents)
    await expect(initializeProfile(home, packageRoot)).rejects.toThrow('Existing Karaka profile does not select @karaka-ai/agent')
    expect(await readFile(manifest, 'utf8')).toBe(contents)
  })

  it('propagates malformed profile JSON without replacing it', async () => {
    const { home, packageRoot, manifest } = await fixture()
    await writeFile(manifest, '{')
    await expect(initializeProfile(home, packageRoot)).rejects.toBeInstanceOf(SyntaxError)
    expect(await readFile(manifest, 'utf8')).toBe('{')
  })

  it('refuses to replace a link to a different installation', async () => {
    const { home, packageRoot, profile } = await fixture()
    const otherPackage = join(home, 'other-package')
    const link = join(profile, 'node_modules/@karaka-ai/agent')
    await mkdir(otherPackage)
    await mkdir(join(profile, 'node_modules/@karaka-ai'), { recursive: true })
    await symlink(otherPackage, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(initializeProfile(home, packageRoot)).rejects.toThrow('Existing Karaka profile points to another installation')
    expect(await realpath(link)).toBe(await realpath(otherPackage))
  })

  it('accepts a package path alias for the same physical installation', async () => {
    const { home, packageRoot } = await fixture()
    const alias = join(home, 'package-alias')
    await symlink(packageRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await initializeProfile(home, packageRoot)
    await expect(initializeProfile(home, alias)).resolves.toBeUndefined()
  })

  it('propagates manifest write failures before creating an installation link', async () => {
    const { home, packageRoot, profile } = await fixture()
    const failure = Object.assign(new Error('Manifest storage unavailable'), { code: 'EIO' })
    const write = vi.mocked(writeFile).mockRejectedValueOnce(failure)
    try {
      await expect(initializeProfile(home, packageRoot)).rejects.toBe(failure)
      await expect(realpath(join(profile, 'node_modules/@karaka-ai/agent'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      write.mockRestore()
    }
  })

  it('propagates installation link failures without replacing the profile', async () => {
    const { home, packageRoot, manifest } = await fixture()
    const failure = Object.assign(new Error('Installation link unavailable'), { code: 'EIO' })
    const link = vi.mocked(symlink).mockRejectedValueOnce(failure)
    try {
      await expect(initializeProfile(home, packageRoot)).rejects.toBe(failure)
      expect(await readFile(manifest, 'utf8')).toContain('@karaka-ai/agent')
    } finally {
      link.mockRestore()
    }
  })

})
