import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

import { cannotRun, dmgArch, SMOKE, smokeArtifacts } from './smoke-artifacts.mjs'
import { withIosReleaseMount } from './ios-release-mount.mjs'

const DMGS = ['HarnessDesk-1.2.3-arm64.dmg', 'HarnessDesk-1.2.3-arm64.zip', 'HarnessDesk-1.2.3-x64.dmg', 'SHA256SUMS.txt']

/** The real mount helper, with hdiutil and the folder removal scripted. */
const scripted = (calls, { detach = () => {} } = {}) => {
  let made = 0
  return {
    list: () => DMGS,
    makeMount: () => `/release/.smoke-${++made}`,
    mount: (dmg, at, inspect) => {
      calls.push(['mount', dmg])
      return withIosReleaseMount(dmg, at, inspect, {
        run: (bin, args) => { calls.push([args[0], args.at(-1)]); if (args[0] === 'detach') detach() },
        remove: () => {},
        warn: () => {},
      })
    },
    log: () => {},
  }
}

test('each DMG is mounted, smoked at the bundle inside it, and detached', () => {
  const calls = [], smoked = []
  const result = smokeArtifacts('/release', { ...scripted(calls), canRun: () => null, smoke: (app) => { smoked.push(app); return 0 } })
  assert.deepEqual(result.passed, ['HarnessDesk-1.2.3-arm64.dmg', 'HarnessDesk-1.2.3-x64.dmg'])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(smoked, ['/release/.smoke-1/HarnessDesk.app', '/release/.smoke-2/HarnessDesk.app'])
  assert.deepEqual(calls.filter((call) => call[0] === 'detach').length, 2)
})

test('a smoke that fails fails that DMG, and the next DMG still runs', () => {
  const calls = []
  const result = smokeArtifacts('/release', { ...scripted(calls), canRun: () => null, smoke: (app) => (app.includes('.smoke-1') ? 1 : 0) })
  assert.deepEqual(result.failed, [{ dmg: 'HarnessDesk-1.2.3-arm64.dmg', reason: 'the packaged smoke exited 1' }])
  assert.deepEqual(result.passed, ['HarnessDesk-1.2.3-x64.dmg'])
})

test('a volume that will not detach fails its DMG rather than passing', () => {
  const calls = []
  const result = smokeArtifacts('/release', { ...scripted(calls, { detach: () => { throw new Error('busy') } }), canRun: () => null, smoke: () => 0 })
  assert.equal(result.passed.length, 0)
  assert.match(result.failed[0].reason, /Could not detach/)
})

test('an architecture this Mac cannot run is skipped with its reason, never mounted', () => {
  const calls = []
  const result = smokeArtifacts('/release', { ...scripted(calls), canRun: (arch) => (arch === 'x64' ? 'no Rosetta' : null), smoke: () => 0 })
  assert.deepEqual(result.skipped, [{ dmg: 'HarnessDesk-1.2.3-x64.dmg', reason: 'no Rosetta' }])
  assert.deepEqual(calls.filter((call) => call[0] === 'mount').map((call) => call[1]), ['/release/HarnessDesk-1.2.3-arm64.dmg'])
})

test('which architectures can run where', () => {
  assert.equal(cannotRun('arm64', { hostArch: 'arm64', rosetta: () => false }), null)
  assert.equal(cannotRun('x64', { hostArch: 'arm64', rosetta: () => true }), null)
  assert.match(cannotRun('x64', { hostArch: 'arm64', rosetta: () => false }), /Rosetta is not installed/)
  assert.match(cannotRun('arm64', { hostArch: 'x64', rosetta: () => true }), /cannot run on an x64 Mac/)
  assert.equal(dmgArch('HarnessDesk-1.2.3-x64.dmg'), 'x64')
  assert.equal(dmgArch('HarnessDesk.dmg'), null)
})

test('the gate runs the packaged smoke, and the smoke refuses an app without its interface', () => {
  assert.ok(existsSync(SMOKE))
  assert.match(readFileSync(SMOKE, 'utf8'), /verifyAppInterface\(appPath\)/)
})
