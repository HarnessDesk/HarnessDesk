import type { TriggerFact } from '@harnessdesk/protocol'

import type { ArmedTrigger } from './consent.js'
import type { PollBatch, SourceCursor } from './forge.js'
import { eventKey, scheduleSlot, skippedSlots } from './keys.js'

/**
 * Schedules: `every: <minutes>` slots, aligned to the UTC epoch, read from
 * the wall clock with no timezone, cron language or daylight rule.
 *
 * A project's schedule triggers share one source and one cursor, which keeps
 * each trigger's last fired slot. A slot is due when it is after both the
 * trigger's arm and its last fired slot, so arming between slots fires
 * nothing early, a desk that was off fires the newest elapsed slot once and
 * counts the rest as skipped, and a clock that ran backwards fires nothing
 * until it passes the last slot again. Each slot is its own fact — and, by
 * the default `goal: [slot]`, its own Goal.
 */

/** A schedule source's first cursor: nothing fired yet. Each arm's own baseline guards its first slot. */
export const scheduleInventory = (now: number): SourceCursor => ({
  version: 1, source: 'schedule', repository: null, baseline: now, observedThrough: now, continuation: null, subjects: {},
})

/** The slots due now for one project's schedule arms, and the cursor that records them fired. */
export function dueSlots(project: string, arms: readonly ArmedTrigger[], cursor: SourceCursor, now: number): PollBatch {
  const subjects: Record<string, { head: string | null; event: string }> = { ...cursor.subjects }
  const facts: TriggerFact[] = []
  const skipped: PollBatch['skipped'][number][] = []
  for (const arm of [...arms].sort((a, b) => a.id.localeCompare(b.id))) {
    if (arm.definition.on.kind !== 'schedule') continue
    const every = arm.definition.on.everyMinutes
    const fired = Number(subjects[arm.id]?.event ?? 0)
    const since = Math.max(arm.baseline, Number.isSafeInteger(fired) ? fired : 0)
    const slot = scheduleSlot(now, since, every)
    if (slot === null) continue
    const missed = skippedSlots(slot, since, every)
    facts.push({
      source: 'schedule', project, repository: null, subject: String(slot), event: eventKey(['tick', arm.id, slot]),
      action: 'tick', at: slot, head: null, fork: false, title: '', body: '', url: null, trigger: arm.id,
    })
    if (missed > 0) {
      skipped.push({
        trigger: arm.id, subject: String(slot), count: missed,
        reason: `${missed} earlier ${missed === 1 ? 'slot was' : 'slots were'} missed while the desk was not watching, and only the latest one runs.`,
      })
    }
    subjects[arm.id] = { head: null, event: String(slot) }
  }
  return {
    facts, skipped, complete: true, problem: null,
    next: { ...cursor, observedThrough: Math.max(cursor.observedThrough, now), subjects },
  }
}
