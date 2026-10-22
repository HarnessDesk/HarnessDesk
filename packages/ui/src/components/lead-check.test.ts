import { expect, it } from 'vitest'
import type { BoardEvidence } from '@harnessdesk/protocol'
import { leadCheckAsk } from './lead-check'

const fact = (card: number, fact: object) => ({ card, running: [], facts: [{ record: { id: `${card}-${JSON.stringify(fact).length}`, fact }, freshness: { state: 'fresh' }, by: null }] } as unknown as BoardEvidence['cards'][number])
const board = (cards: BoardEvidence['cards'], checks = ['verify']): BoardEvidence =>
  ({ room: 'room', stamp: 1, checks, refused: [], unreadable: null, cards }) as unknown as BoardEvidence
const intents = [{ id: 1, role: 'implement', state: 'done' as const }, { id: 2, role: 'review', state: 'done' as const }]
const approve = fact(2, { kind: 'review', verdict: 'approve', by: 'seat', at: 'abc' })

it('asks for the project check once a review approved the revision and nothing ran there', () => {
  expect(leadCheckAsk(intents, board([approve]))).toEqual({ card: 1, name: 'verify' })
})
it('asks for nothing before an approval, after the check ran at that revision, or when no check can run', () => {
  expect(leadCheckAsk(intents, undefined)).toBeNull()
  expect(leadCheckAsk(intents, board([]))).toBeNull()
  expect(leadCheckAsk(intents, board([fact(2, { kind: 'review', verdict: 'request-changes', by: 'seat', at: 'abc' })]))).toBeNull()
  expect(leadCheckAsk(intents, board([approve, fact(1, { kind: 'check', name: 'verify', run: 'x', exit: 0, timedOut: false, at: 'abc' })]))).toBeNull()
  expect(leadCheckAsk(intents, board([approve], []))).toBeNull()
  expect(leadCheckAsk([{ id: 2, role: 'review', state: 'done' }], board([approve]))).toBeNull()
})
it('asks again when the check ran at an older revision, and takes the first declared check when verify is not one', () => {
  expect(leadCheckAsk(intents, board([approve, fact(1, { kind: 'check', name: 'verify', run: 'x', exit: 0, timedOut: false, at: 'old' })]))).toEqual({ card: 1, name: 'verify' })
  expect(leadCheckAsk(intents, board([approve], ['lint', 'test']))).toEqual({ card: 1, name: 'lint' })
})
