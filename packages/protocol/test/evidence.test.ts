import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SeatRecord } from '../src/index.js'

/*
 * The seam with phase 3, as a type: every Seat record carries the ceiling it
 * ran under and whether it was held, null until phase 3 fills it. Records are
 * immutable and append-only, so the slot exists from the first record on —
 * a field added later would leave every earlier record without it.
 */
test('a Seat record has a ceiling slot in exactly the seam shape, null until phase 3 fills it', () => {
  const none: SeatRecord['ceiling'] = null
  const held: SeatRecord['ceiling'] = { level: 'edit', hold: 'held' }
  // The seam as phase 3's plan spells it. Assigned both ways, so neither side can grow a field alone.
  const seam: { readonly level: 'read' | 'edit' | 'publish' | 'merge'; readonly hold: 'held' | 'asked' } | null = held
  const back: SeatRecord['ceiling'] = seam
  // @ts-expect-error a level that is not on the ladder
  const offLadder: SeatRecord['ceiling'] = { level: 'owner', hold: 'held' }
  // @ts-expect-error a hold that is neither held nor asked
  const unheld: SeatRecord['ceiling'] = { level: 'read', hold: 'enforced' }
  // @ts-expect-error the slot is required: a record without it does not type
  const missing: Pick<SeatRecord, 'ceiling'> = {}
  void [offLadder, unheld, missing]
  assert.deepEqual(JSON.parse(JSON.stringify({ none, back })), { none: null, back: { level: 'edit', hold: 'held' } })
})

/*
 * The other half of the seam: what the Agent's standing order said, in the
 * words of its own generation. Phases 1 and 2 write `permission:`; phase 3's
 * Agents may say only `ceiling:`. A record keeps whichever it was, tagged, so
 * phase 3 writes its Agents' records without inventing a `permission:` for
 * them and without changing this type — and a reader always knows which it
 * holds.
 */
test("a Seat record's standing order is either generation's or an explicit unknown import", () => {
  const today: SeatRecord['standing'] = { kind: 'permission', permission: 'read' }
  const phase3: SeatRecord['standing'] = { kind: 'ceiling', level: 'edit' }
  const imported: SeatRecord['standing'] = { kind: 'unknown' }
  // @ts-expect-error a ceiling-only Agent's order is never written as a permission it did not say
  const invented: SeatRecord['standing'] = { kind: 'permission', level: 'edit' }
  // @ts-expect-error nor a permission as a ceiling
  const mixed: SeatRecord['standing'] = { kind: 'ceiling', permission: 'read' }
  // @ts-expect-error a level off the ceiling's ladder
  const offLadder: SeatRecord['standing'] = { kind: 'ceiling', level: 'owner' }
  // @ts-expect-error the order is required on every record
  const missing: Pick<SeatRecord, 'standing'> = {}
  void [invented, mixed, offLadder, missing]
  const words = (standing: SeatRecord['standing']): string => {
    if (standing.kind === 'unknown') return 'not recorded'
    return standing.kind === 'permission' ? `permission: ${standing.permission}` : `ceiling: ${standing.level}`
  }
  assert.deepEqual([words(today), words(phase3), words(imported)], ['permission: read', 'ceiling: edit', 'not recorded'])
})
