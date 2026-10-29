import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setImmediate as immediate } from 'node:timers/promises'
import { DEFAULT_LANE_PREFERENCES, parseClientMessage, ValidationError } from '@harnessdesk/protocol'
import { Host } from '../src/host.js'
import { Logger } from '../src/log.js'
import { StateStore } from '../src/state.js'
import { tempDir } from './scratch.js'

const rig = async (t: TestContext) => {
  const state = new StateStore(join(tempDir('hd-lane-preferences-'), 'state.json')); await state.load()
  const host = new Host({ state, logger: new Logger('lane-test', { level: 'error', console: false }) })
  t.after(() => host.dispose())
  return { state, host }
}

test('both preference verbs route through the real Host context', async (t) => {
  const { host } = await rig(t)
  assert.deepEqual(await host.call('lane/preferences', {}), DEFAULT_LANE_PREFERENCES)
  const asked = { start: 31000, width: 30, browserProfile: false }
  assert.deepEqual(await host.call('lane/preferences/set', asked), asked)
  assert.deepEqual(await host.call('lane/preferences', {}), asked)
})

test('generic app preference writes cannot bypass lane validation', async (t) => {
  const { state, host } = await rig(t)
  await assert.rejects(host.call('app/state/set', { patch: { lanes: { start: 0 } } }), /starting port/)
  assert.equal(Object.hasOwn(state.state.preferences, 'lanes'), false)
  state.state.preferences['lanes'] = null
  await assert.rejects(host.call('lane/preferences', {}), /starting port/)
  await host.call('lane/preferences/set', DEFAULT_LANE_PREFERENCES)
  assert.deepEqual(await host.call('lane/preferences', {}), DEFAULT_LANE_PREFERENCES)
})

test('the preference fixture finishes its pending snapshot before scratch cleanup', { timeout: 30_000 }, async (t) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const renaming = new Promise<void>(resolve => { reached = resolve })
  let directory: string | undefined
  let snapshot: { from: string; to: string } | undefined
  const rename = fsPromises.rename
  t.mock.method(fsPromises, 'rename', (async (...args: Parameters<typeof rename>) => {
    const destination = String(args[1])
    if (dirname(destination) === directory && /^sessions-\d{4}-\d{2}-\d{2}\.sqlite$/.test(basename(destination))) {
      snapshot = { from: String(args[0]), to: destination }
      reached()
      await held
    }
    return rename(...args)
  }) as typeof rename)
  syncBuiltinESMExports()
  const { state, host } = await rig(t)
  directory = state.directory
  const dispose = host.dispose.bind(host)
  let closing: Promise<void> | undefined
  t.mock.method(host, 'dispose', () => {
    closing ??= dispose()
    release()
    return closing
  })
  // The fixture's cleanup was registered first. This check therefore runs at
  // the same boundary as scratch.ts, after the Host has finished disposing.
  t.after(async () => {
    try {
      assert.ok(snapshot, 'the actual snapshot worker reached its publish step')
      assert.equal(existsSync(snapshot.to), true, 'the pending snapshot finished before scratch cleanup')
      assert.equal(existsSync(snapshot.from), false, 'no staged snapshot remains')
      rmSync(state.directory, { recursive: true, force: true })
      await immediate()
      assert.equal(existsSync(state.directory), false, 'no writer recreates the removed directory')
    } finally {
      release()
      await (closing ?? dispose())
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })
  // Give the Host constructor's scheduled daily snapshot a real event-loop
  // turn, then leave its real worker's completed file waiting to be renamed.
  await immediate()
  await renaming
  assert.ok(snapshot)
  assert.equal(existsSync(snapshot.from), true)
  assert.equal(existsSync(snapshot.to), false)
})

test('lane wire validation rejects unknown keys and malformed numbers before dispatch', () => {
  const request = (method: string, params: unknown) => parseClientMessage({ id: 1, method, params })
  for (const params of [null, {}, { ...DEFAULT_LANE_PREFERENCES, width: 0 }, { ...DEFAULT_LANE_PREFERENCES, profileDir: '/work/other' }]) assert.throws(() => request('lane/preferences/set', params), ValidationError)
  assert.throws(() => request('lane/preferences', { root: '/work/repo' }), ValidationError)
  assert.throws(() => request('lane/release', { lane: 'a', force: true }), ValidationError)
  assert.doesNotThrow(() => request('lane/preferences/set', DEFAULT_LANE_PREFERENCES))
})
