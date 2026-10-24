import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { HARDENED_GIT_CONFIG } from '../git-hardening.js'

const execute = promisify(execFile)
export interface GitRequester { readonly kind: 'lead-goal' | 'session' | 'person'; readonly id: string }
export interface GitTarget { readonly repository: string; readonly branch: string; readonly sha: string; readonly previousSha: string | null; readonly requester: GitRequester }
export interface GitCheckout { readonly branch: string | null; readonly sha: string; readonly tree: string; readonly objectStore: string; readonly commonDir: string }
export interface GitPush extends GitTarget {
  /** A reviewed commit and tree, never a branch to resolve at execution time. */
  readonly objectStore: string; readonly tree: string
}
export interface GitLedgerRecord extends GitTarget {
  readonly op: 'push' | 'createPullRequest' | 'findPullRequest'; readonly at: number; readonly outcome: 'succeeded' | 'failed'
}
export interface GitGatewayOptions {
  readonly directory: string
  readonly gh?: (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Fixture capability only; production always constructs the pinned HTTPS URL. */
  readonly localRemote?: (repository: string) => string
}
/** Host-only executor. No worker, session or runtime receives this capability.
 * Objects cross into a host-owned bare mirror; configuration and hooks never do.
 * The durable intent precedes the effect, and the outcome precedes returning to
 * a caller (in particular, a caller's own journal may lag this ledger on crash).
 */
export class GitGateway {
  #tail: Promise<unknown> = Promise.resolve()
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
  }
  #queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work); this.#tail = result.catch(() => {}); return result
  }
  #validate(target: GitTarget): void {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.repository) || target.repository.split('/').some(part => ['.', '..'].includes(part)) ||
      !/^[a-f0-9]{40,64}$/.test(target.sha) || target.previousSha !== null && !/^[a-f0-9]{40,64}$/.test(target.previousSha) ||
      !['lead-goal', 'session', 'person'].includes(target.requester.kind) || !target.requester.id) throw new Error('git-gateway-target-invalid')
  }
  async #init(): Promise<void> {
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
  async #append(file: string, value: unknown): Promise<void> {
    const handle = await open(join(this.options.directory, file), 'a', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() } finally { await handle.close() }
    const directory = await open(this.options.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
  async #effect<T>(op: GitLedgerRecord['op'], target: GitTarget, work: () => Promise<T>): Promise<T> {
    this.#validate(target); await this.#init()
    const { repository, branch, sha, previousSha, requester } = target
    const record = { op, repository, branch, sha, previousSha, requester, at: Date.now() }
    await this.#append('intents.jsonl', { ...record, id: randomUUID() })
    let result: T
    try { result = await work() }
    catch (error) { await this.#append('ledger.jsonl', { ...record, outcome: 'failed' }); throw error }
    await this.#append('ledger.jsonl', { ...record, outcome: 'succeeded' })
    return result
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
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('git-gateway-repository-invalid')
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
    return this.#queue(async () => this.#head(await this.#mirror(repository), repository, branch))
  }
  push(request: GitPush, options: { readonly reconcile?: boolean; readonly beforePush?: () => Promise<void> } = {}): Promise<{ pushed: boolean }> {
    return this.#queue(async () => {
      this.#validate(request)
      const mirror = await this.#mirror(request.repository), ref = `refs/heads/${request.branch}`
      // Fetch only the reviewed object id. Local transport is allowed on this
      // object intake only, never by the production network executor.
      if (!/^[a-f0-9]{40,64}$/.test(request.tree)) throw new Error('git-gateway-tree-invalid')
      await this.#git(mirror, ['fetch', '--no-tags', '--no-write-fetch-head', '--', resolve(request.objectStore), request.sha], true)
      if (await this.#git(mirror, ['rev-parse', `${request.sha}^{commit}`]) !== request.sha ||
        await this.#git(mirror, ['rev-parse', `${request.sha}^{tree}`]) !== request.tree) throw new Error('git-gateway-reviewed-sha-mismatch')
      await this.#git(mirror, ['fsck', '--strict', '--no-reflogs', request.sha])
      const remote = await this.#head(mirror, request.repository, request.branch)
      if (remote === request.sha && (request.previousSha === request.sha || options.reconcile)) {
        if (this.hasSucceededPush(request)) return { pushed: false }
        throw new Error(request.previousSha === null ? 'git-gateway-branch-exists-not-owned' : 'git-gateway-owned-head-changed')
      }
      if (request.previousSha === null && remote !== null) throw new Error('git-gateway-branch-exists-not-owned')
      if (request.previousSha !== null) {
        if (remote !== request.previousSha) throw new Error('git-gateway-owned-head-changed')
        // A reopened mirror may not yet contain the previously owned tip.
        await this.#git(mirror, ['fetch', '--no-tags', '--', this.#url(request.repository), request.previousSha], !!this.options.localRemote)
        try { await this.#git(mirror, ['merge-base', '--is-ancestor', request.previousSha, request.sha]) }
        catch { throw new Error('git-gateway-not-fast-forward') }
      }
      await options.beforePush?.()
      await this.#effect('push', request, () => this.#git(mirror, ['push', '--porcelain', `--force-with-lease=${ref}:${request.previousSha ?? ''}`, '--', this.#url(request.repository), `${request.sha}:${ref}`], !!this.options.localRemote))
      if (await this.#head(mirror, request.repository, request.branch) !== request.sha) throw new Error('git-gateway-head-changed')
      return { pushed: true }
    })
  }
  /** Fetch the observed head from the pinned destination, never a worker remote. */
  isAncestor(repository: string, owned: string, observed: string): Promise<boolean> {
    return this.#queue(async () => {
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
  async attribute(repository: string, branch: string, sha: string): Promise<GitRequester | 'unknown'> {
    await this.#tail
    let contents: string
    try { contents = await readFile(join(this.options.directory, 'ledger.jsonl'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'unknown'; throw error }
    // A damaged ledger fails closed; it must never invent ownership.
    for (const line of contents.trim().split('\n').reverse()) {
      if (!line) continue
      const row = JSON.parse(line) as GitLedgerRecord
      if (row.op === 'push' && row.outcome === 'succeeded' && row.repository === repository && row.branch === branch && row.sha === sha) return row.requester
    }
    return 'unknown'
  }
  /** A journal's started effect is not proof that Git ever pushed. Recovery
   * requires the durable success for this exact host requester. */
  hasSucceededPush(target: { repository: string; branch: string; sha: string; requester: GitRequester }): boolean {
    let contents: string
    try { contents = readFileSync(join(this.options.directory, 'ledger.jsonl'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    return contents.trim().split('\n').filter(Boolean).some(line => {
      const row = JSON.parse(line) as GitLedgerRecord
      return row.op === 'push' && row.outcome === 'succeeded' && row.repository === target.repository && row.branch === target.branch &&
        row.sha === target.sha && row.requester.kind === target.requester.kind && row.requester.id === target.requester.id
    })
  }
  async #gh(repository: string, args: readonly string[]): Promise<string> {
    await this.#init()
    const command = args[0] === 'pr' ? [...args, '--repo', repository] : [...args]
    if (this.options.gh) {
      const result = await this.options.gh(resolve(this.options.directory), command, this.#env)
      if (result.exitCode !== 0) throw new Error('git-gateway-forge-unavailable')
      return result.stdout.trim()
    }
    return (await execute('gh', command, { cwd: this.options.directory, env: this.#env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
  }
  findPullRequest(target: GitTarget & { readonly number?: number }): Promise<string> {
    return this.#queue(() => this.#effect('findPullRequest', target, () => this.#gh(target.repository, target.number === undefined ?
      ['pr', 'list', '--head', target.branch, '--state', 'open', '--json', 'number,url,headRefName,headRefOid,body,isCrossRepository,headRepositoryOwner'] :
      ['pr', 'view', String(target.number), '--json', 'number,title,state,url,body,headRefName,headRefOid,isCrossRepository,headRepositoryOwner,author,additions,deletions,changedFiles'])))
  }
  createPullRequest(target: GitTarget & { readonly title: string; readonly body: string; readonly base?: string }): Promise<string> {
    return this.#queue(() => this.#effect('createPullRequest', target, () => this.#gh(target.repository,
      ['pr', 'create', '--head', target.branch, ...(target.base ? ['--base', target.base] : []), '--title', target.title, '--body', target.body])))
  }
  repository(repository: string): Promise<{ nameWithOwner: string; url: string; defaultBranchRef?: { name?: string } }> {
    return this.#queue(async () => JSON.parse(await this.#gh(repository, ['repo', 'view', repository, '--json', 'nameWithOwner,url,defaultBranchRef'])))
  }
}
