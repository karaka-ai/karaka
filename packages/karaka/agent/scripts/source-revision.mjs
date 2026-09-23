/** Identify the checkout used to assemble local runtime artifacts. */
import { execFileSync } from 'node:child_process'

export function readSourceRevision(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  return {
    sourceRevision: git(['rev-parse', '--verify', 'HEAD^{commit}']),
    sourceDirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
  }
}
