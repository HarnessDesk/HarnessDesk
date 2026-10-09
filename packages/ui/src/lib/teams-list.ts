/** Plain held facts in, project groups and window-only read/Hide marks out. */
import type { FlowExecution, GoalView, TeamState } from '@harnessdesk/protocol'
import { stepName } from './flow-model'
import { runReasonWords } from './run-reason'
import { goalName } from './goals'
import type { SeatRow, teamOverview } from './team-overview'

export interface TeamListInput {
 readonly team: TeamState
 readonly goal: GoalView | null
 readonly execution: FlowExecution | null
 readonly overview: ReturnType<typeof teamOverview>
 readonly total?: { readonly money: number | null; readonly turns: number | null }
}
export interface TeamsPrefs {
 readonly hidden: Readonly<Record<string, string>>
 readonly seen: Readonly<Record<string, string>>
}
export type TeamFilter = 'active' | 'needs-you' | 'settled'
export type TeamListState = SeatRow['state'] | 'settled' | 'wrapped' | 'wrapping' | 'stopped'
export interface TeamListRow {
 readonly id: string
 readonly project: string
 readonly sentence: string
 readonly seats: readonly SeatRow[]
 readonly state: TeamListState
 readonly since: number | null
 readonly detail: string | null
 readonly total: { readonly money: number | null; readonly turns: number | null }
 readonly active: boolean
 readonly ready: boolean
 readonly change: string
 readonly unread: boolean
 readonly hidden: boolean
}
export interface TeamListGroup { readonly project: string; readonly rows: readonly TeamListRow[] }

const strings = (raw: unknown): Record<string,string> => Object.fromEntries(
 typeof raw === 'object' && raw !== null && !Array.isArray(raw)
  ? Object.entries(raw).filter((entry): entry is [string,string] => typeof entry[1] === 'string') : [])
export const readTeamsPrefs = (value: unknown): TeamsPrefs => {
 const raw = typeof value === 'object' && value !== null ? value as Record<string,unknown> : {}
 return {hidden:strings(raw.hidden),seen:strings(raw.seen)}
}
const emptyPrefs: TeamsPrefs = {hidden:{},seen:{}}
const firstTime = (values: readonly (number | null | undefined)[]): number | null => {
 const known = values.filter((one): one is number => typeof one === 'number' && one > 0 && Number.isFinite(one))
 return known.length ? Math.min(...known) : null
}

export const teamListRow = ({team,goal,execution,overview,total}: TeamListInput, prefs: TeamsPrefs = emptyPrefs): TeamListRow => {
 const seats = overview.seats
 const wrapped = goal?.goal.state === 'wrapped'
 const waiting = overview.needsYou[0]
 const blocked = seats.find(one => one.state === 'needs-you')
 const needs = !wrapped && (Boolean(waiting || blocked || overview.run?.needsYou) || goal?.activity === 'needs-you' || execution?.state === 'stalled' || execution?.end?.kind === 'unrouted' || Boolean(execution?.keptAnswer))
 const unreadSeats = seats.filter(one => one.state === 'unread')
 const workingSeats = seats.filter(one => one.state === 'working')
 const unfinished = team.intents.some(card => card.state !== 'done' && card.state !== 'abandoned')
 const settled = !needs && workingSeats.length === 0 && !unfinished && !goal?.waitingOn?.length &&
  execution?.state !== 'running' && execution?.state !== 'stalled' &&
  (goal ? goal.activity === 'ready-to-wrap' : execution?.state === 'settled')
 const state: TeamListState = wrapped ? 'wrapped' : needs ? 'needs-you' : unreadSeats.length ? 'unread'
  : goal?.goal.state === 'wrapping' ? 'wrapping' : workingSeats.length ? 'working' : execution?.state === 'stopped' ? 'stopped'
   : settled ? 'settled' : 'idle'
 const ready = settled && !wrapped && state === 'settled'
 const active = !wrapped && !ready
 // The Run has start/end stamps, but no per-round transition timestamps.
 // Use attention/claim observations when present; do not invent a round age.
 const since = state === 'needs-you' ? firstTime([...overview.needsYou.map(one => one.since), ...seats.filter(one => one.state === 'needs-you').map(one => one.since)]) ??
   (execution?.state === 'stalled' || execution?.end?.kind === 'unrouted' ? execution.endedAt ?? null : null)
  : state === 'unread' ? firstTime(unreadSeats.map(one => one.since))
   : state === 'working' ? firstTime(workingSeats.map(one => one.since))
    : state === 'settled' || state === 'stopped' ? execution?.endedAt ?? null
     : wrapped ? goal?.goal.updatedAt ?? null : null
 const round = overview.run
 const after = goal?.waitingOn?.length ? `After ${goal.waitingOn.map(one => one.sentence).join(' · ')}` : null
 const rawDetail = wrapped ? null : waiting?.summary ?? blocked?.reason ?? (overview.run?.needsYou ? overview.run.findingRun?.reason : null) ?? execution?.pendingReleaseNote ?? after ?? (execution?.reason ? runReasonWords(execution.reason, execution.document.flow.rules) : null) ?? (!settled && round?.round !== null && round?.round !== undefined
  ? `Round ${round.round}${round.role ? ` · ${stepName(round.role)}` : ''} · ${workingSeats.length} of ${seats.length} seats working` : null)
 const detail = rawDetail
 // Usage refreshes and clock ticks do not unhide work. Identity, lifecycle and
 // observed attention do; these marks contain no transcript or command text.
 const change = JSON.stringify([team.updatedAt,goal?.goal.updatedAt ?? null,goal?.goal.state ?? null,goal?.activity ?? null,
  execution?.id ?? null,execution?.state ?? null,execution?.endedAt ?? null,execution?.reason ?? null,execution?.pendingReleaseNote ?? null,
  execution?.rounds.map(one => [one.n,one.state,one.cards,one.seats]) ?? [],
  [overview.run?.findingRun?.publication ?? null,overview.run?.publicationOn ?? null,overview.run?.findingRun?.reason ?? null],
  seats.map(one => [one.seat,one.state,one.since,one.card?.id ?? null]),
  overview.needsYou.map(one => [one.kind,one.seat,one.card,one.since])])
 return {id:team.id,project:team.root,sentence:goal ? goalName(goal.goal) : team.name,seats,state,since,detail,
  total:total ?? round?.total ?? {money:null,turns:null},active,ready,change,
  unread:prefs.seen[team.id] !== change,hidden:ready && prefs.hidden[team.id] === change}
}
const precedence: Record<TeamListState,number> = {'needs-you':0,unread:1,working:2,wrapping:2,idle:3,stopped:3,settled:4,wrapped:5}
const grouped = (rows: readonly TeamListRow[]): TeamListGroup[] => {
 const groups = new Map<string,TeamListRow[]>()
 for (const row of rows) groups.set(row.project,[...(groups.get(row.project) ?? []),row])
 return [...groups].sort(([a],[b]) => a.localeCompare(b)).map(([project,rows]) => ({project,rows:rows.sort((a,b) => precedence[a.state]-precedence[b.state] || (a.since ?? Infinity)-(b.since ?? Infinity) || a.id.localeCompare(b.id))}))
}
export const teamsList = (input: readonly TeamListInput[], prefs: TeamsPrefs = emptyPrefs) => {
 const rows = input.map(one => teamListRow(one,prefs))
 const active = rows.filter(one => one.active)
 const needs = rows.filter(one => one.state === 'needs-you')
 const settled = rows.filter(one => one.ready || one.state === 'wrapped')
 return {active:grouped(active), 'needs-you':grouped(needs),settled:grouped(settled),ready:grouped(rows.filter(one => one.ready && !one.hidden)),
  counts:{active:active.length,'needs-you':needs.length,settled:settled.length}}
}
