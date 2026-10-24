import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gitWritePreferences, parseGitWrite, parseGitCommand, type GitSteerMode, type GitWrite, type ToolResult } from '@harnessdesk/protocol'
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
  ask(scope: SteerScope, question: HeldQuestion): Promise<'allowed' | 'standing' | 'refused' | 'unanswered'>
  admit(scope: SteerScope, tool: string, args: unknown): Promise<void>
  invoke(scope: SteerScope, tool: string, args: unknown): Promise<ToolResult>
  say(scope: SteerScope, text: string, banner?: boolean): void
}
const quoted = (value: string) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
export const gitCommandText = (binary: string, argv: readonly string[]) => [binary, ...argv].map(quoted).join(' ')
const find = (name: string, path: string): string => {
  for (const part of path.split(delimiter)) {
    const candidate = resolve(part, name)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
  return ''
}
/** The single settings resolver, host environment installer and steering path. */
export class GitSteering {
  readonly #seen = new Map<string, Set<string>>()
  readonly #tickets = new Map<string, { scope: SteerScope; command: string; op: GitRecordEntry['op']; number?: number; branch?: string; sha?: string; repository: string | null }>()
  readonly directory: string
  readonly #git: string
  readonly #gh: string
  #installed = false
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
        writeFileSync(join(this.directory, binary), `#!/bin/sh\n${process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${quoted(process.execPath)} ${quoted(script)} "$@"\n`, { mode: 0o700 })
      }
      this.#installed = true
    }
    return { PATH: `${this.directory}${delimiter}${path}`, HD_GIT_REAL_GIT: this.#git, HD_GIT_REAL_GH: this.#gh, HD_GIT_STEER: mode, HD_TOOLS_CALLER: caller }
  }
  #key(scope: SteerScope): string { return `${scope.runtime}\0${scope.sessionId}\0${scope.turn}` }
  #mark(scope: SteerScope, command: string): void {
    const key = this.#key(scope), seen = this.#seen.get(key) ?? new Set<string>(); seen.add(command); this.#seen.set(key, seen)
    if (this.#seen.size > 2000) this.#seen.delete(this.#seen.keys().next().value!)
  }
  async #gitRead(scope: SteerScope, args: readonly string[]): Promise<string> {
    return (await exec(this.#git, ['-C', scope.cwd, '--no-pager', '-c', 'core.fsmonitor=false', ...args], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
  }
  async #translate(scope: SteerScope, write: GitWrite): Promise<{ tool: string; args: Record<string, unknown>; branch?: string; sourceBranch?: string; sha?: string }> {
    if (write.kind === 'unmappable') throw new Error(write.reason)
    if (write.kind === 'push') {
      const current = await this.#gitRead(scope, ['branch', '--show-current'])
      const branch = write.branch ?? current
      const sha = await this.#gitRead(scope, ['rev-parse', '--verify', `${write.source ?? 'HEAD'}^{commit}`])
      if (!branch || !current || sha !== await this.#gitRead(scope, ['rev-parse', 'HEAD'])) throw new Error('Only the current checkout HEAD can be sent through git_push.')
      return { tool: 'git_push', args: { branch, set_upstream: write.upstream }, branch, sourceBranch: current, sha }
    }
    const args: Record<string, unknown> = { ...write.args }
    if (write.bodyFile) args['body'] = await readFile(resolve(scope.cwd, write.bodyFile), 'utf8')
    if (write.fill) {
      let base = typeof args['base'] === 'string' ? args['base'] : undefined
      if (!base) {
        const repository = await this.gateway.pins.pinned(scope.root)
        if (repository) base = (await this.gateway.repository(repository)).defaultBranchRef?.name
        if (!base) { try { base = await this.#gitRead(scope, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) } catch { base = 'main' } }
      }
      let comparison = base
      if (!base.startsWith('origin/')) { try { await this.#gitRead(scope, ['rev-parse', '--verify', `refs/remotes/origin/${base}`]); comparison = `origin/${base}` } catch { /* A local base still supplies the commit range. */ } }
      // Ordered commits: first subject followed by commit bodies. Fail rather
      // than open an editor or guess when no base can be established.
      const commits = await this.#gitRead(scope, ['log', '--reverse', '--format=%s%x00%b%x00', `${comparison}..HEAD`, '--'])
      const parts = commits.split('\0')
      args['title'] ??= parts[0]?.trim(); args['body'] ??= parts.filter((_v, i) => i % 2 === 1).map(v => v.trim()).filter(Boolean).join('\n\n')
    }
    if (write.tool === 'pr_create' && (typeof args['title'] !== 'string' || typeof args['body'] !== 'string')) throw new Error('Give --title and --body, or --fill, so HarnessDesk can open the pull request without an editor.')
    if (write.tool === 'pr_merge') { args['method'] ??= 'squash'; if (!args['head']) throw new Error('Use --match-head-commit with the reviewed commit, or pr_merge.') }
    if (write.tool === 'pr_review') args['event'] ??= 'comment'
    return { tool: write.tool, args }
  }
  async handle(runtime: string, sessionId: string, params: Record<string, unknown>): Promise<SteerReply> {
    const scope = await this.port.scope(runtime, sessionId)
    if (!scope) return { action: 'done', ok: false, output: 'HarnessDesk: this caller has no live conversation.' }
    if (typeof params['ticket'] === 'string') return this.#finishOwn(scope, params['ticket'], params['exitCode'])
    if (params['binary'] !== 'git' && params['binary'] !== 'gh' || !Array.isArray(params['argv']) || !params['argv'].every(value => typeof value === 'string')) return { action: 'done', ok: false, output: 'HarnessDesk: invalid steering request.' }
    if (typeof params['cwd'] === 'string' && resolve(params['cwd']) !== resolve(scope.cwd)) return { action: 'done', ok: false, output: 'HarnessDesk: this command is outside the conversation checkout; use the git_push tool.' }
    const command = gitCommandText(params['binary'], params['argv']), write = parseGitWrite(params['binary'], params['argv'])
    if (!write) return { action: 'done', ok: false, output: 'HarnessDesk: this is not a supported git write.' }
    return this.steer(scope, command, write)
  }
  async #refuse(scope: SteerScope, command: string, write: GitWrite | null, reason: string): Promise<void> {
    const repository = await this.gateway.pins.pinned(scope.root)
    if (!repository || !write) return
    const op = write.kind !== 'push' && write.tool ? FORGE_OPERATIONS[write.tool] ?? 'observed' : 'push'
    await this.gateway.refuse(op, { repository, requester: { kind: 'session', id: `${scope.runtime}/${scope.sessionId}`, conversation: { runtime: scope.runtime, sessionId: scope.sessionId } },
      steeredFrom: command, ...(write.kind === 'push' && write.branch ? { branch: write.branch } : {}), ...(write.kind === 'forge' && typeof write.args['number'] === 'number' ? { number: write.args['number'] } : {}) }, reason)
  }
  async steer(scope: SteerScope, command: string, write = parseGitCommand(command), allowOwn = true): Promise<SteerReply> {
    const mode = this.steerFor(scope.root)
    this.#mark(scope, command)
    let invoked = false
    try {
      const translated = write && await this.#translate(scope, write)
      if (!translated) throw new Error('This command cannot be translated. Use git_push or the pr_* tools.')
      await this.port.admit(scope, translated.tool, translated.args)
      if (mode === 'ask') {
        const repository = await this.gateway.pins.pinned(scope.root) ?? await this.gateway.proposedRepository(scope.cwd)
        const becomes = translated.branch ? `Push ${translated.branch} to ${repository ?? 'the project repository'} · ${translated.sha?.slice(0, 7)}` : translated.tool
        const answer = await this.port.ask(scope, { summary: `${scope.name} wants to run ${translated.tool === 'git_push' ? 'git push' : 'a forge write'} itself`,
          reason: `\`\`\`\n${command}\n\`\`\`\nBecomes ${becomes}. Through HarnessDesk the write is recorded and runs without this checkout’s git settings.`, facts: [{ label: 'Command', value: command }, { label: 'Becomes', value: becomes }],
          options: [{ id: 'allow', label: 'Push through HarnessDesk', intent: 'approve' }, ...(allowOwn ? [{ id: 'standing', label: 'Let it use its own git', intent: 'approveAlways' as const }] : []), { id: 'refuse', label: "Don't push", intent: 'deny' }] })
        if (answer === 'standing' && allowOwn) {
          const ticket = randomUUID(), repository = await this.gateway.pins.pinned(scope.root) ?? await this.gateway.proposedRepository(scope.cwd)
          if (!repository) throw new Error('The project repository could not be identified for the outside record. Use git_push to approve the repository first.')
          if (this.#tickets.size >= 2000) throw new Error('Too many own-git commands are waiting for a result.')
          this.#tickets.set(ticket, { scope, command, op: translated.tool === 'git_push' ? 'push' : FORGE_OPERATIONS[translated.tool] ?? 'observed', ...(typeof translated.args['number'] === 'number' ? { number: translated.args['number'] } : {}), repository, ...(translated.branch ? { branch: translated.branch } : {}), ...(translated.sha ? { sha: translated.sha } : {}) })
          this.port.say(scope, `Own git allowed · ${command}`)
          return { action: 'own', ticket }
        }
        if (answer !== 'allowed') { await this.#refuse(scope, command, write, 'The person declined.'); this.port.say(scope, `Not pushed · ${command} · the person declined`); return { action: 'done', ok: false, output: 'HarnessDesk: not pushed — the person declined.' } }
      }
      if (mode === 'off') throw new Error('Steering is off for this project; retry the command with its own git.')
      this.port.say(scope, mode === 'redirect' ? `Sent through HarnessDesk · ${command} · your choice for this project` : `Sent through HarnessDesk · ${command} · you approved`)
      if (translated.sha && await this.#gitRead(scope, ['rev-parse', 'HEAD']) !== translated.sha) throw new Error('The checkout head changed while the steering question waited; retry the push.')
      invoked = true
      const result = await gitSteerContext.run({ command, ...(translated.branch && translated.sourceBranch && translated.sha ? { push: { branch: translated.branch, sourceBranch: translated.sourceBranch, sha: translated.sha } } : {}) }, () => this.port.invoke(scope, translated.tool, translated.args))
      if (!result.ok) throw new Error(result.error)
      const output = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const repository = await this.gateway.pins.pinned(scope.root)
      return { action: 'done', ok: true, output: `${output}\nHarnessDesk: ${translated.branch ? `pushed ${translated.branch} to ${repository} (${translated.sha?.slice(0, 7)})` : 'forge write completed'}, recorded.` }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!invoked) await this.#refuse(scope, command, write, reason)
      this.port.say(scope, `Git write refused · ${command} · ${reason}`)
      return { action: 'done', ok: false, output: `HarnessDesk: not pushed — ${reason}` }
    }
  }
  async #finishOwn(scope: SteerScope, ticket: string, exitCode: unknown): Promise<SteerReply> {
    const pending = this.#tickets.get(ticket)
    if (!Number.isInteger(exitCode) || !pending || pending.scope.runtime !== scope.runtime || pending.scope.sessionId !== scope.sessionId) return { action: 'done', ok: false, output: 'HarnessDesk: invalid own-git receipt.' }
    this.#tickets.delete(ticket)
    if (pending.repository) await this.gateway.gitRecord.append({ id: randomUUID(), op: pending.op, repository: pending.repository, ...(pending.number ? { number: pending.number } : {}), ...(pending.branch ? { branch: pending.branch } : {}), ...(pending.sha ? { sha: pending.sha } : {}), requester: { kind: 'outside' }, approval: { by: 'person', at: Date.now() }, steeredFrom: pending.command, at: Date.now(), outcome: exitCode === 0 ? 'ok' : 'failed', reason: 'own-git-allowed' })
    return { action: 'done', ok: exitCode === 0, output: 'HarnessDesk: own git result recorded as Outside (own-git-allowed).' }
  }
  async completed(scope: SteerScope, command: string, exitCode: number | null | undefined): Promise<void> {
    if (exitCode !== 0 || this.steerFor(scope.root) === 'off' || !parseGitCommand(command)) return
    const seen = this.#seen.get(this.#key(scope))
    if (seen?.has(command)) return
    // Match normalized argv too: the command item may use different quoting.
    const parsed = parseGitCommand(command)
    if (!command.trim().startsWith('/') && seen && [...seen].some(one => JSON.stringify(parseGitCommand(one)) === JSON.stringify(parsed))) return
    this.#mark(scope, command)
    this.port.say(scope, `A push went around HarnessDesk · ${command}`, true)
    if (!this.recordOutside || parsed?.kind !== 'push') return
    const branch = parsed.branch ?? await this.#gitRead(scope, ['branch', '--show-current'])
    const repository = await this.gateway.pins.pinned(scope.root)
    if (repository && branch) { const sha = await this.gateway.remoteHead(repository, branch); if (sha) await this.gateway.observe(repository, branch, sha, null) }
  }
}
