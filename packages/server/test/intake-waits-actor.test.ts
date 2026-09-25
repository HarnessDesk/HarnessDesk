import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RuntimeId, TeamActor } from '@harnessdesk/protocol'

import { actorWords } from '../src/intake/waits.js'

/*
 * Who a held message reads as being from, in `HostWaits.messages[].from` and
 * the "A message from … is held for you" sentence built on it — pulled out
 * of the host's own private `#triggerWaits` so this is testable without the
 * whole intake apparatus (a review of #905 asked for it). Only one branch is
 * a real product path today (a card a trigger's own run adds, through
 * `Team.addIntentForFlow`'s `by`) — nothing yet composes a *message* this
 * way — but the function does not know that, and should not have to.
 */

const conversationName = (runtime: string, sessionId: string): string => `${runtime}:${sessionId} (untitled)`

test('nobody named reads as "someone"', () => {
  assert.equal(actorWords(null, conversationName), 'someone')
  assert.equal(actorWords(undefined, conversationName), 'someone')
})

test('the person at the keyboard reads as "you"', () => {
  assert.equal(actorWords({ kind: 'user' }, conversationName), 'you')
})

test('a trigger reads as "the trigger <name>", never as a person or an agent', () => {
  const trigger: TeamActor = { kind: 'trigger', trigger: 'triage-issue' }
  assert.equal(actorWords(trigger, conversationName), 'the trigger triage-issue')
})

test('an agent with a title of its own reads as that title', () => {
  const agent: TeamActor = { kind: 'agent', runtime: 'codex' as RuntimeId, sessionId: 's1', title: 'API migration' }
  assert.equal(actorWords(agent, conversationName), 'API migration')
})

test('an untitled agent falls back to its conversation\'s own name', () => {
  const agent: TeamActor = { kind: 'agent', runtime: 'codex' as RuntimeId, sessionId: 's1', title: '' }
  assert.equal(actorWords(agent, conversationName), 'codex:s1 (untitled)')
})
