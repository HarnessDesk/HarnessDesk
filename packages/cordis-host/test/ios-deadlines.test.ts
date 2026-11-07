import test from 'node:test'
import assert from 'node:assert/strict'
import { IosEngine } from '../src/ios-engine.js'
import { withIosInputSignal } from '../src/ios-invocation.js'

const udid = '11111111-1111-1111-1111-111111111111'

test('an aborted simulator mutation cannot start after its queued predecessor', async () => {
  const controller = new AbortController()
  let installs = 0, release = () => {}, entered = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  const engine = new IosEngine({ run: async (_binary, args) => {
    if (args[1] === 'list') return { stdout: JSON.stringify({ devices: { fixture: [{ udid, state: 'Booted', name: 'Synthetic device' }] } }), stderr: '' }
    installs++
    if (installs === 1) await new Promise<void>(resolve => { release = resolve; entered() })
    return { stdout: '', stderr: '' }
  } })
  try {
    const first = engine.install('/synthetic/Fixture.app', udid)
    await started
    const second = withIosInputSignal(controller.signal, () => engine.install('/synthetic/Queued.app', udid))
    const rejected = assert.rejects(second, /cancelled/)
    await new Promise(setImmediate)
    controller.abort(new Error('cancelled'))
    release()
    await first
    await rejected
    assert.equal(installs, 1)
  } finally { release(); engine.dispose() }
})

test('diagnostic cancellation stops before the next sequential probe', async () => {
  const controller = new AbortController()
  let calls = 0, signal: AbortSignal | undefined
  const engine = new IosEngine({ environment: {
    platform: 'darwin', developerDirectory: undefined, exists: () => true,
    execute: async (_binary, _args, options) => {
      calls++
      signal = (options as { signal?: AbortSignal }).signal
      controller.abort(new Error('cancelled'))
      return { exitCode: 0, stdout: '/Applications/Xcode.app/Contents/Developer', stderr: '' }
    },
  } })
  try {
    await assert.rejects(withIosInputSignal(controller.signal, () => engine.diagnose()), /cancelled/)
    assert.equal(calls, 1)
    assert.equal(signal, controller.signal)
  } finally { engine.dispose() }
})
