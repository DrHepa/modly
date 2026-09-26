// Wire git to the version-controlled hooks in .githooks (runs via `prepare` on
// every `npm install`). A linked worktree shares its local Git config with the
// primary checkout, so it must never change core.hooksPath. Failures are
// swallowed so installing outside a git checkout (e.g. CI from a tarball)
// never breaks the install.
import { spawnSync } from 'node:child_process'

function resolveGitDirectory(argument) {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', argument], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

const gitDirectory = resolveGitDirectory('--git-dir')
const gitCommonDirectory = resolveGitDirectory('--git-common-dir')

if (!gitDirectory || !gitCommonDirectory) {
  console.log('[setup-hooks] skipped (not a git checkout) — hooks not wired')
} else if (gitDirectory !== gitCommonDirectory) {
  console.log('[setup-hooks] skipped (linked worktree) — shared Git config unchanged')
} else if (spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  stdio: 'ignore',
}).status === 0) {
  console.log('[setup-hooks] git hooks enabled (core.hooksPath = .githooks)')
} else {
  console.log('[setup-hooks] skipped (unable to update local Git config) — hooks not wired')
}
