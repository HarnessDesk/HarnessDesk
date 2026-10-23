import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
 * `--no-ext-diff --no-textconv`. Automatic checkouts inspect the target's
 * attributes and refuse filtered paths; `commit_work` does the same for its
 * files, and also excludes system and global configuration.
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

/**
 * Inspect attributes in the target tree, using a private index so neither the
 * current index nor its .gitattributes determines what the new checkout needs.
 * Refuse rather than materialize filtered files without their conversion.
 */
export const automaticCheckout = async (cwd: string, revision: string, options: ReadOptions = {}): Promise<{
  readonly at: string; readonly config: readonly string[]
}> => {
  const config = [...HARDENED_GIT_CONFIG, ...await gitFiltersOff(cwd, options)]
  const read = async (args: readonly string[], env = options.env): Promise<string> =>
    (await run('git', ['-C', cwd, ...config, ...args], {
      ...options, env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    })).stdout
  const at = (await read(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim()
  const scratch = await mkdtemp(join(tmpdir(), 'hd-checkout-index-'))
  try {
    const env = { ...(options.env ?? process.env), GIT_INDEX_FILE: join(scratch, 'index') }
    await read(['read-tree', at], env)
    const paths = await read(['ls-files', '-z'], env)
    const attributes = await new Promise<string>((resolve, reject) => {
      const child = execFile('git', ['-C', cwd, ...config, 'check-attr', '--cached', '-z', '--stdin', 'filter'], {
        ...options, env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout) => error ? reject(error) : resolve(stdout))
      child.stdin?.on('error', () => {}) // the process result owns a refusal
      child.stdin?.end(paths)
    })
    const fields = attributes.split('\0')
    for (let i = 2; i < fields.length; i += 3) {
      if (fields[i] !== 'unspecified' && fields[i] !== 'unset') {
        throw new Error('This checkout needs a git filter (such as LFS). Create it yourself so its files are converted.')
      }
    }
    return { at, config }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
