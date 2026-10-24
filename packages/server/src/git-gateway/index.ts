import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { HARDENED_GIT_CONFIG } from '../git-hardening.js'
import { GitRecord, validateRepository, type GitApproval, type GitRecordEntry, type GitRecordQuery, type GitRequester } from './record.js'
import { GitPins } from './pins.js'
export { GitRecord, GitPins }
export type { GitRequester, GitApproval, GitRecordEntry, GitRecordQuery } from './record.js'

const execute = promisify(execFile)
export interface GitTarget { readonly repository: string; readonly branch: string; readonly sha: string; readonly previousSha: string | null; readonly requester: GitRequester }
export interface GitCheckout { readonly branch: string | null; readonly sha: string; readonly tree: string; readonly objectStore: string; readonly commonDir: string }
export interface GitPush extends GitTarget {
  /** A reviewed commit and tree, never a branch to resolve at execution time. */
  readonly objectStore: string; readonly tree: string
  readonly protectedBases?: readonly string[]
  readonly approval?: GitApproval
  readonly steeredFrom?: string
}
interface GitWrite { readonly repository: string; readonly requester: GitRequester; readonly approval?: GitApproval; readonly steeredFrom?: string; readonly branch?: string; readonly number?: number; readonly sha?: string; readonly previousSha?: string | null; readonly lease?: string | null }
export interface GitGatewayOptions {
  readonly directory: string
  readonly stateDirectory?: string
  readonly gh?: (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Fixture capability only; production always constructs the pinned HTTPS URL. */
  readonly localRemote?: (repository: string) => string
}
/** Host-only executor. No worker, session or runtime receives this capability.
 * Objects cross into a host-owned bare mirror; configuration and hooks never do.
 * The durable intent precedes the effect, and the outcome precedes returning to
 * a caller (in particular, a caller's own journal may lag this record on crash).
 */
export class GitGateway {
  readonly #tails = new Map<string, Promise<unknown>>()
  readonly gitRecord: GitRecord
  readonly pins: GitPins
  readonly #startup: Promise<void>
  readonly #recoveries = new Map<string, Promise<void>>()
  #initialization?: Promise<void>
  readonly #env: NodeJS.ProcessEnv
  readonly #hostConfig: Pick<NodeJS.ProcessEnv, 'GIT_CONFIG_GLOBAL' | 'GIT_CONFIG_SYSTEM'>
  constructor(private readonly options: GitGatewayOptions) {
    this.#hostConfig = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM }
    this.#env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') &&
      !['GH_HOST', 'GH_REPO', 'GIT_ASKPASS', 'SSH_ASKPASS', 'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'http_proxy', 'https_proxy'].includes(key)))
    Object.assign(this.#env, { GH_PROMPT_DISABLED: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(resolve(options.directory), 'config'), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CEILING_DIRECTORIES: resolve(options.directory), GIT_ASKPASS: '', SSH_ASKPASS: '' })
    this.gitRecord = new GitRecord(options.stateDirectory ?? options.directory)
    this.pins = new GitPins(options.stateDirectory ?? options.directory)
    this.#startup = this.#reconcile()
    void this.#startup.catch(() => {})
  }
  async ready(): Promise<void> { await this.#startup; await Promise.all(this.#recoveries.values()) }
  #queue<T>(repository: string, work: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(repository) ?? Promise.resolve()).then(async () => { await this.#startup; await this.#recoveries.get(repository); return work() })
    const tail = result.catch(() => {}); this.#tails.set(repository, tail)
    void tail.then(() => { if (this.#tails.get(repository) === tail) this.#tails.delete(repository) })
    return result
  }
  #validateWrite(target: GitWrite): void {
    validateRepository(target.repository)
    if (!['lead-goal', 'session', 'person'].includes(target.requester.kind) || !target.requester.id ||
      target.number !== undefined && (!Number.isSafeInteger(target.number) || target.number < 1)) throw new Error('git-gateway-target-invalid')
  }
  #validate(target: GitTarget): void {
    this.#validateWrite(target)
    if (!/^[a-f0-9]{40,64}$/.test(target.sha) || target.previousSha !== null && !/^[a-f0-9]{40,64}$/.test(target.previousSha))
      throw new Error('git-gateway-reviewed-sha-mismatch')
  }
  #init(): Promise<void> { return this.#initialization ??= this.#initialize() }
  async #initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(this.options.directory, 'config'), '[core]\n\thooksPath = /dev/null\n[transfer]\n\tfsckObjects = true\n[protocol]\n\tallow = never\n[protocol "https"]\n\tallow = always\n', { mode: 0o600 })
    // The one-shot helper reads the person's credentials outside every checkout.
    // Remove the mirror's command-line config before consulting host git/gh.
    const helper = `const {execFileSync}=require('node:child_process');
const input=require('node:fs').readFileSync(0); if(process.argv[2]!=='get')process.exit(0);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
Object.assign(env,${JSON.stringify(this.#hostConfig)},{GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',SSH_ASKPASS:''});
try { process.stdout.write(execFileSync('git',['-C',${JSON.stringify(resolve(this.options.directory))},'credential','fill'],{env,input,stdio:['pipe','pipe','pipe']})); }
catch { try { process.stdout.write(execFileSync('gh',['auth','git-credential','get'],{env,input,cwd:${JSON.stringify(resolve(this.options.directory))},stdio:['pipe','pipe','pipe']})); } catch { process.exit(1); } }
`
    await writeFile(join(this.options.directory, 'credential.cjs'), helper, { mode: 0o600 })
  }
  #entry(op: GitRecordEntry['op'], target: GitWrite): Omit<GitRecordEntry, 'prev' | 'outcome'> {
    const { repository, branch, number, sha, previousSha, lease, requester, steeredFrom } = target
    return { id: randomUUID(), op, repository, branch, number, sha, previousSha, lease, requester,
      approval: target.approval ?? null, steeredFrom, at: Date.now() }
  }
  #failure(error: unknown): { outcome: 'refused' | 'rejected' | 'failed'; reason: string } {
    const value = error as { message?: string; stdout?: string; stderr?: string }
    const reason = value.message ?? String(error)
    if (/owned-head-changed|stale info|match.head|head.*changed|rejected/i.test(`${reason} ${value.stdout ?? ''} ${value.stderr ?? ''}`))
      return { outcome: 'rejected', reason }
    if (/git-gateway-(reviewed-sha-mismatch|tree-invalid|branch-exists-not-owned|not-fast-forward|default-branch|protected-branch|target-invalid)/.test(reason))
      return { outcome: 'refused', reason }
    return { outcome: 'failed', reason }
  }
  async #effect<T>(entry: Omit<GitRecordEntry, 'prev' | 'outcome'>, work: () => Promise<T>): Promise<T> {
    await this.gitRecord.append({ ...entry, outcome: 'intent' })
    let result: T
    try { result = await work() }
    catch (error) { await this.gitRecord.append({ ...entry, at: Date.now(), ...this.#failure(error) }); throw error }
    await this.gitRecord.append({ ...entry, at: Date.now(), outcome: 'ok' })
    return result
  }
  async #reconcile(): Promise<void> {
    const repositories = new Map<string, GitRecordEntry[]>()
    for (const entry of await this.gitRecord.pending()) {
      const entries = repositories.get(entry.repository) ?? []
      entries.push(entry); repositories.set(entry.repository, entries)
    }
    // Register recovery independently for each destination. A slow remote must
    // not hold up writes to another repository, including during startup.
    for (const [repository, entries] of repositories) {
      const recovery = (async () => {
        for (const entry of entries) {
          // Forge writes have no remotely provable idempotency key. Never
          // replay one: GitHub may have accepted it just before the crash.
          let reconciled = false
          if (entry.op === 'push' && entry.branch && entry.sha) {
            try { reconciled = await this.#head(await this.#mirror(repository), repository, entry.branch) === entry.sha }
            catch { /* An unavailable destination cannot establish success. */ }
          }
          await this.gitRecord.append({ ...entry, at: Date.now(), outcome: reconciled ? 'ok' : 'failed', reason: reconciled ? 'reconciled' : 'interrupted' })
        }
      })()
      this.#recoveries.set(repository, recovery)
      void recovery.catch(() => {})
    }
  }
  #url(repository: string): string { return this.options.localRemote?.(repository) ?? `https://github.com/${repository}.git` }
  #config(local = false): string[] {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    return ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.askPass=', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(local ? ['-c', 'protocol.file.allow=always'] : []),
      '-c', 'credential.helper=', '-c', `credential.helper=!${quote(process.execPath)} ${quote(join(resolve(this.options.directory), 'credential.cjs'))}`,
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
  }
  async #git(mirror: string | null, args: readonly string[], local = false): Promise<string> {
    const result = await execute('git', [...(mirror ? ['--git-dir', mirror] : []), ...this.#config(local), ...args],
      { cwd: this.options.directory, env: this.#env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    return result.stdout.trim()
  }
  /** Metadata reads only: no config helper, filter, hook or worker command
   * runs here. Keep this outside the mutation queue so a push's final guard can
   * re-read the checkout while the gateway holds its own serialized executor. */
  async inspectCheckout(cwd: string): Promise<GitCheckout> {
    const read = async (args: readonly string[]) => (await execute('git', ['-C', cwd, ...HARDENED_GIT_CONFIG, '-c', 'core.askPass=', ...args],
      { env: { ...this.#env, GIT_CONFIG_GLOBAL: '/dev/null' }, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
    const [branch, identity] = await Promise.all([read(['symbolic-ref', '-q', '--short', 'HEAD']).catch(error => { if ((error as { code?: number }).code === 1) return null; throw error }),
      read(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', 'HEAD', 'HEAD^{tree}'])])
    const [objectStore, commonDir, sha, tree] = identity.split('\n')
    if (!objectStore || !commonDir || !sha || !tree || ![sha, tree].every(value => /^[a-f0-9]{40,64}$/.test(value)))
      throw new Error('git-gateway-checkout-unverifiable')
    return { branch, sha, tree, objectStore, commonDir: await realpath(commonDir) }
  }
  async #mirror(repository: string): Promise<string> {
    validateRepository(repository)
    await this.#init()
    const mirror = join(resolve(this.options.directory), `${createHash('sha256').update(repository).digest('hex')}.git`)
    try { await readFile(join(mirror, 'HEAD')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.#git(null, ['init', '--bare', '--template=', mirror])
    }
    return mirror
  }
  async #head(mirror: string, repository: string, branch: string): Promise<string | null> {
    await this.#git(mirror, ['check-ref-format', `refs/heads/${branch}`])
    const ref = `refs/heads/${branch}`, out = await this.#git(mirror, ['ls-remote', '--heads', this.#url(repository), ref], !!this.options.localRemote)
    return out.split('\n').map(line => line.split(/\s+/)).find(([, name]) => name === ref)?.[0] ?? null
  }
  remoteHead(repository: string, branch: string): Promise<string | null> {
    return this.#queue(repository, async () => {
      const sha = await this.#head(await this.#mirror(repository), repository, branch)
      if (sha) await this.gitRecord.observe(repository, branch, sha, null)
      return sha
    })
  }
  push(request: GitPush, options: { readonly reconcile?: boolean; readonly beforePush?: () => Promise<void> } = {}): Promise<{ pushed: boolean }> {
    return this.#queue(request.repository, async () => {
      validateRepository(request.repository)
      const entry = this.#entry('push', { ...request, lease: request.previousSha })
      let journaled = false
      try {
        this.#validate(request)
        const mirror = await this.#mirror(request.repository), ref = `refs/heads/${request.branch}`
        await this.#git(mirror, ['check-ref-format', ref])
        if (request.requester.kind === 'session') await this.#guardSessionPush(request)
        if (!/^[a-f0-9]{40,64}$/.test(request.tree)) throw new Error('git-gateway-tree-invalid')
        // Object intake never executes worker configuration or chooses a remote.
        await this.#git(mirror, ['fetch', '--no-tags', '--no-write-fetch-head', '--', resolve(request.objectStore), request.sha], true)
          .catch(error => { if (/not our ref|couldn.t find remote ref|not a valid|unadvertised object/i.test(String(error))) throw new Error('git-gateway-reviewed-sha-mismatch'); throw error })
        if (await this.#git(mirror, ['rev-parse', `${request.sha}^{commit}`]) !== request.sha ||
          await this.#git(mirror, ['rev-parse', `${request.sha}^{tree}`]) !== request.tree) throw new Error('git-gateway-reviewed-sha-mismatch')
        await this.#git(mirror, ['fsck', '--strict', '--no-reflogs', request.sha])
        const remote = await this.#head(mirror, request.repository, request.branch)
        if (remote === request.sha && (request.previousSha === request.sha || options.reconcile)) return { pushed: false }
        if (request.previousSha === null && remote !== null) throw new Error('git-gateway-branch-exists-not-owned')
        if (request.previousSha !== null) {
          if (remote !== request.previousSha) throw new Error('git-gateway-owned-head-changed')
          await this.#git(mirror, ['fetch', '--no-tags', '--', this.#url(request.repository), request.previousSha], !!this.options.localRemote)
          try { await this.#git(mirror, ['merge-base', '--is-ancestor', request.previousSha, request.sha]) }
          catch { throw new Error('git-gateway-not-fast-forward') }
        }
        await options.beforePush?.()
        journaled = true
        await this.#effect(entry, async () => {
          await this.#git(mirror, ['push', '--porcelain', `--force-with-lease=${ref}:${request.previousSha ?? ''}`, '--', this.#url(request.repository), `${request.sha}:${ref}`], !!this.options.localRemote)
          if (await this.#head(mirror, request.repository, request.branch) !== request.sha) throw new Error('git-gateway-head-changed')
        })
        return { pushed: true }
      } catch (error) {
        if (!journaled) await this.gitRecord.append({ ...entry, ...this.#failure(error) })
        throw error
      }
    })
  }
  async #guardSessionPush(request: GitPush): Promise<void> {
    // A fixture bare repository has no forge. Its symbolic HEAD supplies the
    // default branch; a fake gh, when provided, exercises forge protections.
    if (this.options.localRemote && !this.options.gh) {
      const branch = await this.#git(null, ['--git-dir', this.#url(request.repository), 'symbolic-ref', '--short', 'HEAD'], true)
      if (request.branch === branch) throw new Error('git-gateway-default-branch')
      if (request.protectedBases?.includes(request.branch)) throw new Error('git-gateway-protected-branch')
      return
    }
    const repository = JSON.parse(await this.#gh(request.repository, ['repo', 'view', request.repository, '--json', 'nameWithOwner,url,defaultBranchRef'])) as { defaultBranchRef?: { name?: string } }
    if (!repository.defaultBranchRef?.name) throw new Error('git-gateway-default-branch-unverifiable')
    if (request.branch === repository.defaultBranchRef.name) throw new Error('git-gateway-default-branch')
    if (request.protectedBases?.includes(request.branch)) throw new Error('git-gateway-protected-branch')
    try {
      const branch = JSON.parse(await this.#gh(request.repository, ['api', `repos/${request.repository}/branches/${encodeURIComponent(request.branch)}`])) as { protected?: boolean }
      if (branch.protected === true) throw new Error('git-gateway-protected-branch')
      if (branch.protected !== false) throw new Error('git-gateway-protected-branch-unverifiable')
    } catch (error) {
      if (!/HTTP 404|Not Found|Branch not found/i.test(String(error))) throw error
    }
  }
  /** Fetch the observed head from the pinned destination, never a worker remote. */
  isAncestor(repository: string, owned: string, observed: string): Promise<boolean> {
    return this.#queue(repository, async () => {
      if (![owned, observed].every(sha => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error('git-gateway-sha-invalid')
      const mirror = await this.#mirror(repository)
      for (const sha of [owned, observed]) {
        try { await this.#git(mirror, ['cat-file', '-e', `${sha}^{commit}`]) }
        catch { await this.#git(mirror, ['fetch', '--no-tags', '--', this.#url(repository), sha], !!this.options.localRemote) }
      }
      try { await this.#git(mirror, ['merge-base', '--is-ancestor', owned, observed]); return true }
      catch (error) { if ((error as { code?: number }).code === 1) return false; throw error }
    })
  }
  attribute(repository: string, branch: string, sha: string): Promise<GitRequester | 'outside'> {
    return this.#queue(repository, () => this.gitRecord.attribute(repository, branch, sha))
  }
  observe(repository: string, branch: string, sha: string, previousSha: string | null): Promise<void> {
    return this.#queue(repository, () => this.gitRecord.observe(repository, branch, sha, previousSha))
  }
  record(query: GitRecordQuery): Promise<GitRecordEntry[]> { return this.#queue(query.repository, () => this.gitRecord.list(query)) }
  async #gh(repository: string, args: readonly string[]): Promise<string> {
    validateRepository(repository)
    await this.#init()
    const command = ['pr', 'issue'].includes(args[0] ?? '') ? [...args, '--repo', repository] : [...args]
    if (this.options.gh) {
      const result = await this.options.gh(resolve(this.options.directory), command, this.#env)
      if (result.exitCode !== 0) throw new Error(`git-gateway-forge-unavailable: ${result.stderr}`)
      return result.stdout.trim()
    }
    return (await execute('gh', command, { cwd: this.options.directory, env: this.#env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
  }
  findPullRequest(target: GitTarget & { readonly number?: number }): Promise<string> {
    return this.#queue(target.repository, () => {
      this.#validate(target)
      return this.#gh(target.repository, target.number === undefined ?
        ['pr', 'list', '--head', target.branch, '--state', 'open', '--json', 'number,url,headRefName,headRefOid,body,isCrossRepository,headRepositoryOwner'] :
        ['pr', 'view', String(target.number), '--json', 'number,title,state,url,body,headRefName,headRefOid,isCrossRepository,headRepositoryOwner,author,additions,deletions,changedFiles'])
    })
  }
  #forgeWrite(op: GitRecordEntry['op'], target: GitWrite, args: readonly string[]): Promise<string> {
    return this.#queue(target.repository, async () => {
      this.#validateWrite(target)
      return this.#effect(this.#entry(op, target), () => this.#gh(target.repository, args))
    })
  }
  createPullRequest(target: GitWrite & { readonly branch: string; readonly title: string; readonly body: string; readonly base?: string; readonly draft?: boolean }): Promise<string> {
    return this.#forgeWrite('pr.create', target,
      ['pr', 'create', '--head', target.branch, ...(target.base ? ['--base', target.base] : []), '--title', target.title, '--body', target.body, ...(target.draft ? ['--draft'] : [])])
  }
  updatePullRequest(target: GitWrite & { readonly number: number; readonly title?: string; readonly body?: string }): Promise<string> {
    return this.#forgeWrite('pr.update', target, ['pr', 'edit', String(target.number),
      ...(target.title === undefined ? [] : ['--title', target.title]), ...(target.body === undefined ? [] : ['--body', target.body])])
  }
  mergePullRequest(target: GitWrite & { readonly number: number; readonly head: string; readonly method: 'squash' | 'merge' | 'rebase' }): Promise<string> {
    return this.#forgeWrite('pr.merge', { ...target, sha: target.head },
      ['pr', 'merge', String(target.number), `--${target.method}`, '--match-head-commit', target.head])
  }
  comment(target: GitWrite & { readonly subject: 'pullRequest' | 'issue'; readonly number: number; readonly body: string }): Promise<string> {
    return this.#forgeWrite(target.subject === 'pullRequest' ? 'pr.comment' : 'issue.comment', target,
      [target.subject === 'pullRequest' ? 'pr' : 'issue', 'comment', String(target.number), '--body', target.body])
  }
  review(target: GitWrite & { readonly number: number; readonly event: 'approve' | 'request-changes' | 'comment'; readonly body: string }): Promise<string> {
    return this.#forgeWrite('pr.review', target, ['pr', 'review', String(target.number), `--${target.event}`, '--body', target.body])
  }
  repository(repository: string): Promise<{ nameWithOwner: string; url: string; defaultBranchRef?: { name?: string } }> {
    return this.#queue(repository, async () => JSON.parse(await this.#gh(repository, ['repo', 'view', repository, '--json', 'nameWithOwner,url,defaultBranchRef'])))
  }
}
