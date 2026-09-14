import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/build-preview-cloudflare.yml'), 'utf8')) as {
  on: unknown
  permissions: unknown
  concurrency: unknown
  env: Record<string, string>
  jobs: Record<'preview', {
    'runs-on': string
    steps: Array<{
      name?: string
      id?: string
      if?: string
      uses?: string
      run?: string
      with?: Record<string, unknown>
      env?: Record<string, string>
    }>
  }>
}
const preview = workflow.jobs.preview

describe('PR preview workflow', () => {
  it('keeps every PR author on the selected GitHub-hosted runner', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['preview'])
    expect(preview['runs-on']).toBe('ubuntu-24.04')
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'synchronize', 'reopened'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
    expect(preview.steps.find(step => step.uses === 'actions/checkout@v6')?.with).toEqual({ 'persist-credentials': false })
  })

  it('keeps the immutable full build and restore-only dependency cache', () => {
    expect(workflow.env.PRIMARY_NODE_VERSION).toBe('24')
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    const commands = preview.steps.map(step => step.run)
    expect(commands).toContain('pnpm install --frozen-lockfile')
    expect(commands).toContain('pnpm run build')
    expect(commands).toContain('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview')
    expect(commands.indexOf('pnpm run build')).toBeLessThan(commands.indexOf('pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview'))
    expect(preview.steps.filter(step => step.uses?.startsWith('actions/cache'))).toHaveLength(1)
    expect(preview.steps.find(step => step.uses === 'actions/cache/restore@v4')?.with).toMatchObject({
      key: "${{ runner.os }}-node-${{ env.PRIMARY_NODE_VERSION }}-pnpm-${{ hashFiles('pnpm-lock.yaml') }}",
    })
  })

  it.skipIf(process.platform === 'win32')('requires every deployment credential while retaining the preview build', () => {
    const check = preview.steps.find(step => step.id === 'deployment')!
    const keys = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']
    const root = mkdtempSync(join(tmpdir(), 'preview-credentials-'))
    try {
      for (const missing of [undefined, ...keys]) {
        const output = join(root, missing ?? 'enabled')
        const credentials = Object.fromEntries(keys.map(key => [key, key === missing ? '' : 'synthetic-test-value']))
        const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', check.run!], {
          env: { ...process.env, ...credentials, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: output + '.summary' },
          encoding: 'utf8', timeout: 10_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(output, 'utf8').trim()).toBe(`enabled=${missing === undefined}`)
        expect(result.stdout + result.stderr).not.toContain('synthetic-test-value')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
    for (const name of ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']) {
      expect(preview.steps.find(step => step.name === name)?.if).toBe("steps.deployment.outputs.enabled == 'true'")
    }
    for (const name of ['Build workspace', 'Build the preview page and pack the VFS image']) {
      expect(preview.steps.find(step => step.name === name)?.if).toBeUndefined()
    }
  })

  it('retains per-PR deployment, protected image verification, and idempotent URL comments', () => {
    expect(workflow.concurrency).toEqual({
      group: 'build-preview-cloudflare-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    })
    expect(workflow.env.CF_PROJECT).toBe('dsh-build-preview')
    const shape = preview.steps.find(step => step.name === 'Shape the upload')!
    expect(shape.run).toContain("find apps/web/dist -name '*.map' -delete")
    expect(shape.run).toContain('cp apps/web/dist/preview.html apps/web/dist/index.html')
    const deploy = preview.steps.find(step => step.name === 'Upload to Cloudflare Pages')!
    expect(deploy.run).toContain('npx --yes wrangler@4 pages deploy apps/web/dist')
    expect(deploy.run).toContain('--branch "pr-${{ github.event.pull_request.number }}"')
    const verify = preview.steps.find(step => step.name === 'Verify the protected deployment serves the image')!
    expect(verify.run).toContain('/preview/vfs-image.tar.gz')
    expect(verify.run).toContain('"$code" != "200"')
    expect(verify.run).toContain('content-encoding:')
    expect(verify.run).toContain('"$magic" != "1f8b"')
    expect(verify.env?.CF_ACCESS_CLIENT_SECRET).toBe('${{ secrets.CF_ACCESS_CLIENT_SECRET }}')
    const comment = preview.steps.find(step => step.name === 'Comment the preview URL')!
    expect(comment.run).toContain('<!-- dsh-preview-url -->')
    expect(comment.run).toContain('gh pr comment "$PR" --body-file -')
  })
})
