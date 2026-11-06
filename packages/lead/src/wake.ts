import { isWaitingOnYou, type LeadStage, type LeadAction, type LeadRunClass, type LeadRunReading } from '@harnessdesk/protocol'
import type { ClientSnapshot } from '@harnessdesk/client'

/**
 * Whether desk activity is worth a model turn.
 *
 * Every owned run's event used to wake the model, and the model then read the
 * desk to find, most of the time, that nothing it could act on had changed: a
 * worker had written another line, a seat had taken another turn. Each of those
 * wakes is a paid request that ends in "still running". The gate keeps the
 * facts a manager acts on — how each run stands, what waits for the person,
 * what a review said — and wakes the model only when one of them moved, or when
 * a run has gone quiet for long enough to call stuck. Everything else is a
 * check the host makes for free and records as one.
 */

export type { LeadRunClass, LeadRunReading }
export interface LeadWakeCounts {
  /** Desk changes the host looked at since the model last spoke. */
  readonly checked: number
  /** Of those, the ones that changed nothing the model acts on. */
  readonly quiet: number
  /** When the host last looked; null before the first look. */
  readonly lastCheckedAt: number | null
}
export const LEAD_STUCK_MS = 20 * 60_000

export interface LeadObservedStage { readonly id: string; readonly stage: LeadStage }

type TeamWakeStage = 'waiting' | 'active' | 'idle' | null
// The three person stages share a predicate; working/queued share background work.
const teamWakeStage = (stage: LeadStage | undefined): TeamWakeStage => stage === undefined ? null : isWaitingOnYou(stage) ? 'waiting' : stage === 'idle' ? 'idle' : 'active'

type Owned = { readonly runs: readonly string[]; readonly teams: readonly string[] }

/** The facts a decision rests on, as one comparable string. Activity that only adds lines leaves it unchanged. */
export const leadDeskFingerprint = (snapshot: ClientSnapshot | null, owned: Owned, actions: readonly LeadAction[], chats: readonly LeadObservedStage[] = []): string => {
  if (!snapshot) return 'unsynchronized'
  const runs = snapshot.runs.filter(run => owned.runs.includes(run.id)).map(run => ({
    id: run.id, state: run.state, reason: run.reason, end: run.end?.kind ?? null,
    rounds: run.rounds.map(round => `${round.n}:${round.role}:${round.state}`),
    operations: run.operations.map(operation => `${operation.key}:${operation.state}`),
  })).sort((a, b) => a.id.localeCompare(b.id))
  // A board is where a run's person gate and its findings land; any change on an owned one is a fact, not chatter.
  const boards = snapshot.boards.filter(board => owned.teams.includes(board.id)).map(board => JSON.stringify({ ...board, updatedAt: 0 })).sort()
  const waiting = (snapshot.waiting ?? []).filter(item => item.team === null || owned.teams.includes(item.team)).map(item => item.id).sort()
  const reviews = snapshot.reviews.filter(review => owned.runs.includes(review.run)).map(review => `${review.run}:${review.rounds.length}`).sort()
  const teams = snapshot.teams.filter(team => owned.teams.includes(team.goal.id)).map(team => ({ id: team.goal.id, stage: teamWakeStage(team.stage) })).sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify({ runs, boards, waiting, reviews, teams, chats: [...chats].map(({ id, stage }) => ({ id, stage })).sort((a, b) => a.id.localeCompare(b.id)), actions: actions.map(action => action.id).sort() })
}

/** One reading per owned run. A run that has not moved for `stuckMs` while running is stuck, whatever it last said. */
export const classifyLeadRuns = (snapshot: ClientSnapshot | null, owned: Owned, actions: readonly LeadAction[], lastMoved: ReadonlyMap<string, number>, now: number, stuckMs = LEAD_STUCK_MS): readonly LeadRunReading[] => {
  if (!snapshot) return []
  return snapshot.runs.filter(run => owned.runs.includes(run.id)).map((run): LeadRunReading => {
    if (run.state === 'settled') return { runId: run.id, kind: 'done' }
    if (run.state === 'stopped' || run.state === 'stalled' || run.operations.some(operation => operation.state === 'uncertain') ||
      actions.some(action => action.runId === run.id) || (snapshot.waiting ?? []).some(item => item.kind !== 'card' && item.team !== null && owned.teams.includes(item.team)))
      return { runId: run.id, kind: 'blocked' }
    const moved = lastMoved.get(run.id) ?? run.startedAt ?? now
    if (now - moved >= stuckMs) return { runId: run.id, kind: 'stuck', quietMinutes: Math.floor((now - moved) / 60_000) }
    // A run whose rounds have all closed without starting any external work said what it would do and did none of it.
    if (run.rounds.length && run.rounds.every(round => round.state === 'closed') && !run.operations.some(operation => operation.kind === 'turn' || operation.kind === 'check'))
      return { runId: run.id, kind: 'plan-only' }
    return { runId: run.id, kind: 'advanced' }
  })
}

/**
 * The gate itself. It remembers the fingerprint the model last saw and when each
 * run last moved; `look` answers whether this change deserves a model turn and
 * keeps the counts the person sees as "Checked 3 times · nothing new".
 */
export const createLeadWakeGate = (stuckMs = LEAD_STUCK_MS) => {
  let seen: string | null = null, counts: LeadWakeCounts = { checked: 0, quiet: 0, lastCheckedAt: null }
  const moved = new Map<string, number>(), lastRun = new Map<string, string>()
  const stuckSaid = new Set<string>(), handledStops = new Set<string>()
  return {
    get counts(): LeadWakeCounts { return counts },
    get lastMoved(): ReadonlyMap<string, number> { return moved },
    /** Record what the model has now been shown; the counts start again from here. */
    shown(fingerprint: string) { seen = fingerprint; counts = { checked: 0, quiet: 0, lastCheckedAt: counts.lastCheckedAt } },
    /** Background chat activity updates its fingerprint without consuming other desk facts. */
    quietChat(id: string, stage: LeadStage, forgotten?: string) {
      if (!seen || seen === 'unsynchronized') return
      const previous = JSON.parse(seen) as { chats: LeadObservedStage[] }
      previous.chats = [...previous.chats.filter(chat => chat.id !== id && chat.id !== forgotten), { id, stage }].sort((a, b) => a.id.localeCompare(b.id))
      seen = JSON.stringify(previous)
    },
    /** Consume only a quiet Team stage transition, leaving other desk evidence observable. */
    quietTeam(id: string, stage: LeadStage) {
      if (!seen || seen === 'unsynchronized') return
      const previous = JSON.parse(seen) as { teams: { id: string; stage: TeamWakeStage }[] }
      previous.teams = [...previous.teams.filter(team => team.id !== id), { id, stage: teamWakeStage(stage) }].sort((a, b) => a.id.localeCompare(b.id))
      seen = JSON.stringify(previous)
    },
    /** Consume one host-journaled intervention without waking for that stop.
     * Only this fingerprint is consumed: another round or changed evidence wakes. */
    handledStop(key: string, runId: string, snapshot: ClientSnapshot | null, owned: Owned, actions: readonly LeadAction[]) {
      if (handledStops.has(key) || !snapshot) return
      handledStops.add(key)
      const current = JSON.parse(leadDeskFingerprint(snapshot, owned, actions)) as { runs: { id: string }[]; boards: string[]; waiting: string[]; reviews: string[]; actions: string[]; teams: { id: string; stage: TeamWakeStage }[]; chats: LeadObservedStage[] }
      const previous = seen && seen !== 'unsynchronized' ? JSON.parse(seen) as typeof current : { runs: [], boards: [], waiting: [], reviews: [], teams: [], chats: [], actions: [] }
      const run = snapshot.runs.find(run => run.id === runId), reading = current.runs.find(run => run.id === runId)
      if (!run || !reading) return
      // Consume only the handled run and the worker cards that said this stop.
      // Person actions, another run and unrelated board edits stay observable.
      previous.runs = [...previous.runs.filter(run => run.id !== runId), reading].sort((a, b) => a.id.localeCompare(b.id))
      // The handled stop's own attention transition is consumed with its run.
      // Another Team, a chat or a concurrent person action remains observable.
      const team = current.teams.find(team => team.id === run.goal)
      if (team) previous.teams = [...previous.teams.filter(old => old.id !== team.id), team].sort((a, b) => a.id.localeCompare(b.id))
      const board = snapshot.boards.find(board => board.id === run.goal)
      if (board) {
        const currentBoard = { ...board, updatedAt: 0 }, index = previous.boards.findIndex(value => (JSON.parse(value) as { id: string }).id === board.id)
        const prior = index < 0 ? { ...currentBoard, intents: [], channel: [] } : JSON.parse(previous.boards[index]!) as typeof currentBoard
        const reopened = run.rounds.find(round => round.cause === `cause:lead:${key}`)
        const stoppedRound = reopened ? run.rounds.find(round => round.n === reopened.n - 1) : run.rounds.at(-1)
        const cards = new Set(stoppedRound?.cards ?? [])
        const stopSignals = (entry: typeof board.channel[number]) => entry.kind === 'signal' && cards.has(entry.intent) && ['completed', 'blocked', 'released'].includes(entry.signal)
        const channel = [...prior.channel.filter(entry => !stopSignals(entry)), ...currentBoard.channel.filter(stopSignals)].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
        const patched = JSON.stringify({ ...prior, channel, intents: [...prior.intents.filter(card => !cards.has(card.id)), ...currentBoard.intents.filter(card => cards.has(card.id))].sort((a, b) => a.id - b.id) })
        if (index < 0) previous.boards.push(patched); else previous.boards[index] = patched
        previous.boards.sort()
      }
      seen = JSON.stringify(previous)
    },
    look(snapshot: ClientSnapshot | null, owned: Owned, actions: readonly LeadAction[], now: number, chats: readonly LeadObservedStage[] = []): { readonly wake: boolean; readonly fingerprint: string; readonly why: 'changed' | 'stuck' | null } {
      for (const run of snapshot?.runs ?? []) {
        if (!owned.runs.includes(run.id)) continue
        const key = JSON.stringify([run.state, run.rounds.map(round => round.state), run.operations.map(operation => operation.state)])
        if (lastRun.get(run.id) !== key) { lastRun.set(run.id, key); moved.set(run.id, now); stuckSaid.delete(run.id) }
      }
      const fingerprint = leadDeskFingerprint(snapshot, owned, actions, chats)
      const stuck = classifyLeadRuns(snapshot, owned, actions, moved, now, stuckMs).filter(reading => reading.kind === 'stuck' && !stuckSaid.has(reading.runId))
      const why = fingerprint !== seen ? 'changed' as const : stuck.length ? 'stuck' as const : null
      for (const reading of stuck) stuckSaid.add(reading.runId)
      counts = { checked: counts.checked + 1, quiet: counts.quiet + (why ? 0 : 1), lastCheckedAt: now }
      return { wake: why !== null, fingerprint, why }
    },
  }
}
export type LeadWakeGate = ReturnType<typeof createLeadWakeGate>
