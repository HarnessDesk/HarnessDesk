import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_LANE_PREFERENCES, parseClientMessage, ValidationError } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { Logger } from '../src/log.js'
import { StateStore } from '../src/state.js'
import { tempDir } from './scratch.js'

const rig = async () => {
  const state = new StateStore(join(tempDir('hd-lane-preferences-'), 'state.json')); await state.load()
  const host = new Host({ state, logger: new Logger('lane-test', { level: 'error', console: false }) })
  return { state, host }
}

test('both preference verbs route through the real Host context', async () => {
  const { host } = await rig()
  assert.deepEqual(await host.call('lane/preferences', {}), DEFAULT_LANE_PREFERENCES)
  const asked = { start: 31000, width: 30, browserProfile: false }
  assert.deepEqual(await host.call('lane/preferences/set', asked), asked)
  assert.deepEqual(await host.call('lane/preferences', {}), asked)
})

test('generic app preference writes cannot bypass lane validation', async () => {
  const { state, host } = await rig()
  await assert.rejects(host.call('app/state/set', { patch: { lanes: { start: 0 } } }), /starting port/)
  assert.equal(Object.hasOwn(state.state.preferences, 'lanes'), false)
  state.state.preferences['lanes'] = null
  await assert.rejects(host.call('lane/preferences', {}), /starting port/)
  await host.call('lane/preferences/set', DEFAULT_LANE_PREFERENCES)
  assert.deepEqual(await host.call('lane/preferences', {}), DEFAULT_LANE_PREFERENCES)
})

test('lane wire validation rejects unknown keys and malformed numbers before dispatch', () => {
  const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
  for (const params of [null, {}, { ...DEFAULT_LANE_PREFERENCES, width: 0 }, { ...DEFAULT_LANE_PREFERENCES, profileDir: '/work/other' }]) assert.throws(() => request('lane/preferences/set', params), ValidationError)
  assert.throws(() => request('lane/preferences', { root: '/work/repo' }), ValidationError)
  assert.throws(() => request('lane/release', { lane: 'a', force: true }), ValidationError)
  assert.doesNotThrow(() => request('lane/preferences/set', DEFAULT_LANE_PREFERENCES))
})
