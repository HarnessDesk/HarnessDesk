import type { CarryOnIncidentView, CarryOnSide, CarryOnTarget, CarryOnTargetState } from '@harnessdesk/protocol'

import { formatReset } from './limits'

/**
 * The words a carry-on incident is said in, shared by the card over the
 * composer and the kept copy in the inbox, so the two never disagree.
 *
 * Every name is the one the host put in the view — the agent's presentation
 * name and the account's nickname or ordinal — never a runtime id or an
 * email (AGENTS.md rule 8).
 */

/** "Agent · work", or the agent alone when it has one account. */
export const carryOnName = (side: Pick<CarryOnSide, 'name' | 'account'>): string =>
  side.account ? `${side.name} · ${side.account}` : side.name

/** What "Switch now" says it will do: stay with the agent on another account, or continue with another agent. */
export const carryOnSwitchLabel = (target: CarryOnTarget): string =>
  target.mode === 'sameThread' ? `Switch to ${carryOnName(target)}` : `Continue in ${carryOnName(target)}`

/** The one chip a candidate that is not simply available wears. */
export const CARRY_ON_TARGET_CHIP: Readonly<Record<CarryOnTargetState, string>> = {
  nearlyOut: 'Nearly out',
  apiKey: 'API key',
  signedOut: 'Signed out',
}

/** The varying fact beside the card's sentence: when the account comes back. */
export const carryOnResetLine = (incident: Pick<CarryOnIncidentView, 'resetsAt'>, now = Date.now()): string =>
  incident.resetsAt === undefined ? 'No reset time known' : `Resets at ${formatReset(incident.resetsAt, now)}`

/**
 * The kept copy of one state of an incident, or nothing for a state that is
 * not news (`deciding`, `sending`, `cleared`): the card and the transcript's
 * marker are where those show.
 */
export const carryOnInboxTitle = (incident: CarryOnIncidentView, now = Date.now()): string | null => {
  const from = carryOnName(incident.from)
  switch (incident.state) {
    case 'asked':
      return `${from} reached its usage limit. Choose how to carry on.`
    case 'moved':
      return incident.to ? `${from} reached its usage limit. Continued on ${carryOnName(incident.to)}.` : `${from} reached its usage limit. Continued elsewhere.`
    case 'waiting-reset':
      return incident.resetsAt === undefined
        ? `${from} reached its usage limit. Waiting for it to reset.`
        : `${from} reached its usage limit. Waiting for it to reset at ${formatReset(incident.resetsAt, now)}.`
    case 'stopped':
      return `${from} reached its usage limit. The conversation stopped.`
    default:
      return null
  }
}
