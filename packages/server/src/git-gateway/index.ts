import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { HARDENED_GIT_CONFIG } from '../git-hardening.js'
import { GitRecord, canonicalRepository, validateRepository, isGitRequester, type GitApproval, type GitRecordEntry, type GitRecordQuery, type GitRequester, type SucceededPushQuery } from './record.js'
import { GitPins } from './pins.js'
export { GitRecord, GitPins }
export type { GitRequester, GitApproval, GitRecordEntry, GitRecordQuery, SucceededPushQuery } from './record.js'

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
      !['GH_REPO', 'GIT_ASKPASS', 'SSH_ASKPASS', 'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'http_proxy', 'https_proxy'].includes(key)))
    Object.assign(this.#env, { GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(resolve(options.directory), 'config'), GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CEILING_DIRECTORIES: resolve(options.directory), GIT_ASKPASS: '', SSH_ASKPASS: '' })
    // The credential helper uses this executable too. In a packaged desk it
    // must run the helper script as Node rather than launch another app.
    if (process.versions.electron) this.#env.ELECTRON_RUN_AS_NODE = '1'
    this.gitRecord = new GitRecord(options.stateDirectory ?? options.directory)
    this.pins = new GitPins(options.stateDirectory ?? options.directory)
    this.#startup = this.#reconcile()
    void this.#startup.catch(() => {})
  }
  async ready(): Promise<void> { await this.#startup; await Promise.all(this.#recoveries.values()) }
  #queue<T>(repository: string, work: () => Promise<T>): Promise<T> {
    try { repository = canonicalRepository(repository) } catch (error) { return Promise.reject(error) }
    const result = (this.#tails.get(repository) ?? Promise.resolve()).then(async () => { await this.#startup; await this.#recoveries.get(repository); return work() })
    const tail = result.catch(() => {}); this.#tails.set(repository, tail)
    void tail.then(() => { if (this.#tails.get(repository) === tail) this.#tails.delete(repository) })
    return result
  }
  async #validateWrite(target: GitWrite, op?: GitRecordEntry['op']): Promise<void> {
    validateRepository(target.repository)
    const value = target as GitWrite & { head?: string; method?: string; event?: string; title?: string; body?: string; base?: string; draft?: boolean; subject?: string }
    const text = (input: unknown) => typeof input === 'string' && !input.includes('\0')
    const invalid = () => { throw new Error('git-gateway-target-invalid') }
    if (!isGitRequester(target.requester) ||
      target.number !== undefined && (!Number.isSafeInteger(target.number) || target.number < 1)) invalid()
    for (const branch of [target.branch, value.base]) if (branch !== undefined) {
      if (!text(branch) || !branch || branch.startsWith('-')) invalid()
      try { await execute('git', ['check-ref-format', `refs/heads/${branch}`], { env: this.#env, timeout: 10_000 }) } catch { invalid() }
    }
    for (const input of [value.title, value.body, target.steeredFrom]) if (input !== undefined && !text(input)) invalid()
    for (const sha of [target.sha, target.previousSha, target.lease]) if (sha !== undefined && sha !== null && !/^[a-f0-9]{40,64}$/.test(sha)) invalid()
    if (value.title !== undefined && !value.title.trim() || value.draft !== undefined && typeof value.draft !== 'boolean') invalid()
    if (target.approval !== undefined && target.approval !== null && (typeof target.approval !== 'object' || !['person', 'standing', 'ceiling', 'steered'].includes(target.approval.by) ||
      target.approval.at !== undefined && (!Number.isSafeInteger(target.approval.at) || target.approval.at < 0))) invalid()
    if (op && !['push', 'pr.create', 'observed'].includes(op) && target.number === undefined) invalid()
    if (op === 'pr.create' && (!target.branch || value.title === undefined || value.body === undefined)) invalid()
    if (op === 'pr.update' && value.title === undefined && value.body === undefined) invalid()
    if (op === 'pr.merge' && (!text(value.head) || !/^[a-f0-9]{40,64}$/.test(value.head!) || !['squash', 'merge', 'rebase'].includes(value.method!))) invalid()
    if (op === 'pr.review' && (!['approve', 'request-changes', 'comment'].includes(value.event!) || value.body === undefined)) invalid()
    if ((op === 'pr.comment' || op === 'issue.comment') && (!['pullRequest', 'issue'].includes(value.subject!) || value.body === undefined)) invalid()
  }
  async #validate(target: GitTarget): Promise<void> {
    if (typeof target.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(target.sha) || target.previousSha !== null && !/^[a-f0-9]{40,64}$/.test(target.previousSha))
      throw new Error('git-gateway-reviewed-sha-mismatch')
    await this.#validateWrite(target)
    if (!target.branch) throw new Error('git-gateway-target-invalid')
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
    return { id: randomUUID(), op, repository: canonicalRepository(repository), branch: typeof branch === 'string' ? branch : undefined,
      number: Number.isSafeInteger(number) && number! >= 1 ? number : undefined, sha: typeof sha === 'string' ? sha : undefined,
      previousSha: typeof previousSha === 'string' || previousSha === null ? previousSha : undefined,
      lease: typeof lease === 'string' || lease === null ? lease : undefined, requester: isGitRequester(requester) ? requester : { kind: 'outside' },
      approval: target.approval && typeof target.approval === 'object' && ['person', 'standing', 'ceiling', 'steered'].includes(target.approval.by) ? target.approval : null,
      steeredFrom: typeof steeredFrom === 'string' ? steeredFrom : undefined, at: Date.now() }
  }

  #failure(error: unknown, op?: GitRecordEntry['op']): { outcome: 'refused' | 'rejected' | 'failed'; reason: string } {
    const value = (error && typeof error === 'object' ? error : {}) as { message?: string; stdout?: string; stderr?: string }
    const reason = value.message ?? String(error), output = `${reason} ${value.stdout ?? ''} ${value.stderr ?? ''}`
    if (/remote rejected|hook declined|pre-receive hook declined/i.test(output)) return { outcome: 'refused', reason: output.trim() }
    if (reason === 'git-gateway-owned-head-changed' || /\[rejected\][^\r\n]*\(stale info\)/i.test(value.stdout ?? '') ||
      op === 'pr.merge' && /match.head|head.*changed/i.test(output)) return { outcome: 'rejected', reason }
    if (/git-gateway-(reviewed-sha-mismatch|tree-invalid|branch-exists-not-owned|not-fast-forward|default-branch|protected-branch|target-invalid)/.test(reason))
      return { outcome: 'refused', reason }
    return { outcome: 'failed', reason }
  }
  async #effect<T>(entry: Omit<GitRecordEntry, 'prev' | 'outcome'>, work: () => Promise<T>): Promise<T> {
    await this.gitRecord.append({ ...entry, outcome: 'intent' })
    let result: T
    try { result = await work() }
    catch (error) { await this.gitRecord.append({ ...entry, at: Date.now(), ...this.#failure(error, entry.op) }); throw error }
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
            catch { continue /* Keep an unavailable push intent open for a later reconciliation. */ }
          }
          await this.gitRecord.append({ ...entry, at: Date.now(), outcome: reconciled ? 'ok' : 'failed', reason: reconciled ? 'reconciled' : 'interrupted' })
        }
      })()
      this.#recoveries.set(repository, recovery)
      void recovery.catch(() => {})
    }
  }
  #url(repository: string): string { repository = canonicalRepository(repository); return this.options.localRemote?.(repository) ?? `https://github.com/${repository}.git` }
  #config(local = false): string[] {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    return ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.askPass=', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(local ? ['-c', 'protocol.file.allow=always', '-c', 'protocol.http.allow=always'] : []),
      '-c', 'credential.helper=', '-c', `credential.helper=!${quote(process.execPath)} ${quote(join(resolve(this.options.directory), 'credential.cjs'))}`,
      '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
  }
  async #git(mirror: string | null, args: readonly string[], local = false): Promise<string> {
    if (mirror && ['fetch', 'push', 'ls-remote'].includes(args[0] ?? '')) await this.#checkMirrorConfig(mirror)
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
    repository = canonicalRepository(repository)
    await this.#init()
    const mirror = join(resolve(this.options.directory), `${createHash('sha256').update(repository).digest('hex')}.git`)
    try { await readFile(join(mirror, 'HEAD')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.#git(null, ['init', '--bare', '--template=', mirror])
      await writeFile(join(mirror, 'config'), this.#mirrorConfig, { mode: 0o600 })
    }
    this.#mirrorRepositories.set(mirror, repository)
    return mirror
  }
  readonly #mirrorConfig = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n\thooksPath = /dev/null\n'
  async #checkMirrorConfig(mirror: string): Promise<void> {
    if (await readFile(join(mirror, 'config'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }) === this.#mirrorConfig) return
    await writeFile(join(mirror, 'config'), this.#mirrorConfig, { mode: 0o600 })
    // A mirror is host state. Record a change whose author the host cannot name.
    const repository = this.#mirrorRepositories.get(mirror)
    if (!repository) throw new Error('git-gateway-mirror-unknown')
    await this.gitRecord.append({ id: randomUUID(), op: 'observed', repository, requester: { kind: 'outside' }, approval: null,
      at: Date.now(), outcome: 'refused', reason: 'git-gateway-mirror-config-reset' })
  }
  readonly #mirrorRepositories = new Map<string, string>()
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
      request = { ...request, repository: canonicalRepository(request.repository) }
      const entry = this.#entry('push', { ...request, lease: request.previousSha })
      let journaled = false
      try {
        await this.#validate(request)
        if (typeof request.objectStore !== 'string' || !request.objectStore || request.objectStore.includes('\0') ||
          request.protectedBases !== undefined && (!Array.isArray(request.protectedBases) || request.protectedBases.some(branch => typeof branch !== 'string' || !branch)))
          throw new Error('git-gateway-target-invalid')
        for (const branch of request.protectedBases ?? []) await this.#validateWrite({ ...request, branch })
        const mirror = await this.#mirror(request.repository), ref = `refs/heads/${request.branch}`
        await this.#git(mirror, ['check-ref-format', ref])
        if (request.requester.kind === 'session') await this.#guardSessionPush(request)
        if (typeof request.tree !== 'string' || !/^[a-f0-9]{40,64}$/.test(request.tree)) throw new Error('git-gateway-tree-invalid')
        // Object intake never executes worker configuration or chooses a remote.
        await this.#git(mirror, ['fetch', '--no-tags', '--no-write-fetch-head', '--', resolve(request.objectStore), request.sha], true)
          .catch(error => { if (/not our ref|couldn.t find remote ref|not a valid|unadvertised object/i.test(String(error))) throw new Error('git-gateway-reviewed-sha-mismatch'); throw error })
        if (await this.#git(mirror, ['rev-parse', `${request.sha}^{commit}`]) !== request.sha ||
          await this.#git(mirror, ['rev-parse', `${request.sha}^{tree}`]) !== request.tree) throw new Error('git-gateway-reviewed-sha-mismatch')
        await this.#git(mirror, ['fsck', '--strict', '--no-reflogs', request.sha])
        const remote = await this.#head(mirror, request.repository, request.branch)
        if (remote === request.sha && (request.previousSha === request.sha || options.reconcile)) {
          // A started journal is not proof that Git pushed: recovery needs the
          // durable success for this exact host requester.
          if (this.hasSucceededPush(request)) return { pushed: false }
          throw new Error(request.previousSha === null ? 'git-gateway-branch-exists-not-owned' : 'git-gateway-owned-head-changed')
        }
        if (request.previousSha === null && remote !== null) throw new Error('git-gateway-branch-exists-not-owned')
        if (request.previousSha !== null) {
          if (remote !== request.previousSha) throw new Error('git-gateway-owned-head-changed')
          await this.#git(mirror, ['fetch', '--no-tags', '--', this.#url(request.repository), request.previousSha], !!this.options.localRemote)
          try { await this.#git(mirror, ['merge-base', '--is-ancestor', request.previousSha, request.sha]) }
          catch { throw new Error('git-gateway-not-fast-forward') }
        }
        await options.beforePush?.()
        journaled = true
        await this.gitRecord.append({ ...entry, outcome: 'intent' })
        let pushError: unknown
        try {
          await this.#git(mirror, ['push', '--porcelain', `--force-with-lease=${ref}:${request.previousSha ?? ''}`, '--', this.#url(request.repository), `${request.sha}:${ref}`], !!this.options.localRemote)
        } catch (error) { pushError = error }
        if (pushError && ['rejected', 'refused'].includes(this.#failure(pushError).outcome)) {
          await this.gitRecord.append({ ...entry, at: Date.now(), ...this.#failure(pushError) }); throw pushError
        }
        let head: string | null
        try { head = await this.#head(mirror, request.repository, request.branch) }
        catch {
          // Verification can fail after receive-pack committed the ref. Retry
          // once; if it is still unreadable only reconciliation can close it.
          try { head = await this.#head(mirror, request.repository, request.branch) }
          catch (error) { throw pushError ?? error }
        }
        if (head !== request.sha) {
          const error = pushError ?? new Error('git-gateway-push-unverified')
          await this.gitRecord.append({ ...entry, at: Date.now(), outcome: 'failed', reason: String(error) }); throw error
        }
        await this.gitRecord.append({ ...entry, at: Date.now(), outcome: 'ok' })
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
  hasSucceededPush(query: SucceededPushQuery): boolean { return this.gitRecord.hasSucceededPush(query) }
  record(query: GitRecordQuery): Promise<GitRecordEntry[]> { return this.#queue(query.repository, () => this.gitRecord.list(query)) }
  async #gh(repository: string, args: readonly string[]): Promise<string> {
    repository = canonicalRepository(repository)
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
    return this.#queue(target.repository, async () => {
      await this.#validate(target)
      return this.#gh(target.repository, target.number === undefined ?
        ['pr', 'list', '--head', target.branch, '--state', 'open', '--json', 'number,url,headRefName,headRefOid,body,isCrossRepository,headRepositoryOwner'] :
        ['pr', 'view', String(target.number), '--json', 'number,title,state,url,body,headRefName,headRefOid,isCrossRepository,headRepositoryOwner,author,additions,deletions,changedFiles'])
    })
  }
  #forgeWrite(op: GitRecordEntry['op'], target: GitWrite, args: readonly string[]): Promise<string> {
    return this.#queue(target.repository, async () => {
      const entry = this.#entry(op, target)
      try { await this.#validateWrite(target, op) }
      catch (error) { await this.gitRecord.append({ ...entry, ...this.#failure(error) }); throw error }
      return this.#effect(entry, () => this.#gh(target.repository, args))
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
    return this.#queue(repository, async () => JSON.parse(await this.#gh(repository, ['repo', 'view', canonicalRepository(repository), '--json', 'nameWithOwner,url,defaultBranchRef'])))
  }
}
