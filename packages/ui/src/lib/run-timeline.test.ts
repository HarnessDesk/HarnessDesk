import { expect, it } from 'vitest'
import { runPullRequest } from './run-timeline'
import { shapeFixture } from '../preview/run-shapes-fixture'
import type { EvidenceView } from '@harnessdesk/protocol'
it('keeps a previous Run’s pull request off an Investigation Run', () => {
  const { execution, evidence } = shapeFixture('investigation')
  const fact: EvidenceView = { by: null, freshness: { state: 'fresh' }, record: { id: 'pr-old', round: 1, card: { board: execution.goal, id: 99 }, observedAt: 1,
    fact: { kind: 'pr', number: 7, url: 'https://github.com/acme/demo/pull/7', state: 'open', head: 'a'.repeat(40) } } }
  const all = { ...evidence!, cards: [...evidence!.cards, { card: 99, running: [], facts: [fact] }] }
  expect(runPullRequest(execution, all)).toBeNull()
  expect(runPullRequest(null, all)).toEqual({ number: 7, url: 'https://github.com/acme/demo/pull/7' })
  expect(runPullRequest({ ...execution, rounds: [{ ...execution.rounds[0]!, cards: [99] }] }, all)?.number).toBe(7)
  expect(runPullRequest(null, { ...all, cards: [{ card: 99, running: [], facts: [{ ...fact, record: { ...fact.record, restored: { from: 'backup', at: 1 } as never } }] }] })).toBeNull()
})
