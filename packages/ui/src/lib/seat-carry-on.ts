import { sessionKey, type CarryOnDecisionChoice, type CarryOnIncidentView, type RuntimeId, type TeamEntry } from '@harnessdesk/protocol'

/** One answer a seat's `limit` notice offers, with the words it shows. */
export interface SeatCarryOnChoice {
  readonly choice: CarryOnDecisionChoice
  /** The runtime a switch names: the one the button shows is the one the answer takes, even if the candidates moved. */
  readonly target?: RuntimeId
  readonly label: string
  readonly title: string
  readonly disabled: boolean
}

/**
 * What a seat's `limit` notice offers while its incident is asking: switch
 * to the top candidate, wait for the reset, or stop — the composer card's
 * three answers (design §6.3), on the Team's own notice instead (§9.1).
 * Names come from the incident, which the host filled from the runtime's
 * presentation; nothing here names a runtime. Null when nothing is asked.
 */
export const seatCarryOnChoices = (
  incident: CarryOnIncidentView | undefined,
  timeOf: (at: number) => string,
): readonly SeatCarryOnChoice[] | null => {
  if (!incident || incident.state !== 'asked') return null
  const out: SeatCarryOnChoice[] = []
  const target = incident.choices.target
  if (target) {
    const account = target.account ? ` · ${target.account}` : ''
    out.push(target.mode === 'sameThread'
      ? { choice: 'switch', target: target.runtime, label: `Switch to ${target.name}${account}`, title: `Continue this seat's conversation on ${target.name}${account}`, disabled: false }
      : { choice: 'switch', target: target.runtime, label: `Continue in ${target.name}`, title: `Continue this seat's work in a new conversation on ${target.name}${account}, handed what it had done`, disabled: false })
  }
  out.push({
    choice: 'wait',
    label: 'Wait until reset',
    title: incident.choices.wait && incident.resetsAt !== undefined ? `Try again on this account at ${timeOf(incident.resetsAt)}` : 'No reset time',
    disabled: !incident.choices.wait,
  })
  out.push({ choice: 'stop', label: 'Stop', title: 'Leave this seat stopped', disabled: false })
  return out
}

/**
 * The words of the notice's "Always do this" box, which state where the rule
 * it writes lands: the desk's own rule, or the stuck agent's override — the
 * composer card's words, so the person finds the same rule in Settings.
 */
export const seatCarryOnAlways = (incident: CarryOnIncidentView): string =>
  incident.alwaysScope === 'agent' ? `Always do this for ${incident.from.name}` : 'Always do this'

/**
 * The notices a seat's question hangs on, each to its member's session key:
 * for each member, its latest `limit` notice only, so an older stop in the
 * scrollback never offers an answer to the stop happening now.
 */
export const latestLimitNotices = (entries: readonly TeamEntry[]): ReadonlyMap<string, string> => {
  const last = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind !== 'notice' || entry.cause !== 'limit' || entry.about.kind !== 'agent') continue
    last.set(sessionKey(entry.about.runtime, entry.about.sessionId), entry.id)
  }
  return new Map([...last].map(([key, id]) => [id, key]))
}
