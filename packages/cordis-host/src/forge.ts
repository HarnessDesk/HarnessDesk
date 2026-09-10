import { Service, type Context } from '@deepseek-ai/cordis'

import type { ForgeReference, ScopeQuery } from '@harnessdesk/protocol'

import type { HostRuntime } from './runtime.js'

/**
 * The forge plane, as a plugin sees it: what the desk adds around a git
 * forge that the plugin's own `gh` cannot know.
 *
 * A plugin reaches GitHub with the person's `gh` and its `shell` grant; that
 * is deliberate, and it is where the credential stays. Two things it cannot
 * do for itself come from here. The **seat** — which agent, on which model,
 * at which effort — belongs to the conversation that made the tool call,
 * and only the host that runs that conversation can say. The **record** of
 * what was published belongs in the transcript, drawn as the object it is,
 * and only the host can put it there. Both are engine calls that ride the
 * scope of a live invocation, exactly as the team plane's do.
 */

export interface ForgeSeat {
  /** The agent's presentation name — "Codex", "Gemini CLI" — never a runtime id. */
  readonly agent: string
  /** The agent's own version, when it said one. */
  readonly version: string | null
  /**
   * The model by the agent's own label, or null when the agent's choice is
   * its automatic one: "Gemini CLI", not "Gemini CLI Auto".
   */
  readonly model: string | null
  /** The effort level's label, when the seat has one and it is set. */
  readonly effort: string | null
  readonly thinking: boolean
  /** The seat as one label — "Codex GPT-5.6-Sol · High" — for a template's `{seat}`. */
  readonly label: string
}

export interface ForgeIdentity {
  /** How the desk reaches the forge right now. */
  readonly via: 'gh' | 'app'
  /** The forge login it publishes as, when it can say. */
  readonly login: string | null
  /** False when the forge cannot be reached from this desk — with the reason. */
  readonly available: boolean
  readonly reason: string | null
}

export interface ForgeScope {
  readonly runtime?: string
  readonly sessionId?: string
  /** Which plugin instance is calling; stamped by the service, never by the caller. */
  readonly plugin?: string
}

export interface ForgeEngine {
  /** The seat of the calling conversation, or null when the scope names none the host holds. */
  seat(scope: ForgeScope): Promise<ForgeSeat | null>
  identity(): Promise<ForgeIdentity>
  /** Records what the calling conversation published, into its transcript. */
  publish(reference: ForgeReference, scope: ForgeScope): Promise<void>
}

const state: { engine: ForgeEngine | null } = { engine: null }

export const setForgeEngine = (engine: ForgeEngine | null): void => {
  state.engine = engine
}

const engine = (): ForgeEngine => {
  const found = state.engine
  if (!found) {
    throw new Error('This process has no forge plane: `ctx.forge` needs a running HarnessDesk host.')
  }
  return found
}

const asForgeScope = (scope: ScopeQuery | undefined, plugin?: string): ForgeScope => ({
  ...(scope?.runtime !== undefined ? { runtime: String(scope.runtime) } : {}),
  ...(scope?.sessionId !== undefined ? { sessionId: String(scope.sessionId) } : {}),
  ...(plugin !== undefined ? { plugin } : {}),
})

export class ForgeService extends Service {
  static [Service.tracker] = { associate: 'forge', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'forge')
  }

  /** The permission and the identity of the asker, in one step, for the reason the team service does it. */
  private gate(): string {
    const owner = this.runtime.owner(this.ctx)
    owner.gate.assertForge()
    return String(owner.instanceId)
  }

  async seat(scope?: ScopeQuery): Promise<ForgeSeat | null> {
    const plugin = this.gate()
    return engine().seat(asForgeScope(scope, plugin))
  }

  async identity(): Promise<ForgeIdentity> {
    this.gate()
    return engine().identity()
  }

  async publish(reference: ForgeReference, scope?: ScopeQuery): Promise<void> {
    const plugin = this.gate()
    await engine().publish(reference, asForgeScope(scope, plugin))
  }
}
