import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { EvidenceRecord } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { projectOf } from '../src/evidence/revision.js'
import { evidenceDesk } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

const FLOW = `version: 2
name: Read retained findings
roles:
  person: { kind: person, outcomes: [done] }
seed: { role: person, title: Read the findings }
rules: []
`

test('a Team keeps its findings and publication history after its checkout is gone (#1572)', async t => {
  const d = await evidenceDesk(t)
  const cwd = join(tempDir('hd-findings-checkout-'), 'checkout')
  await d.repo.git('worktree', 'add', '-q', '-b', 'team', cwd)
  const goal = await d.host.call('goal/create', { root: d.repo.dir, cwd, sentence: 'Read the findings' })
  const binding = { id: goal.goal.id, revision: goal.goal.revision }
  const preview = await d.host.call('authoring/start/preview', {
    context: { kind: 'project', root: goal.goal.root }, source: FLOW, vars: {}, goal: binding,
  })
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  const run = await d.host.call('flow/start-goal', {
    root: goal.goal.root, source: FLOW, sentence: 'Read the findings', token: preview.flow.token, goal: binding,
  })
  const card = run.rounds[0]!.cards[0]!
  const at = await d.repo.git('rev-parse', 'HEAD')
  const record: EvidenceRecord = {
    id: 'raise-retained', fact: { kind: 'finding', id: 'finding-retained', state: 'open', at },
    card: { board: run.goal, id: card }, checkout: { cwd, branch: 'team' },
    seat: 'seat-reviewer', round: 1, observedAt: 1, posted: null,
    finding: {
      version: 1, sequence: 1, operation: 'raise-retained',
      origin: { goal: run.goal, run: run.id, round: 1, card, seat: 'seat-reviewer', at },
      event: { kind: 'raise', title: 'Retain the result', body: 'Details.', category: 'ordinary', blocking: true, related: null, anchor: null },
    },
  }
  const review: EvidenceRecord = {
    ...record, id: 'review-retained', finding: null,
    fact: { kind: 'review', verdict: 'request-changes', by: 'seat-reviewer', at },
  }
  const store = new EvidenceStore(join(d.stateDir, 'evidence'))
  await store.append(await projectOf(cwd), 'evidence', [record, review].map(record => ({ type: 'evidence', record })))
  const before = await d.host.call('finding/list', { goal: run.goal })
  assert.equal(before.rows.length, 1, 'the live checkout reads the project ledger')
  const earlier = await d.host.call('finding/run', { goal: run.goal, run: run.id })
  assert.equal(earlier.open, 1)
  assert.equal(earlier.rounds.length, 1, 'the review is visible to the publication reader')

  // Wrapping retains the Team document while removing its isolated checkout.
  await rm(cwd, { recursive: true })
  const after = await d.host.call('finding/list', { goal: run.goal })
  assert.deepEqual(after.rows, before.rows, 'removing a checkout must not select an empty ledger')
  const later = await d.host.call('finding/run', { goal: run.goal, run: run.id })
  assert.equal(later.open, 1)
  assert.deepEqual(later.rounds, earlier.rounds, 'publication reads use the same retained project')
  const evidence = await d.host.call('evidence/board', { room: run.goal })
  assert.ok(evidence.cards.flatMap(card => card.facts).some(fact => fact.record.id === review.id), 'the board retains its historical evidence too')
})
