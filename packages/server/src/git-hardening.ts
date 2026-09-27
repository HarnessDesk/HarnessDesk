/**
 * The floor for git the host runs on its own in a checkout an agent can write
 * to (#1074): evidence reads, status, the lane a flow cuts, `commit_work`.
 *
 * A repository's own configuration can name programs git runs by itself. An
 * agent that can write the checkout's `.git` — any agent whose runtime has no
 * sandbox, or one handed a repository somebody else prepared — can point them
 * at a script of its own, and the next git the host runs there would run it
 * with the host's access. These overrides are read at command-line
 * precedence, above the repository's configuration and anything it includes,
 * and are inherited by any git that git starts in turn. They cover exactly:
 * hooks (`core.hooksPath`), the filesystem monitor (`core.fsmonitor`), the ssh
 * command, commit and tag signing (and so the signing program), and an
 * external diff program (`diff.external`).
 *
 * They do not cover filter drivers or a diff driver's `textconv`: a filter the
 * configuration defines, named by `.gitattributes`, still runs when a host
 * `git status` re-reads a file whose stat information changed. Host diffs pass
 * `--no-ext-diff --no-textconv` themselves. `commit_work` goes further
 * (`card-commit.ts`): no system or global configuration, every configured
 * filter switched off, and a refusal for any path a filter would touch.
 *
 * Verbs a person triggers themselves — bringing a branch home, the git
 * client's own commit, checkout and worktree verbs — run with the person's
 * hooks, as their own git would, and are not held to this.
 */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=ssh',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'diff.external=',
]
