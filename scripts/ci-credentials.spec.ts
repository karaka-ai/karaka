/** Execute CI credential checks with isolated output files and synthetic keys. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  id?: string
  if?: string
  run?: string
  shell?: string
  env?: Record<string, string>
}
interface Job {
  if?: string
  needs?: string
  outputs?: Record<string, string>
  steps: Step[]
}
function workflow(file: string): { jobs: Record<string, Job> } {
  return load(readFileSync(resolve(import.meta.dirname, '../.github/workflows', file), 'utf8')) as { jobs: Record<string, Job> }
}

const e2e = workflow('e2e.yml').jobs
const build = workflow('build-exe-for-python-sdk.yml').jobs.build!
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 10_000 })
const cases = [
  { name: 'E2E', job: e2e.credentials!, id: 'key', shell: 'bash' },
  { name: 'installed wheel POSIX', job: build, id: 'live-api-posix', shell: 'bash' },
  { name: 'installed wheel Windows', job: build, id: 'live-api-windows', shell: 'pwsh' },
]

describe('optional CI API credentials', () => {
  for (const entry of cases) {
    const step = entry.job.steps.find(candidate => candidate.id === entry.id)!
    it.skipIf(entry.shell === 'pwsh' ? pwsh.status !== 0 : process.platform === 'win32')
    (`${entry.name} distinguishes unavailable credentials from an enabled live test`, () => {
      const root = mkdtempSync(join(tmpdir(), 'ci-credentials-'))
      try {
        for (const key of ['', 'synthetic-test-key']) {
          const output = join(root, key ? 'enabled' : 'disabled')
          const summary = output + '.summary'
          const result = spawnSync(entry.shell, entry.shell === 'pwsh'
            ? ['-NoProfile', '-NonInteractive', '-Command', step.run!]
            : ['-e', '-u', '-o', 'pipefail', '-c', step.run!], {
            env: { ...process.env, DEEPSEEK_API_KEY: key, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
            encoding: 'utf8', timeout: 10_000,
          })
          expect(result.error).toBeUndefined()
          expect(result.signal).toBeNull()
          expect(result.status, result.stderr).toBe(0)
          expect(readFileSync(output, 'utf8').trim()).toBe(`enabled=${key !== ''}`)
          if (!key) {
            expect(result.stdout).toContain('::notice::Skipping')
            expect(readFileSync(summary, 'utf8')).toContain('DEEPSEEK_API_KEY_EXTERNAL')
          } else {
            expect(result.stdout + result.stderr + readFileSync(output, 'utf8')).not.toContain(key)
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('gates live work on credential outputs and preserves keyless wheel checks', () => {
    expect(e2e.e2e?.needs).toBe('credentials')
    expect(e2e.e2e?.if).toBe("needs.credentials.outputs.enabled == 'true'")
    expect(e2e.credentials?.outputs).toEqual({ enabled: '${{ steps.key.outputs.enabled }}' })
    for (const [platform, id] of [['POSIX', 'posix'], ['Windows', 'windows']]) {
      const live = build.steps.find(step => step.name === `Run installed-wheel real API black-box test (${platform})`)!
      expect(live.if).toBe(`steps.live-api-${id}.outputs.enabled == 'true'`)
    }
    const keyless = build.steps.filter(step => step.run?.includes('--scenario all'))
    expect(keyless.length).toBeGreaterThanOrEqual(2)
    for (const step of keyless) expect(step.if ?? '').not.toMatch(/live-api|credentials/)
    for (const entry of cases) {
      const step = entry.job.steps.find(candidate => candidate.id === entry.id)!
      expect(step.env).toEqual({ DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' })
      expect(step.if ?? entry.job.if).toContain('dependabot[bot]')
      expect(step.if ?? entry.job.if).toContain('head.repo.fork')
    }
  })
})
