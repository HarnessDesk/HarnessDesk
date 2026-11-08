import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { open, realpath, lstat } from 'node:fs/promises'
import { delimiter, join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { promisify } from 'node:util'
import { gitWritePreferences, parseGitWrite, parseGitCommand, gitCommandUsesAbsoluteBinary, gitCommandDirectories, parseCompletedGitCommand, gitAliasResolver, redactGitCommand, type GitSteerMode, type GitWrite, type ToolResult } from '@harnessdesk/protocol'
import type { HeldQuestion } from '../ceilings/gate.js'
import type { GitGateway, GitRecordEntry } from './index.js'
import { gitSteerContext } from './steer-context.js'
const exec = promisify(execFile)
const FORGE_OPERATIONS: Readonly<Record<string, GitRecordEntry['op']>> = { pr_create: 'pr.create', pr_update: 'pr.update', pr_merge: 'pr.merge', pr_comment: 'pr.comment', pr_review: 'pr.review', issue_comment: 'issue.comment' }
export interface SteerScope { readonly runtime: string; readonly sessionId: string; readonly cwd: string; readonly root: string; readonly turn: string; readonly name: string }
export interface SteerReply { readonly action: 'done' | 'own'; readonly ok?: boolean; readonly output?: string; readonly ticket?: string }
export interface SteeringPort {
  preferences(): Record<string, unknown>
  projectOf(cwd: string): Promise<string>
  scope(runtime: string, sessionId: string): Promise<SteerScope | null>
  ask(scope: SteerScope, question: HeldQuestion, signal?: AbortSignal): Promise<'allowed' | 'standing' | 'refused' | 'unanswered'>
  admit(scope: SteerScope, tool: string, args: unknown): Promise<void>
  invoke(scope: SteerScope, tool: string, args: unknown): Promise<ToolResult>
  say(scope: SteerScope, text: string, banner?: boolean): void
}
const quoted = (value: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
export const gitCommandText = (binary: string, argv: readonly string[]) => [binary, ...argv].map(quoted).join(' ')
const find = (name: string, path: string): string => {
  for (const part of path.split(delimiter)) {
    const candidate = resolve(part, name)
    try { accessSync(candidate, constants.X_OK); const actual = realpathSync(candidate); if (dirname(actual).endsWith('/git-steer-bin') || readFileSync(actual).subarray(0, 256).toString().includes('HARNESSDESK_GIT_STAND_IN')) continue; return actual } catch { /* next */ }
  }
  return ''
}
/** The single settings resolver, host environment installer and steering path. */
export class GitSteering {
  readonly #seen = new Map<string, Set<string>>()
  readonly #tickets = new Map<string, { expiresAt: number; scope: SteerScope; command: string; op: GitRecordEntry['op']; number?: number; branch?: string; sha?: string; repository: string | null }>()
  readonly directory: string
  readonly #git: string
  readonly #gh: string
  #installed = false
  readonly #aliases = gitAliasResolver(args => {
    try { return execFileSync(this.#git, [...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return undefined }
  })
  commandCwd(command: string, cwd: string): string { return gitCommandDirectories(command).reduce((base, path) => resolve(base, path), cwd) }
  parseCommand(command: string, cwd: string): GitWrite | null {
    return parseGitCommand(command, 0, (verb, globals) => this.#aliases(verb, ['-C', cwd, ...globals]))
  }
  #expireTickets(): void { for (const [id, ticket] of this.#tickets) if (ticket.expiresAt <= Date.now()) this.#tickets.delete(id) }
  constructor(stateDirectory: string, private readonly gateway: GitGateway, private readonly port: SteeringPort, path = process.env['PATH'] ?? '') {
    this.directory = join(stateDirectory, 'git-steer-bin')
    this.#git = find('git', path); this.#gh = find('gh', path)
  }
  steerFor(root: string): GitSteerMode {
    const raw = this.port.preferences()['gitWrites'] as { projects?: Record<string, unknown> } | undefined
    const override = raw?.projects?.[root]
    return override === 'ask' || override === 'redirect' || override === 'off' ? override : gitWritePreferences(raw).steer
  }
  get recordOutside(): boolean { return gitWritePreferences(this.port.preferences()['gitWrites']).recordOutside }
  async environment(cwd: string, caller: string, path = process.env['PATH'] ?? ''): Promise<Readonly<Record<string, string>> | undefined> {
    const mode = this.steerFor(await this.port.projectOf(cwd))
    if (mode === 'off') return undefined
    if (!this.#installed) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const entry = new URL('./stand-in.js', import.meta.url).href
      for (const binary of ['git', 'gh']) {
        // The shell handles host paths containing spaces, and packaged Electron
        // must run as Node. No PATH lookup for the host interpreter.
        const script = join(this.directory, `${binary}.mjs`)
        writeFileSync(script, `import { runGitStandIn } from ${JSON.stringify(entry)}; await runGitStandIn(${JSON.stringify(binary)}, process.argv.slice(2));\n`, { mode: 0o600 })
        const reads = binary === 'git' ? '--version|status|diff|log|show|rev-parse|rev-list|ls-files|ls-tree|cat-file|for-each-ref|symbolic-ref|describe|blame|grep|help|version|check-ref-format|check-ignore' : 'version|help'
        const realVar = binary === 'git' ? 'HD_GIT_REAL_GIT' : 'HD_GIT_REAL_GH'
        writeFileSync(join(this.directory, binary), `#!/bin/sh\n# HARNESSDESK_GIT_STAND_IN\ncase "$1" in ${reads})\n  real="$${realVar}"\n  case "$real" in */git-steer-bin/*|"") echo 'HarnessDesk: refusing recursive or unavailable git stand-in.' >&2; exit 1;; esac\n  if LC_ALL=C /usr/bin/head -c 256 \"$real\" | /usr/bin/grep -q HARNESSDESK_GIT_STAND_IN; then echo 'HarnessDesk: refusing recursive git stand-in.' >&2; exit 1; fi\n  unset HD_TOOLS_SOCKET HD_TOOLS_CALLER HD_GIT_CALLER\n  exec "$real" "$@";;\nesac\n${process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${quoted(process.execPath)} ${quoted(script)} "$@"\n`, { mode: 0o700 })
      }
      // Restore PATH after login profiles without replacing the user's files.
      for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) writeFileSync(join(this.directory, file), `hd_profile="\${HD_GIT_USER_ZDOTDIR:-$HOME}/${file}"\nZDOTDIR="\${HD_GIT_USER_ZDOTDIR:-$HOME}"\nexport ZDOTDIR\nif [ "$hd_profile" != ${quoted(join(this.directory, file))} ] && [ -f "$hd_profile" ]; then . "$hd_profile"; fi\nif [ "$HISTFILE" = ${quoted(join(this.directory, ".zsh_history"))} ]; then HISTFILE="$ZDOTDIR/.zsh_history"; fi\n: \${HISTFILE:=$ZDOTDIR/.zsh_history}\nexport HISTFILE\nexport ZDOTDIR=${quoted(this.directory)}\nexport PATH=${quoted(this.directory)}:$PATH\n`, { mode: 0o600 })
      this.#installed = true
    }
    return { PATH: `${this.directory}${delimiter}${path}`, HD_GIT_REAL_GIT: this.#git, HD_GIT_REAL_GH: this.#gh, HD_GIT_STEER: mode, HD_GIT_CALLER: caller, ZDOTDIR: this.directory, HD_GIT_USER_ZDOTDIR: process.env['HD_GIT_USER_ZDOTDIR'] ?? process.env['ZDOTDIR'] ?? '' }
  }
  #key(scope: SteerScope): string { return `${scope.runtime}\0${scope.sessionId}\0${scope.turn}` }
  #mark(scope: SteerScope, command: string): void {
    const key = this.#key(scope), seen = this.#seen.get(key) ?? new Set<string>(); seen.add(command); this.#seen.set(key, seen)
    if (this.#seen.size > 2000) this.#seen.delete(this.#seen.keys().next().value!)
  }
  async #gitRead(scope: SteerScope, args: readonly string[]): Promise<string> {
    return (await exec(this.#git, ['-C', scope.cwd, '--no-pager', '-c', 'core.fsmonitor=false', ...args], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
  }
  async #translate(scope: SteerScope, write: GitWrite, cwd: string): Promise<{ tool: string; args: Record<string, unknown>; branch?: string; sourceBranch?: string; sha?: string }> {
    if (write.kind === 'unmappable') throw new Error(write.reason)
    if (write.kind === 'push') {
      const current = await this.#gitRead(scope, ['branch', '--show-current'])
      const branch = write.branch ?? current
      const sha = await this.#gitRead(scope, ['rev-parse', '--verify', '--end-of-options', `${write.source ?? 'HEAD'}^{commit}`])
      if (!branch || !current || sha !== await this.#gitRead(scope, ['rev-parse', 'HEAD'])) throw new Error('Only the current checkout HEAD can be sent through git_push.')
      return { tool: 'git_push', args: { branch, set_upstream: write.upstream }, branch, sourceBranch: current, sha }
    }
    const args: Record<string, unknown> = { ...write.args }
    if (write.bodyFile) {
      if (isAbsolute(write.bodyFile)) throw new Error('Body files must be regular files inside the checkout, at most 64 KiB.')
      const path = await realpath(resolve(cwd, write.bodyFile))
      if (!await this.inside(scope.cwd, path)) throw new Error('Body file is outside the conversation checkout.')
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        const currentPath = await realpath(resolve(cwd, write.bodyFile)), current = await lstat(currentPath)
        if (!await this.inside(scope.cwd, currentPath) || currentPath !== path || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Body file changed while it was opened.')
        if (!stat.isFile() || stat.nlink > 1 || stat.size > 65536) throw new Error('Body files must be regular files inside the checkout, at most 64 KiB.')
        const buffer = Buffer.alloc(65537), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 65536) throw new Error('Body file exceeds 64 KiB.')
        args['body'] = buffer.subarray(0, bytesRead).toString('utf8')
      } finally { await file.close() }
    }
    if (write.fill) {
      let base = typeof args['base'] === 'string' ? args['base'] : undefined
      if (!base) {
        const repository = await this.gateway.pins.pinned(scope.root)
        if (repository) base = (await this.gateway.repository(repository)).defaultBranchRef?.name
        if (!base) { try { base = await this.#gitRead(scope, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) } catch { base = 'main' } }
      }
      if (!/^(?![-/])(?!.*(?:\.\.|[~^:?*\[\]\\\s]))[A-Za-z0-9_./-]+$/.test(base)) throw new Error('Invalid pull request base branch.')
      let comparison = base
      if (!base.startsWith('origin/')) { try { await this.#gitRead(scope, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]); comparison = `origin/${base}` } catch { /* A local base still supplies the commit range. */ } }
      // Ordered commits: first subject followed by commit bodies. Fail rather
      // than open an editor or guess when no base can be established.
      const commits = await this.#gitRead(scope, ['log', '--reverse', '--format=%s%x00%b%x00', '--end-of-options', `${comparison}..HEAD`, '--'])
      const parts = commits.split('\0')
      args['title'] ??= parts[0]?.trim(); args['body'] ??= parts.filter((_v, i) => i % 2 === 1).map(v => v.trim()).filter(Boolean).join('\n\n')
    }
    if (write.tool === 'pr_create' && (typeof args['title'] !== 'string' || typeof args['body'] !== 'string')) throw new Error('Give --title and --body, or --fill, so HarnessDesk can open the pull request without an editor.')
    if (write.tool === 'pr_merge') { args['method'] ??= 'squash'; if (!args['head']) throw new Error('Use --match-head-commit with the reviewed commit, or pr_merge.') }
    if (write.tool === 'pr_review') args['event'] ??= 'comment'
    return { tool: write.tool, args }
  }
  async handle(runtime: string, sessionId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<SteerReply> {
    const scope = await this.port.scope(runtime, sessionId)
    if (!scope) return { action: 'done', ok: false, output: 'HarnessDesk: this caller has no live conversation.' }
    if (params['modeOnly'] === true) return { action: this.steerFor(scope.root) === 'off' ? 'own' : 'done' }
    if (typeof params['ticket'] === 'string') return this.#finishOwn(scope, params['ticket'], params['exitCode'])
    if (params['binary'] !== 'git' && params['binary'] !== 'gh' || !Array.isArray(params['argv']) || !params['argv'].every(value => typeof value === 'string')) return { action: 'done', ok: false, output: 'HarnessDesk: invalid steering request.' }
    if (typeof params['cwd'] === 'string' && !await this.inside(scope.cwd, params['cwd'])) return { action: 'done', ok: false, output: 'HarnessDesk: this command is outside the conversation checkout; use the git_push tool.' }
    const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : scope.cwd
    const command = gitCommandText(params['binary'], params['argv']), write = parseGitWrite(params['binary'], params['argv'], (verb, globals) => this.#aliases(verb, ['-C', cwd, ...globals]))
    if (!write) return { action: 'own' }
    if (!await this.sameCheckout(scope.cwd, cwd)) return { action: 'done', ok: false, output: 'HarnessDesk: this command is in a different repository; use its own conversation.' }
    return this.steer(scope, command, write, true, signal, cwd)
  }
  async inside(root: string, cwd: string): Promise<boolean> {
    try { const path = relative(await realpath(root), await realpath(cwd)); return path === '' || !path.startsWith('../') && path !== '..' && !isAbsolute(path) } catch { return false }
  }
  async sameCheckout(root: string, cwd: string): Promise<boolean> {
    if (!await this.inside(root, cwd)) return false
    try {
      const top = async (path: string) => realpath((await exec(this.#git, ['-C', path, 'rev-parse', '--show-toplevel'], { timeout: 5000 })).stdout.trim())
      return await top(root) === await top(cwd)
    } catch { return false }
  }
  async #refuse(scope: SteerScope, command: string, write: GitWrite | null, reason: string): Promise<void> {
    const repository = await this.gateway.pins.pinned(scope.root)
    if (!repository || !write || write.kind === 'unmappable' && !write.tool) return
    const op = write.kind !== 'push' && write.tool ? FORGE_OPERATIONS[write.tool] ?? 'observed' : 'push'
    await this.gateway.refuse(op, { repository, requester: { kind: 'session', id: `${scope.runtime}/${scope.sessionId}`, conversation: { runtime: scope.runtime, sessionId: scope.sessionId } },
      steeredFrom: command, ...(write.kind === 'push' && write.branch ? { branch: write.branch } : {}), ...(write.kind === 'forge' && typeof write.args['number'] === 'number' ? { number: write.args['number'] } : {}) }, reason)
  }
  async steer(scope: SteerScope, command: string, write = this.parseCommand(command, scope.cwd), allowOwn = true, signal?: AbortSignal, cwd = scope.cwd): Promise<SteerReply> {
    this.#expireTickets()
    const mode = this.steerFor(scope.root)
    if (!write) return { action: 'own' }
    this.#mark(scope, command)
    command = redactGitCommand(command)
    if (mode === 'off') return { action: 'own' }
    let invoked = false
    let approved: { repository: string; branch: string; sha: string } | undefined
    try {
      signal?.throwIfAborted()
      if (!await this.sameCheckout(scope.cwd, cwd)) throw new Error('The command is in a different repository.')
      if (write) await this.port.admit(scope, write.kind === 'push' ? 'git_push' : write.tool ?? 'git_push', write.kind === 'forge' ? write.args : {})
      const translated = write && await this.#translate(scope, write, cwd)
      if (!translated) throw new Error('This command cannot be translated. Use git_push or the pr_* tools.')
      if (mode === 'ask') {
        const pinned = await this.gateway.pins.pinned(scope.root)
        const repository = pinned ?? await this.gateway.proposedRepository(scope.cwd)
        const becomes = translated.branch ? `Push ${translated.branch} to ${repository ?? 'the project repository'} · ${translated.sha?.slice(0, 7)}` : translated.tool
        const push = translated.tool === 'git_push'
        const answer = await this.port.ask(scope, { gateway: true, summary: `${scope.name} wants to run ${translated.tool === 'git_push' ? 'git push' : 'a forge write'} itself`,
          reason: `${!pinned && push ? 'Approve and pin this repository for the project. ' : ''}Through HarnessDesk the write is recorded and runs without this checkout’s git settings. Its own command is not recorded as HarnessDesk’s.`, facts: [{ label: 'Repository', value: `${repository ?? 'Not pinned'}${!pinned && push ? ' (pinned on approval)' : ''}` }, ...(translated.branch ? [{ label: 'Branch', value: translated.branch }, { label: 'Head', value: translated.sha! }] : []), { label: 'Command', value: command }, { label: 'Becomes', value: becomes }],
          options: [{ id: 'allow', label: push ? 'Push through HarnessDesk' : 'Write through HarnessDesk', intent: 'approve' }, ...(allowOwn ? [{ id: 'own', label: push ? 'Let it use its own git' : 'Let it use its own gh', intent: 'alternative' as const }] : []), { id: 'refuse', label: push ? "Don't push" : "Don't write", intent: 'deny' }] }, signal)
        signal?.throwIfAborted()
        if (answer === 'standing' && allowOwn) {
          const ticket = randomUUID(), repository = await this.gateway.pins.pinned(scope.root) ?? await this.gateway.proposedRepository(scope.cwd)
          if (!repository) throw new Error('The project repository could not be identified for the outside record. Use git_push to approve the repository first.')
          if (this.#tickets.size >= 2000) throw new Error('Too many own-git commands are waiting for a result.')
          this.#expireTickets()
          this.#tickets.set(ticket, { expiresAt: Date.now() + 10 * 60_000, scope, command, op: translated.tool === 'git_push' ? 'push' : FORGE_OPERATIONS[translated.tool] ?? 'observed', ...(typeof translated.args['number'] === 'number' ? { number: translated.args['number'] } : {}), repository, ...(translated.branch ? { branch: translated.branch } : {}), ...(translated.sha ? { sha: translated.sha } : {}) })
          this.port.say(scope, `Own git allowed · ${command}`)
          return { action: 'own', ticket }
        }
        if (answer === 'allowed' && repository && translated.branch && translated.sha) approved = { repository, branch: translated.branch, sha: translated.sha }
        if (answer !== 'allowed') { await this.#refuse(scope, command, write, 'The person declined.'); this.port.say(scope, `Not pushed · ${command} · the person declined`); return { action: 'done', ok: false, output: 'HarnessDesk: not pushed — the person declined.' } }
      }
      signal?.throwIfAborted()
      this.port.say(scope, mode === 'redirect' ? `Sent through HarnessDesk · ${command} · your choice for this project` : `Sent through HarnessDesk · ${command} · you approved`)
      if (translated.sha && await this.#gitRead(scope, ['rev-parse', 'HEAD']) !== translated.sha) throw new Error('The checkout head changed while the steering question waited; retry the push.')
      invoked = true
      const result = await gitSteerContext.run({ command, admitted: true, signal, approved, ...(translated.branch && translated.sourceBranch && translated.sha ? { push: { branch: translated.branch, sourceBranch: translated.sourceBranch, sha: translated.sha } } : {}) }, () => this.port.invoke(scope, translated.tool, translated.args))
      if (!result.ok) throw new Error(result.error)
      const output = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const repository = await this.gateway.pins.pinned(scope.root)
      return { action: 'done', ok: true, output: `${output}\nHarnessDesk: ${translated.branch ? `pushed ${translated.branch} to ${repository} (${translated.sha?.slice(0, 7)})` : 'forge write completed'}, recorded.` }
    } catch (error) {
      const reason = redactGitCommand(error instanceof Error ? error.message : String(error))
      if (!invoked) await this.#refuse(scope, command, write, reason)
      this.port.say(scope, `Git write refused · ${command} · ${reason}`)
      return { action: 'done', ok: false, output: `HarnessDesk: not pushed — ${reason}` }
    }
  }
  async #finishOwn(scope: SteerScope, ticket: string, exitCode: unknown): Promise<SteerReply> {
    this.#expireTickets()
    const pending = this.#tickets.get(ticket)
    if (!Number.isInteger(exitCode) || !pending || pending.scope.runtime !== scope.runtime || pending.scope.sessionId !== scope.sessionId) return { action: 'done', ok: false, output: 'HarnessDesk: invalid own-git receipt.' }
    this.#tickets.delete(ticket)
    // A receipt is only a hint to re-read the pinned remote, never proof of
    // what the caller wrote. Outside recording includes person-allowed git.
    if (this.recordOutside && pending.repository && pending.branch) {
      const sha = await this.gateway.remoteHead(pending.repository, pending.branch, { reason: 'own-git-allowed', steeredFrom: pending.command, approval: { by: 'person', at: Date.now() } })
      void sha
    }
    return { action: 'done', ok: exitCode === 0, output: 'HarnessDesk: own git result recorded as Outside (own-git-allowed).' }
  }
  async completed(scope: SteerScope, command: string, exitCode: number | null | undefined, cwd = scope.cwd): Promise<void> {
    if (exitCode !== 0) return
    cwd = this.commandCwd(command, cwd)
    const parsed = parseCompletedGitCommand(command, (verb, globals) => this.#aliases(verb, ['-C', cwd, ...globals]))
    if (!parsed || parsed.kind === 'unmappable' || !await this.sameCheckout(scope.cwd, cwd)) return
    if (this.steerFor(scope.root) !== 'off') {
      const seen = this.#seen.get(this.#key(scope))
      if (seen?.has(command)) return
      // Match normalized argv too: the command item may use different quoting.
      if (!gitCommandUsesAbsoluteBinary(command) && seen && [...seen].some(one => JSON.stringify(this.parseCommand(one, cwd)) === JSON.stringify(parsed))) return
      this.#mark(scope, command)
      this.port.say(scope, `${parsed.kind === 'push' ? 'A push' : 'A forge write'} went around HarnessDesk · ${redactGitCommand(command)}`, true)
    }
    if (!this.recordOutside || parsed.kind !== 'push' || !await this.inside(scope.cwd, cwd)) return
    const branch = parsed.branch ?? await this.#gitRead(scope, ['branch', '--show-current'])
    const repository = await this.gateway.pins.pinned(scope.root)
    if (repository && branch) { const sha = await this.gateway.remoteHead(repository, branch); if (sha) await this.gateway.observe(repository, branch, sha, null) }
  }
}
