import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cannotRun, dmgArch, runsTranslated, SMOKE, smokeArtifacts, smokeVerdict, startSmoke } from './smoke-artifacts.mjs'
import { withIosReleaseMountAsync } from './ios-release-mount.mjs'

const DMGS = ['HarnessDesk-1.2.3-arm64.dmg', 'HarnessDesk-1.2.3-arm64.zip', 'HarnessDesk-1.2.3-x64.dmg', 'SHA256SUMS.txt']

/** The real mount helper, with hdiutil and the folder removal scripted. */
const scripted = (calls, { detach = () => {} } = {}) => {
  let made = 0
  return {
    list: () => DMGS,
    makeMount: () => `/release/.smoke-${++made}`,
    mount: (dmg, at, inspect) => {
      calls.push(['mount', dmg])
      return withIosReleaseMountAsync(dmg, at, inspect, {
        run: (bin, args) => { calls.push([args[0], args.at(-1)]); if (args[0] === 'detach') detach() },
        remove: () => {},
        warn: () => {},
        retryMs: 0,
      })
    },
    signals: new EventEmitter(),
    log: () => {},
    stopRunning: async (prefix) => { calls.push(['stop-running', prefix]) },
  }
}
/** A smoke that finishes at once with `status`. */
const finished = (status) => ({ done: Promise.resolve(status), stop: async () => {} })

test('each DMG is mounted, smoked at the bundle inside it, and detached', async () => {
  const calls = [], smoked = []
  const result = await smokeArtifacts('/release', { ...scripted(calls), canRun: () => null, smoke: (app) => { smoked.push(app); return finished(0) } })
  assert.deepEqual(result.passed, ['HarnessDesk-1.2.3-arm64.dmg', 'HarnessDesk-1.2.3-x64.dmg'])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(smoked, ['/release/.smoke-1/HarnessDesk.app', '/release/.smoke-2/HarnessDesk.app'])
  assert.equal(calls.filter((call) => call[0] === 'detach').length, 2)
})

test('whatever still runs from the volume is stopped before each detach, passed or failed', async () => {
  const calls = []
  await smokeArtifacts('/release', { ...scripted(calls), canRun: () => null, smoke: (app) => finished(app.includes('.smoke-1') ? 0 : 1) })
  assert.deepEqual(calls.filter((call) => call[0] !== 'mount'), [
    ['attach', '/release/HarnessDesk-1.2.3-arm64.dmg'], ['stop-running', '/release/.smoke-1'], ['detach', '/release/.smoke-1'],
    ['attach', '/release/HarnessDesk-1.2.3-x64.dmg'], ['stop-running', '/release/.smoke-2'], ['detach', '/release/.smoke-2'],
  ])
})

test('a smoke that fails fails that DMG, and the next DMG still runs', async () => {
  const calls = []
  const result = await smokeArtifacts('/release', { ...scripted(calls), canRun: () => null, smoke: (app) => finished(app.includes('.smoke-1') ? 1 : 0) })
  assert.deepEqual(result.failed, [{ dmg: 'HarnessDesk-1.2.3-arm64.dmg', reason: 'the packaged smoke exited 1' }])
  assert.deepEqual(result.passed, ['HarnessDesk-1.2.3-x64.dmg'])
})

test('a volume that will not detach fails its DMG rather than passing', async () => {
  const calls = []
  const result = await smokeArtifacts('/release', { ...scripted(calls, { detach: () => { throw new Error('busy') } }), canRun: () => null, smoke: () => finished(0) })
  assert.equal(result.passed.length, 0)
  assert.match(result.failed[0].reason, /Could not detach/)
})

test('an architecture this Mac cannot run is skipped with its reason, never mounted', async () => {
  const calls = []
  const result = await smokeArtifacts('/release', { ...scripted(calls), canRun: (arch) => (arch === 'x64' ? 'no Rosetta' : null), smoke: () => finished(0) })
  assert.deepEqual(result.skipped, [{ dmg: 'HarnessDesk-1.2.3-x64.dmg', reason: 'no Rosetta' }])
  assert.deepEqual(calls.filter((call) => call[0] === 'mount').map((call) => call[1]), ['/release/HarnessDesk-1.2.3-arm64.dmg'])
})

test('SIGINT stops the running smoke, detaches its volume, mounts nothing more and drops its handlers', async () => {
  const calls = [], options = scripted(calls)
  let stopped = null, exit
  const smoke = () => {
    const done = new Promise((settle) => { exit = settle })
    queueMicrotask(() => options.signals.emit('SIGINT', 'SIGINT'))
    return { done, stop: async (signal) => { stopped = signal; calls.push(['stopped']); exit(143) } }
  }
  const result = await smokeArtifacts('/release', { ...options, canRun: () => null, smoke })
  assert.equal(result.interrupted, 'SIGINT')
  assert.equal(stopped, 'SIGTERM', 'the smoke and its app are asked to quit, not killed outright')
  assert.deepEqual(calls.map((call) => call[0]), ['mount', 'attach', 'stopped', 'stop-running', 'detach'], 'detach comes after the smoke and everything left on the volume stopped, and the x64 DMG is never mounted')
  assert.deepEqual(result.failed, [{ dmg: 'HarnessDesk-1.2.3-arm64.dmg', reason: 'interrupted by SIGINT' }])
  assert.equal(options.signals.listenerCount('SIGINT') + options.signals.listenerCount('SIGTERM'), 0)
})

test('a NOT SMOKED artifact fails the gate unless --allow-skip, and is named either way', () => {
  const run = { passed: ['a-arm64.dmg'], failed: [], skipped: [{ dmg: 'a-x64.dmg', reason: 'no Rosetta' }], interrupted: null }
  const refused = smokeVerdict(run)
  assert.equal(refused.exitCode, 1)
  assert.match(refused.problem, /NOT SMOKED.*--allow-skip/)
  assert.ok(refused.lines.includes('  NOT SMOKED: a-x64.dmg (no Rosetta)'))
  const allowed = smokeVerdict(run, { allowSkip: true })
  assert.equal(allowed.exitCode, 0)
  assert.equal(allowed.problem, null)
  assert.ok(allowed.lines.includes('  NOT SMOKED: a-x64.dmg (no Rosetta)'))
})

test('failures, an interruption and nothing smoked fail even with --allow-skip', () => {
  const base = { passed: [], failed: [], skipped: [], interrupted: null }
  assert.equal(smokeVerdict({ ...base, passed: ['a'], failed: [{ dmg: 'b', reason: 'x' }] }, { allowSkip: true }).exitCode, 1)
  assert.equal(smokeVerdict({ ...base, skipped: [{ dmg: 'b', reason: 'x' }] }, { allowSkip: true }).exitCode, 1)
  assert.equal(smokeVerdict({ ...base, interrupted: 'SIGINT' }, { allowSkip: true }).exitCode, 130)
  assert.equal(smokeVerdict({ ...base, interrupted: 'SIGTERM' }).exitCode, 143)
  assert.equal(smokeVerdict({ ...base, passed: ['a'] }).exitCode, 0)
})

test('which architectures can run where', () => {
  assert.equal(cannotRun('arm64', { hostArch: 'arm64', rosetta: () => false }), null)
  assert.equal(cannotRun('x64', { hostArch: 'arm64', rosetta: () => true }), null)
  assert.match(cannotRun('x64', { hostArch: 'arm64', rosetta: () => false }), /Rosetta is not installed/)
  assert.match(cannotRun('arm64', { hostArch: 'x64', rosetta: () => true }), /cannot run on an x64 Mac/)
  assert.equal(dmgArch('HarnessDesk-1.2.3-x64.dmg'), 'x64')
  assert.equal(dmgArch('HarnessDesk.dmg'), null)
})

test('a binary runs translated only on Apple silicon and only without an arm64 slice', () => {
  const silicon = { appleSilicon: () => true }, intel = { appleSilicon: () => false }
  assert.equal(runsTranslated(['x86_64'], silicon), true, 'the x64 Lead Node on an Apple-silicon Mac')
  assert.equal(runsTranslated([], silicon), true, 'slices lipo could not read are warmed rather than guessed')
  assert.equal(runsTranslated(['arm64'], silicon), false)
  assert.equal(runsTranslated(['x86_64', 'arm64e'], silicon), false, 'a universal binary runs natively')
  assert.equal(runsTranslated(['x86_64'], intel), false, 'native on Intel')
  assert.equal(runsTranslated([], intel), false)
})

test('the smoke warms a translated Lead Node and iOS helper before anything times them', () => {
  const smoke = readFileSync(SMOKE, 'utf8')
  const warmNode = smoke.indexOf("warmIfTranslated(leadNode, ['-e', '0'], 'Lead Node')")
  assert.ok(warmNode > 0)
  assert.ok(warmNode < smoke.indexOf('probeLeadRuntime({'), 'before the 10s probe')
  assert.ok(warmNode < smoke.indexOf('const loaded = spawnSync('), 'before the restricted child, also 10s')
  const warmHelper = smoke.indexOf("warmIfTranslated(iosHelper, ['--version']")
  assert.ok(warmHelper > 0 && warmHelper < smoke.indexOf("spawnSync(iosHelper, ['--version'], { encoding: 'utf8', timeout: 5000 })"), 'before the 5s version check')
})

test('the gate runs the packaged smoke, and the smoke refuses an app without its interface', () => {
  assert.ok(existsSync(SMOKE))
  assert.match(readFileSync(SMOKE, 'utf8'), /verifyAppInterface\(appPath\)/)
})

test('stopping a smoke also ends the app it launched, which would otherwise hold the volume', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'hd-smoke-stop-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const script = join(scratch, 'stand-in.mjs'), pidFile = join(scratch, 'app.pid')
  // Stands in for smoke-packaged: it launches a long-lived "app" and does not
  // forward signals to it, as a node script without a handler does not.
  writeFileSync(script, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const app = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(pidFile)}, String(app.pid))`,
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  const smoke = startSmoke('/unused.app', { script, stdio: 'ignore' })
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50))
  const app = Number(readFileSync(pidFile, 'utf8'))
  await smoke.stop('SIGTERM')
  assert.equal(await smoke.done, 143)
  assert.throws(() => process.kill(app, 0), { code: 'ESRCH' }, 'the launched app is gone too')
})
