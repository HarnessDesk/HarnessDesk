import { ceilingOfPermission, narrower, type Flow, type FlowEvidenceGuard, type FlowPolicy, type SeatCeiling } from '@harnessdesk/protocol'

import { ceilingWords, seatCeilingWords } from './agents'
import { readGraphPositions, type GraphPoint } from './shapes'

/**
 * A Flow, read for drawing: the words on a step's card, the word above a
 * rule's edge, and the sentence the list under the drawing says for each.
 *
 * Geometry is `flow-layout`'s. This only reads the document, so the drawing,
 * the list beneath it and the narrow view that is only the list all say the
 * same thing, and read it once. Either generation of a Flow can be drawn: a
 * Run holds the document it started with, and older Runs hold the older one.
 */
export type DrawnFlow = FlowPolicy | Flow

export type StepKind = 'agent' | 'check' | 'person'

export interface FlowStep {
  readonly id: string
  readonly kind: StepKind
  /** The id as a word: `test_review` is "Test review". */
  readonly name: string
  /** The one earned line: what an Agent may do, the command a check runs, the words a person may answer. */
  readonly line: string
  /** How many seats the step opens at once; more than one is drawn as a fanned stack. */
  readonly count: number
  /** The Agents the step names, for the list; a check or a person names none. */
  readonly agents: readonly string[]
}

export interface FlowRuleView {
  readonly id: string
  readonly on: string
  readonly to: string
  /** The outcome that takes the rule, or what the desk saw if none does; null when nothing guards it. */
  readonly word: string | null
  /** The whole guard, as a sentence. */
  readonly when: string
}

export interface FlowModel {
  readonly name: string
  readonly steps: readonly FlowStep[]
  readonly rules: readonly FlowRuleView[]
  /** The step the Flow starts at. */
  readonly seed: string
  /** `layout.positions` of the current format, read defensively; empty when the file carries none. */
  readonly positions: Readonly<Record<string, GraphPoint>>
  /** Whether something in `layout.positions` was dropped for being unreadable. */
  readonly invalidPositions: boolean
}

export interface FlowModelOptions {
  /**
   * What the seats of each Agent step ran under in the Run that holds this
   * Flow, by step id, as the Seat record says it: the level they ran at and
   * whether the runtime held it. A step it names nothing for says only its
   * grant.
   */
  readonly ceilings?: ReadonlyMap<string, SeatCeiling>
}

export const stepName = (id: string): string => {
  const words = id.replace(/[_\-\s]+/g, ' ').trim()
  return words === '' ? '' : `${words[0]!.toUpperCase()}${words.slice(1)}`
}

/** A round as wide as the list that sets it, else as many as it counts: the host's own reading. */
const widthOf = (listed: number, count: number | undefined): number => (listed > 1 ? listed : Math.max(1, count ?? 1))

const stepOf = (role: DrawnFlow['roles'][number], options: FlowModelOptions): FlowStep => {
  const name = stepName(role.id)
  if (role.kind === 'check') return { id: role.id, kind: 'check', name, line: role.check?.run.trim() || 'No command yet', count: 1, agents: [] }
  if (role.kind === 'person') return { id: role.id, kind: 'person', name, line: role.outcomes.join(' · ') || 'No answers yet', count: 1, agents: [] }
  const ran = options.ceilings?.get(role.id)
  // The current format spells a ceiling and names Agents; the older one spells
  // a permission (whose `read` always allowed edits) and lists seats.
  const [grant, listed, count, agents] = 'grant' in role
    ? [role.grant, Math.max(role.uses.length, role.seats.length), role.count, role.uses] as const
    : [ceilingOfPermission(role.permission), role.seats.length, role.count, []] as const
  return {
    id: role.id,
    kind: 'agent',
    name,
    // A seat runs at the narrower of its Agent's ceiling and the grant, so once
    // a Run has seated the step the line is the seat's own record, in the words
    // the Seat record uses; the grant is never followed by a hold it did not earn.
    line: ran ? seatCeilingWords(ran) : ceilingWords(grant),
    count: widthOf(listed, count),
    agents,
  }
}

interface Guard {
  readonly every?: readonly string[]
  readonly any?: readonly string[]
  readonly evidence?: readonly FlowEvidenceGuard[]
}

const unique = (words: readonly string[]): string[] => [...new Set(words)]

const evidenceWord = (guard: FlowEvidenceGuard): string => {
  if ('check' in guard) return `${guard.check} passed`
  if ('ci' in guard) return 'CI green'
  if ('review' in guard) return `review ${guard.review}`
  if ('pr' in guard) return `pull request ${guard.pr}`
  return 'has a diff'
}

const evidenceClause = (guard: FlowEvidenceGuard): string => {
  if ('check' in guard) return `${guard.check} has passed`
  if ('ci' in guard) return 'CI is green'
  if ('review' in guard) return `the review says ${guard.review}`
  if ('pr' in guard) return `the pull request is ${guard.pr}`
  return 'there is a diff'
}

const naturalList = (parts: readonly string[]): string =>
  parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`

const wordOf = (when: Guard): string | null => {
  const outcomes = unique([...(when.every ?? []), ...(when.any ?? [])])
  if (outcomes.length > 0) return outcomes.join(' / ')
  const seen = (when.evidence ?? []).map(evidenceWord)
  return seen.length > 0 ? seen.join(' + ') : null
}

const sentenceOf = (when: Guard): string => {
  const parts = [
    ...(when.every?.length ? [`every answer says ${when.every.join(' or ')}`] : []),
    ...(when.any?.length ? [`any answer says ${when.any.join(' or ')}`] : []),
    ...(when.evidence ?? []).map(evidenceClause),
  ]
  return parts.length === 0 ? 'Whatever the outcome' : `When ${naturalList(parts)}`
}

/**
 * What each Agent step's seats ran under in a Run, from the seats its rounds
 * opened.
 *
 * Where a step's seats differ it says the floor of them: the narrowest level,
 * and *asked* if any was only asked of its agent, because the weaker answer is
 * the one a person must not miss. A step with a seat that has no recorded
 * ceiling (one this window does not know, or one from before ceilings were
 * recorded) is left out, and so is a step that opened none: the card says its
 * grant and nothing more, rather than speak for a seat it cannot see.
 */
export const ceilingsOfRun = (
  rounds: readonly { readonly role: string; readonly seats: readonly string[] }[],
  seats: readonly { readonly id: string; readonly ceiling: SeatCeiling | null }[],
): ReadonlyMap<string, SeatCeiling> => {
  const recorded = new Map(seats.map((seat) => [seat.id, seat.ceiling] as const))
  const floors = new Map<string, SeatCeiling>()
  const unsaid = new Set<string>()
  for (const round of rounds) {
    for (const id of round.seats) {
      const ceiling = recorded.get(id)
      if (!ceiling) {
        unsaid.add(round.role)
        continue
      }
      const floor = floors.get(round.role)
      floors.set(round.role, floor === undefined ? ceiling : {
        level: narrower(floor.level, ceiling.level),
        hold: floor.hold === 'asked' || ceiling.hold === 'asked' ? 'asked' : 'held',
      })
    }
  }
  for (const role of unsaid) floors.delete(role)
  return floors
}

export const flowModel = (flow: DrawnFlow, options: FlowModelOptions = {}): FlowModel => {
  // Only the current format's `layout.positions` is a canvas's: an older file kept other things under `layout`.
  const hand = 'version' in flow ? readGraphPositions(flow) : { positions: {}, invalid: false }
  return {
    name: flow.name,
    steps: flow.roles.map((role) => stepOf(role, options)),
    rules: flow.rules.map((rule) => {
      const when: Guard = rule.when ?? {}
      return { id: rule.id, on: rule.on, to: rule.then.role, word: wordOf(when), when: sentenceOf(when) }
    }),
    seed: flow.seed.role,
    positions: hand.positions,
    invalidPositions: hand.invalid,
  }
}
