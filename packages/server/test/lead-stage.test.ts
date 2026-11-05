import assert from 'node:assert/strict'
import test from 'node:test'
import { initialLeadState } from '@harnessdesk/lead'
import type { LeadCard } from '@harnessdesk/protocol'
import { leadThreadStage } from '../src/lead/projection.js'
import { teamLeadStage } from '../src/work-stage.js'

test('thread stages read only active card kinds, live actions, state and accepted queue facts', () => {
  const state = initialLeadState(), thread = { cards: [] as LeadCard[] }
  assert.deepEqual(leadThreadStage(state, thread, [], null, false), { stage: 'idle', reason: 'idle' })
  assert.equal(leadThreadStage(state, thread, [], null, false, true).stage, 'queued')
  assert.equal(leadThreadStage(state, thread, [], null, true, true).stage, 'working')
  assert.equal(leadThreadStage(state, thread, [], 'lead-request-failed', true).stage, 'you-blocked')
  thread.cards = [{ type: 'plan' } as LeadCard]
  assert.deepEqual(leadThreadStage(state, thread, [], null, true), { stage: 'you-answer', reason: 'card-plan' })
  thread.cards = [{ type: 'result', outcome: 'reviewed' } as LeadCard]
  assert.equal(leadThreadStage(state, thread, [], null, true).stage, 'you-review')
  thread.cards = [{ type: 'result', outcome: 'accepted' } as LeadCard]
  assert.equal(leadThreadStage(state, thread, [], null, false).stage, 'idle')
  thread.cards = [{ type: 'waiting', kind: 'worker-approval' } as LeadCard]
  assert.equal(leadThreadStage(state, thread, [], null, false).reason, 'worker-approval')
})

test('a reserved Team is queued only before its execution exists', () => {
  const view = { goal: { state: 'open' }, activity: 'working', reservation: { run: 'reserved' } } as Parameters<typeof teamLeadStage>[0]
  assert.equal(teamLeadStage(view, null).stage, 'queued')
  assert.equal(teamLeadStage(view, { state: 'running' }).stage, 'working')
  assert.equal(teamLeadStage({ ...view, activity: 'needs-you' }, null).stage, 'you-answer')
})
