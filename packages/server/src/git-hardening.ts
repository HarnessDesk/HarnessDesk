import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const execute = promisify(execFile)

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

/** Read the configured destination without applying url.* rewrite rules. */
export const rawPushUrl = async (cwd: string, remote: string): Promise<string> => {
  const read = async (key: string) => {
    try { return (await execute('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, 'config', '--get-all', key], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim() }
    catch (error) { if ((error as { code?: number }).code === 1 && !(error as { stderr?: string }).stderr?.trim()) return ''; throw error }
  }
  return await read(`remote.${remote}.pushurl`) || await read(`remote.${remote}.url`)
}

export const githubRepositoryFromUrl = (url: string): string | null =>
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? null

/** Network verbs never load the worker's config (including includes, URL rewrites,
 * HTTP headers/proxies or credential programs). Only system/global credential
 * helpers are carried across, after the empty helper resets the list. Objects
 * remain in the original store; the disposable bare directory owns no refs there.
 * Local-file transport is an explicit fixture capability, absent in production. */
export const hardenedNetworkGit = async (cwd: string, args: readonly string[], options: { readonly allowLocalFile?: boolean; readonly input?: string } = {}): Promise<string> => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' })
  const directory = await mkdtemp(join(tmpdir(), 'hd-network-git-'))
  try {
    const helpers: string[] = []
    for (const scope of ['--system', '--global']) {
      try {
        const result = await execute('git', ['config', scope, '--get-all', 'credential.helper'], { cwd, timeout: 20_000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') || ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'].includes(key))) })
        helpers.push(...result.stdout.replace(/\n$/, '').split('\n'))
      } catch (error) {
        const result = error as { code?: number; stderr?: string }
        if (!(result.code === 1 && !result.stderr?.trim()) &&
          !([1, 128].includes(result.code ?? 0) && /unable to read config file .*No such file or directory/.test(result.stderr ?? ''))) throw error
      }
    }
    const format = (await execute('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, 'rev-parse', '--show-object-format'], { timeout: 20_000 })).stdout.trim()
    const objects = (await execute('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, 'rev-parse', '--git-path', 'objects'], { timeout: 20_000 })).stdout.trim()
    await execute('git', ['init', '--bare', '--template=', `--object-format=${format}`, directory], { env, timeout: 20_000 })
    Object.assign(env, { GIT_OBJECT_DIRECTORY: resolve(cwd, objects), GIT_ALLOW_PROTOCOL: options.allowLocalFile ? 'https:ssh:file' : 'https:ssh' })
    const command = ['--git-dir', directory, ...HARDENED_GIT_CONFIG, '-c', 'core.askPass=', '-c', 'credential.helper=',
      ...helpers.flatMap(helper => ['-c', `credential.helper=${helper}`]), '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
      ...(options.allowLocalFile ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args]
    return await new Promise<string>((done, reject) => {
      const child = execFile('git', command, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : done(stdout.trim()))
      child.stdin?.end(options.input ?? '')
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
}
