import {
  CEILING_LEVELS,
  ceilingOfPermission,
  type AgentDefinition,
  type CeilingLevel,
  type FlowPermission,
  type FlowRun,
  type RuntimeInfo,
  type SeatCeiling,
  type SessionSettings,
} from '@harnessdesk/protocol'

import { ceilingMeaning, ceilingWords } from './agents'

/**
 * The tone a seat's ceiling chip is drawn in — neutral, always, and a
 * constant rather than a function of the ceiling because nothing about a
 * ceiling ever changes it.
 *
 * `hold` alone answered this once: `asked` drew the warning tone, `held` the
 * neutral one. But most runtimes have no control that holds a ceiling at
 * all, so nearly every built-in Agent's roster row and every plain seat's
 * chip read `asked` and drew amber — amber as the ordinary state, which is
 * amber meaning nothing, on every screen the chip appears on. There is no
 * second field to ask instead: `held`/`asked` is a fact about the runtime's
 * own machinery, not a verdict on how risky this particular seat is, and the
 * chip's own words ("Held", "Asked, not held…") plus its hover explanation
 * already say which is which, in the sentence rather than the colour. See
 * `docs/decisions.md` for the reversal this recorded.
 */
export const ceilingTone = (): 'neutral' => 'neutral'

/** What a seat's ceiling means and how it holds, for the chip's hover. */
export const ceilingTitle = (ceiling: SeatCeiling, note?: string | null): string =>
  ceiling.hold === 'held'
    ? `${ceilingMeaning(ceiling.level)} Held${note ? `: ${note}` : ' by its runtime'}.`
    : `${ceilingMeaning(ceiling.level)} Asked, not held${
        note ? `: ${note}` : ': its runtime has no control that holds it, so the seat is only told'
      }. The desk's own tools still refuse anything above it.`

/** A flow role's legacy permission, preserving its original meaning on the ceiling ladder. */
export const flowSeatCeiling = (permission: FlowPermission): SeatCeiling => ({
  level: ceilingOfPermission(permission),
  hold: 'asked',
})

/** A seat's ceiling, and the words for how it holds when the host has them. */
export interface SeatCeilingShown {
  readonly ceiling: SeatCeiling
  readonly note: string | null
}

/** The ceiling a conversation runs under, or null for the plain conversation path. */
export const seatCeilingOf = (
  settings: SessionSettings | null | undefined,
  runs: readonly FlowRun[],
  runtime: string,
  sessionId: string,
): SeatCeilingShown | null => {
  if (settings?.ceiling) return { ceiling: settings.ceiling, note: settings.ceilingNote ?? null }
  for (const run of runs) {
    if (run.state !== 'running' && run.state !== 'stalled') continue
    const seat = run.seats.find((one) => one.runtime === runtime && one.sessionId === sessionId)
    if (seat) return { ceiling: flowSeatCeiling(seat.permission), note: null }
  }
  return null
}

/** One runtime's hold on one ceiling. */
export interface RuntimeHold {
  readonly level: CeilingLevel
  readonly held: boolean
  readonly how: string | null
}

export const runtimeHolds = (runtime: RuntimeInfo): readonly RuntimeHold[] =>
  CEILING_LEVELS.map((level) => {
    const control = runtime.ceilings?.[level]
    return { level, held: control !== undefined, how: control?.how ?? null }
  })

/** Why an Agent's row needs the migration action, or null for the current key. */
export const flagWords = (definition: AgentDefinition): string | null =>
  definition.ceilingFrom === 'permission'
    ? `Written with permission:, so it reads as ${ceilingWords(definition.ceiling).toLowerCase()}.`
    : definition.ceilingFrom === 'none'
      ? 'No ceiling written, so it runs as read.'
      : null

/** One line the migration action can write, and what choosing it means. */
export interface UpdateChoice {
  readonly level: CeilingLevel
  readonly label: string
  readonly hint: string
}

export const updateChoices = (definition: AgentDefinition): readonly UpdateChoice[] => {
  if (definition.ceilingFrom === 'none') {
    return [
      { level: 'read', label: 'Keep Read', hint: 'What it runs as now: it changes nothing.' },
      { level: 'edit', label: 'Allow Edit', hint: 'What it could do before ceilings: change files and commit, never push.' },
    ]
  }
  const kept = definition.ceiling
  return [
    { level: kept, label: `Keep ${ceilingWords(kept)}`, hint: `What it could do before: ${ceilingMeaning(kept).toLowerCase()}` },
    ...(kept === 'read'
      ? []
      : [{ level: 'read' as const, label: 'Narrow to Read', hint: 'It changes nothing: it reads, searches and reports.' }]),
  ]
}
