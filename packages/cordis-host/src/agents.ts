import { Service, type Context } from '@deepseek-ai/cordis'

import type { ScopeQuery } from '@harnessdesk/protocol'

import type { HostRuntime } from './runtime.js'
import { currentBrowserIdentity, currentInvocationSignal } from './browser-scopes.js'

/**
 * `ctx.agents` — one read-only question to another agent, answered once.
 *
 * The shape is `ctx.team`'s, for the same reason: the agent being asked runs
 * in a process this plugin is not in, under a desk that alone knows which
 * conversation is calling, which Flow seat it holds and what that seat may
 * spend. So the plugin hands over the question and the scope its tool
 * invocation carried, and the host decides everything else — whether the
 * caller may ask at all, whom, how often, and at what ceiling the asked agent
 * runs (read, always).
 *
 * The scope is stamped here, never accepted from the plugin's arguments: the
 * plugin instance and the live invocation are the two facts a plugin cannot
 * choose for itself.
 */

/** The question, as the plugin hands it over. */
export interface AskInput {
  /** Which agent to ask: a runtime id the caller's Flow role lets it ask. */
  readonly agent: string
  readonly question: string
  /** Anything the asked agent needs that is not in the checkout. */
  readonly context: string | null
}

/** The answer, as the host hands it back. The text is the asked agent's, and untrusted. */
export interface AskAnswer {
  readonly text: string
  /** The asked agent's display name (`RuntimeInfo.presentation.name`), never a code-side brand. */
  readonly agentName: string
  readonly truncated: boolean
}

/** The plane's implementation, supplied by whoever is hosting. */
export interface AgentsEngine {
  ask(input: AskInput, scope: AgentsScope): Promise<AskAnswer>
}

/** Which conversation a call is on behalf of — `TeamScope`'s fields, for `TeamScope`'s reasons. */
export interface AgentsScope {
  readonly runtime?: string
  readonly sessionId?: string
  /** Which plugin instance is calling, stamped by the service. */
  readonly plugin?: string
  /** Parent-issued identity for this live tool invocation; never accepted from tool arguments. */
  readonly invocation?: string
  /** Local-only host lifetime. It is deliberately non-enumerable across child IPC. */
  readonly signal?: AbortSignal
}

/** One plane per plugin host — module state, for the reason the team plane's is. */
const state: { engine: AgentsEngine | null } = { engine: null }

export const setAgentsEngine = (engine: AgentsEngine | null): void => {
  state.engine = engine
}

const engine = (): AgentsEngine => {
  const found = state.engine
  if (!found) {
    throw new Error('This process has no agents plane: `ctx.agents` needs a running HarnessDesk host.')
  }
  return found
}

const asAgentsScope = (scope: ScopeQuery | undefined, plugin: string): AgentsScope => {
  const identity = currentBrowserIdentity()
  const answer: AgentsScope = {
    ...(scope?.runtime !== undefined ? { runtime: String(scope.runtime) } : {}),
    ...(scope?.sessionId !== undefined ? { sessionId: String(scope.sessionId) } : {}),
    plugin,
    ...(identity ? { invocation: identity.invocation } : {}),
  }
  const signal = currentInvocationSignal()
  if (signal) Object.defineProperty(answer, 'signal', { value: signal, enumerable: false })
  return answer
}

export class AgentsService extends Service {
  static [Service.tracker] = { associate: 'agents', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'agents')
  }

  /** The grant check and the caller's identity, in one step, as `ctx.team`'s gate. */
  private gate(): string {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertAgentInvoke()
    return String(owner.instanceId)
  }

  /**
   * Ask another agent one question. The input is copied field by field, so
   * nothing else the plugin puts on it reaches the host.
   */
  async ask(input: AskInput, scope?: ScopeQuery): Promise<AskAnswer> {
    const plugin = this.gate()
    const clean: AskInput = {
      agent: String(input?.agent ?? ''),
      question: String(input?.question ?? ''),
      context: typeof input?.context === 'string' ? input.context : null,
    }
    return engine().ask(clean, asAgentsScope(scope, plugin))
  }
}
