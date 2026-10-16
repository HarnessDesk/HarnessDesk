import type { AppSnapshot } from '../state/snapshot'
import type { AppStore } from '../state/store'
import { INBOX_LIMIT, type InboxEntry } from './inbox'
import { teamsInput } from './teams-snapshot'
import { namedGoalRun } from './goal-run'

const KIND = 'team:waiting'
const savedRunOf = (entry: InboxEntry): string | null => {
  if (entry.kind !== KIND) return null
  try {
    const run: unknown = JSON.parse(entry.id)[2]
    return typeof run === 'string' ? run : null
  } catch { return null }
}

/** Live waits share Needs-you facts and the host's ordinary occurrence receipts. */
export class TeamInbox {
  readonly #offered = new Map<string, string>()
  #hydrated = false
  #refresh = false

  constructor(private readonly save: (patch: { inbox: readonly InboxEntry[] }, base: { inbox: readonly InboxEntry[] }) => Promise<void>) {}

  /** One startup read, including named ended Runs so saved waits can be retired. */
  async hydrate(store: Pick<AppStore, 'transport' | 'getSnapshot' | 'readFlowExecutions'>, refresh: () => void): Promise<void> {
    try {
      const active = await store.transport.request('flow/executions', { active: true })
      const snapshot = store.getSnapshot()
      const savedTeams = new Set(snapshot.inbox.filter(entry => entry.kind === KIND).map(entry => entry.open))
      const named = [...snapshot.goals.values()].filter(view => savedTeams.has(`team:${view.goal.id}`)).map(namedGoalRun).filter((id): id is string => id !== null)
      const saved = snapshot.inbox.map(savedRunOf).filter((id): id is string => id !== null)
      await store.readFlowExecutions([...active.map(run => run.id), ...named, ...saved])
      this.#hydrated = store.getSnapshot().goalProblem === null
      this.#refresh = true
      refresh()
    } catch {
      // Unavailable facts are not proof that a saved wait has ended.
    }
  }

  reconcile(next: AppSnapshot, previous: AppSnapshot): readonly InboxEntry[] {
    if (!next.preferencesLoaded) return next.inbox
    if (!this.#refresh && next.inbox === previous.inbox && next.teams === previous.teams && next.goals === previous.goals && next.flowExecutions === previous.flowExecutions && next.approvals === previous.approvals && next.preferencesLoaded === previous.preferencesLoaded) return next.inbox
    this.#refresh = false
    const live: InboxEntry[] = []
    const known = new Set<string>()
    const waiting = new Set<string>()
    for (const { team, goal, execution, overview } of teamsInput(next)) {
      const named = namedGoalRun(goal)
      const savedRunMissing = next.inbox.some(entry => {
        if (entry.kind !== KIND || entry.open !== `team:${team.id}`) return false
        const run = savedRunOf(entry)
        return run !== null && !next.flowExecutions.has(run)
      })
      if (!goal || (goal.goal.state !== 'wrapped' && ((named && !next.flowExecutions.has(named)) || savedRunMissing))) continue
      known.add(team.id)
      if (goal?.goal.state === 'wrapped' || (execution && execution.state !== 'running' && execution.state !== 'stalled')) continue
      for (const wait of overview.needsYou) {
        const id = JSON.stringify([KIND, team.id, execution?.id, wait.kind, wait.sessionKey ?? null, wait.approval ?? wait.card])
        waiting.add(id)
        const old = next.inbox.find(entry => entry.id === id)
        // A clear or a host refusal keeps this live occurrence absent. A new
        // occurrence can be offered only after the selector stops reporting it.
        if (!old && this.#offered.has(id)) continue
        const at = old?.at ?? wait.since
        this.#offered.set(id, team.id)
        live.push({ id, kind: KIND, tone: 'warning', title: team.name, body: wait.summary, at, read: old?.read ?? false, open: `team:${team.id}` })
      }
    }
    const unknown = (entry: InboxEntry): boolean => {
      const team = entry.open?.startsWith('team:') ? entry.open.slice(5) : null
      return team !== null && !known.has(team) && (!this.#hydrated || next.teams.has(team))
    }
    for (const [id, team] of this.#offered) {
      if (!waiting.has(id) && (known.has(team) || (this.#hydrated && !next.teams.has(team)))) this.#offered.delete(id)
    }
    const inbox = [...live, ...next.inbox.filter(entry => entry.kind !== KIND || unknown(entry))].sort((a, b) => b.at - a.at).slice(0, INBOX_LIMIT)
    // Host merges may order equal-time rows differently. An order-only
    // difference is not an edit, and must not start another preference write.
    if (inbox.length === next.inbox.length && inbox.every(entry => JSON.stringify(entry) === JSON.stringify(next.inbox.find(old => old.id === entry.id)))) return next.inbox
    // Admit against the pre-derivation baseline, before read/clear edits can
    // name the row. The host merges other windows' reads and cleared receipts.
    void this.save({ inbox }, { inbox: next.inbox })
    return inbox
  }
}

/** A kept destination is data; resolve it to the Team's ordinary door on use. */
export const teamInboxAction = (entry: InboxEntry, store: Pick<AppStore, 'openTeamRoom'>) => entry.open?.startsWith('team:')
  ? { go: () => store.openTeamRoom(entry.open!.slice('team:'.length)), goLabel: 'Open the Team' }
  : {}
