import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClientMessage, ValidationError } from '../src/index.js'

/*
 * The trigger controls are a person's, and only at the wire boundary can that
 * be held: every frame below goes through `parseClientMessage` — the exact
 * parser the host's socket runs — never a handler shortcut. A request may name
 * a project, a trigger, a one-use token, a cursor, a Goal and the machine's
 * two preferences; it may never carry an origin, a grant, a fact, a command or
 * any other authority the host is responsible for.
 */

const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
const ROOT = '/work/project'
const TOKEN = '6f1b2c3d-0000-4000-8000-000000000001'
const GOAL = 'goal-6f1b2c3d-0000-4000-8000-000000000001'

test('person controls reject forged origin and unknown authority', () => {
  const valid: Record<string, Record<string, unknown>> = {
    'trigger/list': { root: ROOT },
    'trigger/preview': { root: ROOT, id: 'review' },
    'trigger/arm': { root: ROOT, id: 'review', token: TOKEN },
    'trigger/disarm': { root: ROOT, id: 'review' },
    'trigger/preferences': {},
    'trigger/preferences/set': { revision: 3, paused: false, dailyUsd: 20 },
    'trigger/history': { root: ROOT, id: 'review' },
    'trigger/goal': { goal: GOAL },
  }
  for (const [method, params] of Object.entries(valid)) {
    assert.doesNotThrow(() => request(method, params), `${method} accepts its own shape`)
    // No authority rides along on any of them.
    for (const field of ['origin', 'grant', 'fact', 'command', 'binding', 'arm', 'signature', 'ceiling', 'budget']) {
      assert.throws(() => request(method, { ...params, [field]: 'x' }), ValidationError, `${method} refuses a forged ${field}`)
    }
  }
  assert.doesNotThrow(() => request('trigger/history', { root: ROOT, id: 'review', cursor: 'c'.repeat(200) }))

  // Roots: absolute, bounded, printable.
  for (const root of ['', 'work/project', './project', '../project', `/${'a'.repeat(4096)}`, '/work/\u0000x', '/work/\nproject']) {
    assert.throws(() => request('trigger/list', { root }), ValidationError, `root ${JSON.stringify(root.slice(0, 20))} is refused`)
  }
  // Ids: a trigger's slug, never over 64 characters.
  for (const id of ['', 'Review', 'a'.repeat(65), 'review now', '../x', 'x\u0000']) {
    assert.throws(() => request('trigger/preview', { root: ROOT, id }), ValidationError, `id ${JSON.stringify(id.slice(0, 20))} is refused`)
  }
  assert.throws(() => request('trigger/goal', { goal: 'g'.repeat(65) }), ValidationError)
  assert.throws(() => request('trigger/goal', { goal: '' }), ValidationError)
  // Tokens and cursors: at most 200 printable characters.
  assert.throws(() => request('trigger/arm', { root: ROOT, id: 'review', token: 't'.repeat(201) }), ValidationError)
  assert.throws(() => request('trigger/arm', { root: ROOT, id: 'review', token: '' }), ValidationError)
  assert.throws(() => request('trigger/arm', { root: ROOT, id: 'review', token: 'a\nb' }), ValidationError)
  assert.throws(() => request('trigger/arm', { root: ROOT, id: 'review' }), ValidationError, 'arming needs its preview token')
  assert.throws(() => request('trigger/history', { root: ROOT, id: 'review', cursor: 'c'.repeat(201) }), ValidationError)
  // Preferences: a safe revision, a boolean, and a finite, bounded cap.
  const prefs = { revision: 3, paused: false, dailyUsd: 20 }
  assert.doesNotThrow(() => request('trigger/preferences/set', { ...prefs, dailyUsd: 0 }))
  for (const bad of [
    { ...prefs, revision: -1 }, { ...prefs, revision: 1.5 }, { ...prefs, revision: Number.MAX_SAFE_INTEGER + 2 },
    { ...prefs, paused: 'yes' }, { ...prefs, dailyUsd: -1 }, { ...prefs, dailyUsd: Number.POSITIVE_INFINITY },
    { ...prefs, dailyUsd: Number.NaN }, { ...prefs, dailyUsd: 10_001 }, { ...prefs, dailyUsd: '20' },
    { revision: 3, paused: false }, { paused: false, dailyUsd: 20 },
  ]) {
    assert.throws(() => request('trigger/preferences/set', bad), ValidationError, `preferences ${JSON.stringify(bad)} are refused`)
  }
})

test('generic state cannot carry machine consent or trigger preferences', () => {
  // `app/state/set` is how windows remember their own preferences; it can never reach intake's machine state.
  for (const key of ['triggers', 'triggerArms', 'triggerPreferences', 'triggersPaused', 'intake']) {
    assert.throws(() => request('app/state/set', { patch: { [key]: { paused: true } } }), ValidationError, `${key} is not a window preference`)
  }
  assert.doesNotThrow(() => request('app/state/set', { patch: { systemNotifications: { enabled: true } } }), 'a window preference still saves')
})
