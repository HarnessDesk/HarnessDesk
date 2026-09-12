import {
  GLOBAL_SCOPE,
  scopeApplies,
  splitSessionKey,
  type CapabilityContribution,
  type ScopeQuery,
  type SessionKey,
} from '@harnessdesk/protocol'

import type { AppSnapshot } from '../state/snapshot'

/**
 * "May this be offered here?" — asked in one place, for the whole window.
 *
 * Every contribution carries a scope: global, one workspace, one agent, one
 * conversation, one turn. The host evaluates it with `scopeApplies` whenever it
 * is asked what applies — `capability/list`, a command, a hook — but the
 * renderer is *pushed* every contribution regardless of scope, deliberately:
 * `contributions/changed` carries a plugin's whole revision, and a filtered
 * sync would make the plugin page's count jump the first time any plugin
 * reloaded. So the pushed list is the right shape for counting and drawing
 * plugins and the wrong one for deciding what to offer somebody, and every
 * consumer filtered it by `kind` alone — which made a contribution scoped to
 * one project or one conversation read as global in all of them.
 *
 * The answer must not differ between the composer's chip list and the command
 * palette, so both ask here.
 */

/**
 * Which conversation, agent and project a contribution is being asked about.
 *
 * No `turnId`, on purpose. The two calls the window can make on a contribution
 * — `command/run` and `context/resolve` — name a conversation and never a turn,
 * so the host could not match a turn-scoped contribution even if something
 * offered one: `turn` narrows a hook or a tool *inside* a running turn, and a
 * chip attached during one is sent in the next. Not offering it is the honest
 * answer rather than an omission.
 */
export const scopeHere = (
  snapshot: Pick<AppSnapshot, 'activeRuntime' | 'workspace'>,
  key: SessionKey | null,
): ScopeQuery => {
  /* From the key, not from the session map: a conversation is addressed before
     its session object has been read in, and the map answers `undefined` for
     that whole window — which would leave the scope with no `sessionId` and
     quietly drop session-scoped contributions. `activeRuntime` is only the
     fallback, for a draft: it is the agent a *new* conversation would start as,
     and pairing it with an open conversation belonging to another agent asks
     about a conversation that does not exist (`Sidebar.tsx`, and the chip
     resolution in `Composer.tsx`, derive the agent from the key for the same
     reason). */
  const addressed = key ? splitSessionKey(key) : null
  return {
    ...(snapshot.workspace?.path ? { workspaceRoot: snapshot.workspace.path } : {}),
    ...(addressed
      ? { runtime: addressed.runtime, sessionId: addressed.id }
      : snapshot.activeRuntime
        ? { runtime: snapshot.activeRuntime }
        : {}),
  }
}

/**
 * The contributions that apply in a scope — the host's own rule, applied to the
 * list the renderer was pushed.
 *
 * A contribution carrying no scope at all is offered. The wire always sends one,
 * so this is for a value built by hand; a control that vanishes because a field
 * was missing is a worse failure than one offered too widely, and the host still
 * refuses the call either way.
 */
export const contributionsHere = (
  contributions: readonly CapabilityContribution[],
  scope: ScopeQuery,
): readonly CapabilityContribution[] =>
  contributions.filter((entry) => scopeApplies(entry.scope ?? GLOBAL_SCOPE, scope))

/** Both halves, for a consumer holding a snapshot and the conversation it is drawing. */
export const offeredHere = (
  snapshot: Pick<AppSnapshot, 'activeRuntime' | 'contributions' | 'workspace'>,
  key: SessionKey | null,
): readonly CapabilityContribution[] =>
  contributionsHere(snapshot.contributions, scopeHere(snapshot, key))
