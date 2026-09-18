import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const moduleUrl = new URL('../packages/karaka/agent/scripts/source-revision.mjs', import.meta.url).href
const readSource = `const { readSourceRevision } = await import(process.argv[1]); process.stdout.write(JSON.stringify(readSourceRevision(process.argv[2])))`

it('records the actual checkout revision and distinguishes uncommitted source', { timeout: 90_000 }, (test) => {
  const root = mkdtempSync(join(tmpdir(), 'karaka-artifact-source-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Source record test', GIT_AUTHOR_EMAIL: 'source@example.invalid',
    GIT_COMMITTER_NAME: 'Source record test', GIT_COMMITTER_EMAIL: 'source@example.invalid',
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  const record = (): unknown => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', readSource, moduleUrl, root], { env, encoding: 'utf8', stdio: 'pipe' }))
  git(['init', '--quiet'])
  writeFileSync(join(root, 'source.txt'), 'first\n')
  git(['add', 'source.txt'])
  git(['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'first'])
  const first = git(['rev-parse', 'HEAD'])
  expect(record()).toEqual({ sourceRevision: first, sourceDirty: false })
  writeFileSync(join(root, 'source.txt'), 'second\n')
  expect(record()).toEqual({ sourceRevision: first, sourceDirty: true })
  git(['add', 'source.txt'])
  git(['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'second'])
  const second = git(['rev-parse', 'HEAD'])
  expect(second).not.toBe(first)
  expect(record()).toEqual({ sourceRevision: second, sourceDirty: false })
  writeFileSync(join(root, 'untracked-source.txt'), 'new input\n')
  expect(record()).toEqual({ sourceRevision: second, sourceDirty: true })
})

it('refuses to invent a revision outside a Git checkout', (test) => {
  const root = mkdtempSync(join(tmpdir(), 'karaka-artifact-no-git-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) })
  expect(() => execFileSync(process.execPath, ['--input-type=module', '-e', readSource, moduleUrl, root], {
    encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(root) },
  })).toThrow(/not a git repository/)
})
