import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { EvidenceRecord, FindingDetail, FindingEvent, FindingRecord } from '../src/index.js'

/*
 * A finding is an evidence record with one optional field more. The record
 * shape phase 4 wrote stays assignable exactly as it was, the `finding` fact
 * arm is unchanged, and the metadata's arms refuse what they do not say.
 */

const A = 'a'.repeat(40)

test('record extension is optional and fact arm unchanged', () => {
  // A phase-4 record, written before findings existed, is still an EvidenceRecord.
  const phase4: EvidenceRecord = {
    id: 'fact-1', fact: { kind: 'finding', id: 'finding-1', state: 'open', at: A },
    card: { board: 'goal-1', id: 2 }, checkout: null, seat: null, round: null, observedAt: 1, posted: null,
  }
  const detail: FindingDetail = {
    version: 1, sequence: 1, operation: 'op-1',
    origin: { goal: 'goal-1', run: 'run-1', round: 1, card: 2, seat: 'seat-1', at: A },
    event: { kind: 'raise', title: 'T', body: 'B', category: 'ordinary', blocking: true, related: null, anchor: null },
  }
  // A new record is a FindingRecord, and a FindingRecord is an ordinary EvidenceRecord.
  const next: FindingRecord = { ...phase4, fact: { kind: 'finding', id: 'finding-1', state: 'open', at: A }, finding: detail }
  const back: EvidenceRecord = next
  // The fact arm is the one phase 4 declared: no field was added to it.
  const arm: Extract<EvidenceRecord['fact'], { kind: 'finding' }> = { kind: 'finding', id: 'finding-1', state: 'repaired', at: A }
  // @ts-expect-error a finding record needs the metadata; a bare fact is history, not a FindingRecord
  const bare: FindingRecord = phase4
  // @ts-expect-error a finding record's fact is the finding arm, never a check
  const wrongFact: FindingRecord = { ...next, fact: { kind: 'diff', files: 1, added: 1, removed: 0, from: A, to: A } }
  // @ts-expect-error the fact arm grew no extra field
  const grown: Extract<EvidenceRecord['fact'], { kind: 'finding' }> = { kind: 'finding', id: 'x', state: 'open', at: A, title: 'no' }
  // @ts-expect-error a repair event carries a note, never a lifecycle state
  const repairWithState: FindingEvent = { kind: 'repair', note: 'fixed', state: 'repaired' }
  // @ts-expect-error a verdict is by a Seat or a person, never an Agent name
  const byAgent: FindingEvent = { kind: 'verdict', state: 'open', note: '', by: 'reviewer' }
  // @ts-expect-error only version 1 is written
  const future: FindingDetail = { ...detail, version: 2 }
  void [bare, wrongFact, grown, repairWithState, byAgent, future, arm]
  assert.deepEqual(JSON.parse(JSON.stringify(back)).finding.event.kind, 'raise')
  assert.equal('finding' in phase4, false, 'a phase-4 record has no metadata at all')
})
