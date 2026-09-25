import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createIntakeNotifier, INTAKE_NOTIFICATION_KINDS } from './intake-notifications.mjs'

/**
 * A named wait on unattended work reaches the person outside the app even
 * with no window open, is tried once however often it is replayed, and is
 * never claimed delivered when the person's switches or the OS said no.
 */

const attention = (over = {}) => ({
  method: 'trigger/attention',
  params: {
    attention: {
      id: 'att-0123456789abcdef0123456789abcdef', goal: 'goal-1', trigger: 'review', kind: 'budget',
      waitingOn: { kind: 'person', label: 'You' }, sentence: 'This Goal stopped: Timed out: this Goal reached its time budget.',
      action: 'open-goal', createdAt: 1, resolvedAt: null, notification: 'pending', ...over,
    },
  },
})

const rig = (over = {}) => {
  const shown = []
  const reported = []
  const notify = createIntakeNotifier({
    prefs: async () => over.prefs ?? {},
    supported: () => over.supported ?? true,
    show: async (note) => {
      if (over.refuse) throw new Error('notifications are not allowed')
      shown.push(note)
    },
    report: async (id, status) => { reported.push([id, status]) },
  })
  return { notify, shown, reported }
}

test('closed window and OS refusal retain attention', async () => {
  // No window at all: the host's own event is delivered, once.
  const open = rig()
  assert.equal(await open.notify(attention()), 'delivered')
  assert.equal(open.shown.length, 1)
  assert.deepEqual(open.shown[0], { title: 'Unattended work stopped', body: 'This Goal stopped: Timed out: this Goal reached its time budget.', goal: 'goal-1' })
  assert.deepEqual(open.reported, [['att-0123456789abcdef0123456789abcdef', 'delivered']])
  // A reconnect replays the same wait by its id: no second attempt, no second alert.
  assert.equal(await open.notify(attention()), null)
  assert.equal(await open.notify(attention({ notification: 'delivered' })), null)
  assert.equal(open.shown.length, 1)
  assert.equal(open.reported.length, 1)

  // The OS will not show notifications: one attempt, recorded unavailable, never claimed delivered.
  const refused = rig({ supported: false })
  assert.equal(await refused.notify(attention()), 'unavailable')
  assert.deepEqual(refused.shown, [])
  assert.deepEqual(refused.reported, [['att-0123456789abcdef0123456789abcdef', 'unavailable']])
  assert.equal(await refused.notify(attention()), null, 'unavailable is durable: a replay does not try again')

  // The OS refuses at the moment of showing: the same.
  const denied = rig({ refuse: true })
  assert.equal(await denied.notify(attention()), 'unavailable')
  // The person's master switch, or this kind's own, is off: unavailable, and nothing shown.
  for (const prefs of [{ enabled: false }, { triggerAttention: false }]) {
    const off = rig({ prefs })
    assert.equal(await off.notify(attention()), 'unavailable')
    assert.deepEqual(off.shown, [])
  }
})

test('a resolved wait is not news, and a skipped firing is said once under its own switch', async () => {
  const r = rig()
  assert.equal(await r.notify(attention({ resolvedAt: 5 })), null)
  assert.equal(await r.notify(attention({ id: 'att-ffffffffffffffffffffffffffffffff', kind: 'skipped', resolvedAt: 5, sentence: 'Trigger review skipped a pull request: forks are not allowed.' })), 'delivered')
  assert.equal(r.shown.at(-1).title, 'A trigger skipped a firing')
  const quiet = rig({ prefs: { triggerSkipped: false } })
  assert.equal(await quiet.notify(attention({ kind: 'skipped', resolvedAt: 5 })), 'unavailable')
  assert.equal(await quiet.notify(attention({ id: 'att-11111111111111111111111111111111' })), 'delivered', 'the other kind keeps its own switch')
  assert.equal(await r.notify({ method: 'goal/activity', params: {} }), null, 'nothing else is this module’s')
})

test('the two intake kinds are pinned', () => {
  assert.deepEqual(INTAKE_NOTIFICATION_KINDS.map((entry) => entry.kind), ['triggerAttention', 'triggerSkipped'])
})
