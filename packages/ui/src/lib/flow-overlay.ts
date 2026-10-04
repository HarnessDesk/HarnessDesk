import type { FlowExecution, Intent, Session, SessionKey } from '@harnessdesk/protocol'
import type { FlowModel } from './flow-model'
import { currentRunEnd, runCardTiming, type RunTimelineRow } from './run-timeline'
import { FLOW_LABEL_H, FLOW_MARGIN, type FlowBox, type FlowLayout, type FlowLabel } from './flow-layout'

export type FlowStepState = 'future' | 'done' | 'working' | 'waiting' | 'blocked' | 'stopping' | 'stopped'
export interface FlowStepRun {
  readonly state: FlowStepState
  /** Null when earlier check results are unavailable or damaged. */
  readonly runs: number | null
  readonly durationMs: number | null
  readonly since: number | null
  readonly line: string | null
  readonly seats: readonly string[]
}
export interface FlowRuleRun { readonly count: number; readonly current: boolean }
export interface FlowOverlay {
  readonly steps: ReadonlyMap<string, FlowStepRun>
  readonly rules: ReadonlyMap<string, FlowRuleRun>
}
/** The part of flow/check/attempts the drawing reads. Only recorded results can be counted. */
export interface OverlayCheckHistory {
  readonly attempts: readonly { readonly id: string; readonly at: number }[]
  readonly complete: boolean
}
export interface FlowOverlayInput {
  readonly execution: Pick<FlowExecution, 'rounds' | 'operations' | 'state' | 'currentEndedAt'>
  readonly sessions?: ReadonlyMap<SessionKey, Session>
  readonly model: FlowModel
  readonly cards: readonly Intent[]
  readonly attempts?: ReadonlyMap<number, OverlayCheckHistory>
}

/** The Run's recorded journey, never a prediction from the current answers. */
export const flowOverlay = ({ execution, model, cards, attempts, sessions }: FlowOverlayInput): FlowOverlay => {
  const rounds = [...execution.rounds].sort((a, b) => a.n - b.n)
  const byCard = new Map(cards.map(card => [card.id, card]))
  const checkOperations = execution.operations.filter(one => one.kind === 'check')
  const steps = new Map<string, FlowStepRun>()
  for (const step of model.steps) {
    const visits = rounds.filter(round => round.role === step.id)
    const latest = visits.at(-1)
    const retry = step.kind === 'check' ? [...visits].reverse().find(round => checkOperations.some(one => (one.state === 'started' || one.state === 'uncertain') && one.card !== null && round.cards.includes(one.card))) : undefined
    const current = retry ?? latest
    const held = current?.cards.map(id => byCard.get(id)) ?? []
    const answered = held.length > 0 && held.every(card => card?.state === 'done' || card?.state === 'abandoned')
    const ended = execution.state === 'settled' || execution.state === 'stopped'
    const timingOf = (card: Intent) => runCardTiming(execution, card, step.kind === 'check'
      ? checkOperations.some(one => one.card === card.id && one.state === 'started') : card.state === 'claimed', card.claim?.at ?? card.createdAt, sessions)
    const timing = held.flatMap(card => card ? [timingOf(card)] : [])
    const stopped = timing.some(one => one.stoppedWork)
    const stopping = timing.some(one => one.status === 'Stopping')
    // Stop closes rounds without finishing their cards. A person can also
    // answer before the host advances or finishes waiting for evidence.
    const unfinished = current !== undefined && (stopped || timing.some(one => one.working) || retry !== undefined || (ended ? !answered : current.state !== 'closed' && !answered))
    const personWaiting = step.kind === 'person' && held.some(card => card && (card.state === 'open' || card.state === 'claimed'
      || (card.blockedBy === 'hand' && Boolean(card.blockedReason?.trim()))))
    const state: FlowStepState = !latest ? 'future' : stopped ? stopping ? 'stopping' : 'stopped' : ended ? unfinished ? 'stopped' : 'done'
      : current?.state === 'waiting-evidence' ? 'blocked' : !unfinished ? 'done'
      : step.kind === 'person' ? personWaiting ? 'waiting' : 'blocked'
      : execution.state === 'stalled' ? 'blocked' : 'working'
    const durations = visits.filter(round => round !== retry && (round.state === 'closed' || round === current && (answered || stopped || ended && unfinished))).map(round => {
      const held = round.cards.map(id => byCard.get(id))
      const ends = held.flatMap(card => card ? [timingOf(card).until] : [])
      // An open, unfinished step has no claim; its recorded Run ending still bounds its lifetime.
      const until = ends.length && ends.every(one => one !== null) ? Math.max(...ends as number[])
        : round === current && unfinished ? currentRunEnd(execution) : null
      return held.length && held.every(Boolean) && until !== null
        ? Math.max(0, until - Math.min(...held.map(card => timingOf(card!).since!))) : null
    })
    const liveCards = unfinished ? current!.cards.map(id => byCard.get(id)) : []
    // A closed card's creation time is not the start of its later retry. The
    // overwritten operation keeps no retry timestamp, so that time is unknown.
    const since = ended || stopped || retry?.state === 'closed' ? null : liveCards.length && liveCards.every(Boolean) ? Math.min(...liveCards.map(card => card!.createdAt)) : null
    const answers = latest?.cards.flatMap(id => { const answer = byCard.get(id)?.outcome; return answer ? [answer] : [] }) ?? []
    let runs: number | null = visits.length
    if (step.kind === 'check' && visits.length) {
      runs = 0
      for (const round of visits) {
        for (const id of round.cards) {
          const history = attempts?.get(id)
          if (!history?.complete) { runs = null; break }
          runs += history.attempts.length
        }
        if (runs === null) break
      }
      if (!visits.every(round => round.cards.length > 0)) runs = null
    }
    steps.set(step.id, {
      state, runs, since,
      durationMs: visits.length === 0 || durations.some(one => one === null) || (unfinished && since === null && (retry !== undefined || !(ended || stopped)))
        ? null : durations.reduce<number>((sum, one) => sum + (one ?? 0), 0),
      line: state === 'waiting' ? step.line : answered && answers.length ? [...new Set(answers)].join(' · ') : null,
      seats: current?.seats ?? [],
    })
  }
  const rules = new Map<string, FlowRuleRun>(model.rules.map(rule => [rule.id, { count: 0, current: false }]))
  for (const round of rounds) {
    const previous = rounds.find(one => one.n === round.n - 1)
    if (!previous) continue
    // Compare the complete host key. Role and rule ids can themselves contain colons.
    const rule = model.rules.find(rule => rule.on === previous.role && rule.to === round.role && round.cause === `after:${previous.n}:${rule.id}`)
    if (!rule) continue // Seed, intake or an externally opened round has no recorded rule.
    const prior = rules.get(rule.id)!
    const state = steps.get(round.role)?.state
    rules.set(rule.id, { count: prior.count + 1, current: round === rounds.at(-1) && (state === 'working' || state === 'waiting') })
  }
  return { steps, rules }
}

export const stepForRow = (execution: Pick<FlowExecution, 'rounds'>, rows: readonly RunTimelineRow[], id: string | null): string | null => {
  const row = rows.find(row => row.id === id)
  return execution.rounds.find(round => round.n === row?.round)?.role ?? null
}
export const rowsForStep = (execution: Pick<FlowExecution, 'rounds'>, rows: readonly RunTimelineRow[], step: string | null): readonly string[] => {
  const rounds = new Set(execution.rounds.filter(round => round.role === step).map(round => round.n))
  return rows.filter(row => row.round !== null && rounds.has(row.round)).map(row => row.id)
}

/** Reserve the doing band for the whole working round, so a brief gap between tools never moves its labels. */
export const flowOverlayLabels = (layout: FlowLayout, overlay: FlowOverlay): ReadonlyMap<string, FlowLabel> => {
  const bands = layout.nodes.flatMap(node => {
    const run = overlay.steps.get(node.id)
    if (run?.state !== 'working' || !run.seats.length) return []
    const centre = node.box.x + node.box.w / 2
    const width = Math.min(320, 2 * centre, 2 * (layout.width - centre))
    return [{ x: centre - width / 2, y: node.box.y + node.box.h + FLOW_LABEL_H, w: width, h: FLOW_LABEL_H }]
  })
  const labels = new Map<string, FlowLabel>()
  if (!bands.length) return new Map(layout.edges.flatMap(edge => edge.label ? [[edge.id, edge.label] as const] : []))
  const occupied: FlowBox[] = [...layout.nodes.map(node => node.box), ...bands]
  const gap = FLOW_MARGIN / 8
  for (const edge of layout.edges) {
    if (!edge.label) continue
    let label = { ...edge.label }
    const count = edge.rules.reduce((sum, id) => sum + (overlay.rules.get(id)?.count ?? 0), 0)
    if (label.retry && count) label.w += label.h / 2 * (String(count).length + 2)
    const box = (): FlowBox => ({ x: label.x - label.w / 2, y: label.y - label.h / 2, w: label.w, h: label.h })
    const overlaps = (a: FlowBox, b: FlowBox) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
    while (occupied.some(one => overlaps(box(), one))) label = { ...label, y: label.y + FLOW_LABEL_H + gap }
    occupied.push(box())
    labels.set(edge.id, label)
  }
  return labels
}
