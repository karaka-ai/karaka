/** Execute workflow shell steps with synthetic environment values and check process completion. */
import { spawnSync } from 'node:child_process'
import { expect } from 'vitest'

/**
 * Run one workflow step and require successful exit without a timeout or signal.
 * @param shell - Workflow shell available on this test host.
 * @param script - Shell program extracted from the workflow.
 * @param env - Per-execution values overriding the inherited environment.
 * @returns Captured output for the caller's workflow-specific assertions.
 */
export function runWorkflowStep(shell: 'bash' | 'pwsh', script: string, env: Record<string, string>) {
  const args = shell === 'pwsh'
    ? ['-NoProfile', '-NonInteractive', '-Command', script]
    : ['-e', '-u', '-o', 'pipefail', '-c', script]
  const result = spawnSync(shell, args, {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  return { stdout: result.stdout, stderr: result.stderr }
}
