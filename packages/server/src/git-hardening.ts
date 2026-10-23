import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
 * external diff program (`diff.external`). Submodule diffs use short gitlink
 * summaries rather than starting a child diff with its own configuration.
 *
 * Filter names are configuration-defined, so automatic reads use an isolated
 * configuration (`git-read.ts`) with those definitions omitted. Host diffs also pass
 * `--no-ext-diff --no-textconv`. Automatic checkouts keep that private
 * configuration through materialization, inspect the target's attributes and
 * refuse filtered paths; `commit_work` does the same for its files, and also
 * excludes system and global configuration.
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
  '-c', 'diff.submodule=short',
]

const run = promisify(execFile)
type ReadOptions = { readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal }

/** Configuration is read as Git sees it, including included and global drivers. */
export const gitFiltersOff = async (cwd: string, options: ReadOptions = {}): Promise<string[]> => {
  let listed: string
  try {
    listed = (await run('git', ['-C', cwd, ...HARDENED_GIT_CONFIG,
      'config', '--null', '--name-only', '--get-regexp', '^filter\\.',
    ], { ...options, timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [] // no matching settings
    throw error
  }
  const drivers = new Set<string>()
  for (const key of listed.split('\0').filter(Boolean)) {
    const last = key.lastIndexOf('.')
    if (last >= 'filter.'.length) {
      const name = key.slice('filter.'.length, last)
      // -c splits at the first equals sign, even when it belongs to a subsection.
      if (name.includes('=')) throw new Error('This git filter name cannot be disabled for an automatic read.')
      drivers.add(name)
    }
  }
  return [...drivers].flatMap((name) =>
    ['process', 'clean', 'smudge'].flatMap((field) => ['-c', `filter.${name}.${field}=`])
      .concat(['-c', `filter.${name}.required=false`]),
  )
}

/** Automatic mutations keep their existing runner and configured-filter refusals. */
export const automaticMutationConfig = async (cwd: string, args: readonly string[], options: ReadOptions = {}): Promise<readonly string[]> =>
  args.includes('worktree') && args.includes('remove')
    ? [...HARDENED_GIT_CONFIG, ...await gitFiltersOff(cwd, options)]
    : HARDENED_GIT_CONFIG
