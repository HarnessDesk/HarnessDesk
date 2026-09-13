import { Service, type Context } from '@deepseek-ai/cordis'

import type { ScopeQuery } from '@harnessdesk/protocol'

import type { HostRuntime } from './runtime.js'

/**
 * `ctx.team` — the shared board and inter-agent messages, driven as data.
 *
 * The shape is `ctx.editor`'s, for the same reason: the thing being driven
 * lives in a process this plugin is not in. The board is host state so that
 * claiming is a transaction rather than a lock file, and messages are host
 * routing so that one set of guards — attribution, rate limits, inbound
 * policy, the audit row — applies whichever vendor's agent is calling.
 *
 * Every verb takes the `ScopeQuery` its tool invocation carried, because
 * "which conversation is asking" is the whole ballgame here: a claim without
 * an owner is meaningless and a message without a sender is unsafe. The
 * *host* decides what an unscoped call may do (today: nothing), so a plugin
 * cannot promote itself by inventing a scope — the scope is checked against
 * the host's own record of live sessions.
 *
 * Results are prose for the calling model, composed host-side so the board
 * reads identically to every agent. Expected outcomes — a claim someone got
 * first, a path conflict — come back as sentences rather than throws.
 */

/** The plane's implementation, supplied by whoever is hosting. */
export interface TeamEngine {
  board(scope: TeamScope): Promise<string>
  addIntent(
    args: {
      readonly title: string
      readonly detail?: string
      readonly files?: readonly string[]
      readonly dependsOn?: readonly number[]
    },
    scope: TeamScope,
  ): Promise<string>
  claim(intent: number, scope: TeamScope, files?: readonly string[]): Promise<string>
  claimNext(scope: TeamScope, files?: readonly string[]): Promise<string>
  awaitWork(
    scope: TeamScope,
    options: { readonly blockMs?: number; readonly cycle?: number },
  ): Promise<string>
  conflicts(paths: readonly string[], scope: TeamScope): Promise<string>
  complete(
    intent: number,
    args: { readonly note?: string; readonly handoff?: string; readonly outcome?: string },
    scope: TeamScope,
  ): Promise<string>
  release(
    intent: number,
    args: { readonly reason?: string; readonly blocked?: boolean },
    scope: TeamScope,
  ): Promise<string>
  handoff(intent: number, scope: TeamScope): Promise<string>
  status(scope: TeamScope): Promise<string>
  send(
    args: { readonly to: string; readonly text: string; readonly wake?: boolean },
    scope: TeamScope,
  ): Promise<string>
}

/** Which conversation a call is on behalf of; the serialisable half of a ScopeQuery. */
export interface TeamScope {
  readonly runtime?: string
  readonly sessionId?: string
  /**
   * Which plugin instance is calling, stamped here rather than passed by the
   * caller: `ctx.team` is a per-plugin service, so this is the one fact about
   * a team call that the plugin cannot choose for itself.
   *
   * The parent uses it to check that *this* plugin is the one it dispatched
   * to, instead of accepting any call that arrives while some team-granted
   * plugin somewhere in the process happens to be running.
   */
  readonly plugin?: string
}

/**
 * One plane per plugin host — module state, for the reason the editor's is:
 * cordis hands plugins a proxy of the service, which native `#private`
 * fields refuse.
 */
const state: { engine: TeamEngine | null } = { engine: null }

export const setTeamEngine = (engine: TeamEngine | null): void => {
  state.engine = engine
}

const engine = (): TeamEngine => {
  const found = state.engine
  if (!found) {
    throw new Error('This process has no team plane: `ctx.team` needs a running HarnessDesk host.')
  }
  return found
}

/** Only what the host can verify travels; a turn id would be decoration here. */
const asTeamScope = (scope: ScopeQuery | undefined, plugin?: string): TeamScope => ({
  ...(scope?.runtime !== undefined ? { runtime: String(scope.runtime) } : {}),
  ...(scope?.sessionId !== undefined ? { sessionId: String(scope.sessionId) } : {}),
  ...(plugin !== undefined ? { plugin } : {}),
})

export class TeamService extends Service {
  static [Service.tracker] = { associate: 'team', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'team')
  }

  /**
   * Checks the permission and answers who is asking, in one step, because
   * these two must never come apart: the identity the parent is handed has
   * to be the identity whose grant was just verified.
   */
  private gate(): string {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertTeam()
    return String(owner.instanceId)
  }

  async board(scope?: ScopeQuery): Promise<string> {
    const plugin = this.gate()
    return engine().board(asTeamScope(scope, plugin))
  }

  async addIntent(
    args: {
      readonly title: string
      readonly detail?: string
      readonly files?: readonly string[]
      readonly dependsOn?: readonly number[]
    },
    scope?: ScopeQuery,
  ): Promise<string> {
    const plugin = this.gate()
    return engine().addIntent(args, asTeamScope(scope, plugin))
  }

  async claim(intent: number, scope?: ScopeQuery, files?: readonly string[]): Promise<string> {
    const plugin = this.gate()
    return engine().claim(intent, asTeamScope(scope, plugin), files)
  }

  async claimNext(scope?: ScopeQuery, files?: readonly string[]): Promise<string> {
    const plugin = this.gate()
    return engine().claimNext(asTeamScope(scope, plugin), files)
  }

  async awaitWork(
    options: { readonly blockMs?: number; readonly cycle?: number },
    scope?: ScopeQuery,
  ): Promise<string> {
    const plugin = this.gate()
    return engine().awaitWork(asTeamScope(scope, plugin), options)
  }

  async conflicts(paths: readonly string[], scope?: ScopeQuery): Promise<string> {
    const plugin = this.gate()
    return engine().conflicts(paths, asTeamScope(scope, plugin))
  }

  async complete(
    intent: number,
    args: { readonly note?: string; readonly handoff?: string; readonly outcome?: string },
    scope?: ScopeQuery,
  ): Promise<string> {
    const plugin = this.gate()
    return engine().complete(intent, args, asTeamScope(scope, plugin))
  }

  async release(
    intent: number,
    args: { readonly reason?: string; readonly blocked?: boolean },
    scope?: ScopeQuery,
  ): Promise<string> {
    const plugin = this.gate()
    return engine().release(intent, args, asTeamScope(scope, plugin))
  }

  async handoff(intent: number, scope?: ScopeQuery): Promise<string> {
    const plugin = this.gate()
    return engine().handoff(intent, asTeamScope(scope, plugin))
  }

  async status(scope?: ScopeQuery): Promise<string> {
    const plugin = this.gate()
    return engine().status(asTeamScope(scope, plugin))
  }

  async send(
    args: { readonly to: string; readonly text: string; readonly wake?: boolean },
    scope?: ScopeQuery,
  ): Promise<string> {
    const plugin = this.gate()
    return engine().send(args, asTeamScope(scope, plugin))
  }
}
