import assert from 'node:assert/strict'
import test from 'node:test'
import { iosService, type ProbeResult } from './fixtures/ios.js'

const ok = (stdout = ''): ProbeResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): ProbeResult => ({ exitCode: 1, stdout: '', stderr })
const fixture = (options: { selected?: string; explicit?: string; installed?: boolean; sdk?: string; runtimes?: ProbeResult; launch?: ProbeResult; find?: ProbeResult; platform?: string } = {}) => {
  const calls: { binary: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs: number }[] = []
  const service = iosService({ environment: {
    platform: options.platform ?? 'darwin', developerDirectory: options.explicit,
    exists: (path: string) => options.installed !== false && path === '/Applications/Xcode.app',
    execute: async (binary: string, args: readonly string[], limits: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
      calls.push({ binary, args, ...limits })
      if (binary === 'xcode-select') return ok(options.selected ?? '/Applications/Xcode.app/Contents/Developer')
      if (args[0] === '--find') return options.find ?? ok('/Applications/Xcode.app/Contents/Developer/usr/bin/simctl')
      if (args[0] === '-checkFirstLaunchStatus') return options.launch ?? ok()
      if (args[0] === '-showsdks') return ok(options.sdk ?? 'iOS Simulator -sdk iphonesimulator27.0')
      if (args.join(' ') === 'simctl list runtimes -j') return options.runtimes ?? ok(JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', isAvailable: true }] }))
      throw new Error(`Unexpected probe ${binary} ${args.join(' ')}`)
    },
  } })
  return { service, calls }
}

test('diagnoses CLT selection despite an installed Xcode', async () => {
  const { service, calls } = fixture({ selected: '/Library/Developer/CommandLineTools', find: fail('unable to find utility simctl') })
  const setup = await service.diagnose()
  assert.equal(setup.code, 'developerDirectory')
  assert.equal(setup.message, 'Select the installed Xcode in Xcode › Settings › Locations › Command Line Tools; the current developer directory does not provide the iOS Simulator.')
  assert.ok(calls.every((call) => call.timeoutMs > 0))
  assert.deepEqual(calls.map(({ binary, args }) => [binary, ...args]), [['xcode-select', '-p'], ['xcrun', '--find', 'simctl']])
})

test('distinguishes missing SDK from missing runtime', async () => {
  assert.equal((await fixture({ sdk: 'macOS -sdk macosx27.0' }).service.diagnose()).message, 'Install iOS support in Xcode › Settings › Components.')
  assert.equal((await fixture({ runtimes: ok('{"runtimes":[]}') }).service.diagnose()).message, 'Download an iOS Simulator runtime in Xcode › Settings › Components.')
})

test('identifies license refusal', async () => {
  const { service, calls } = fixture({ launch: fail('You have not agreed to the Xcode license agreements.') })
  assert.equal((await service.diagnose()).message, 'Open Xcode and accept its license, then retry.')
  assert.ok(calls.every(({ args }) => !args.some((arg) => /accept|install|download|sudo|switch/i.test(arg))))
})

test('preserves service-unavailable failures', async () => {
  for (const result of [fail('CoreSimulatorService connection became invalid: permission denied'), ok('malformed JSON'), { ...fail('probe timed out'), timedOut: true }]) {
    const setup = await fixture({ runtimes: result }).service.diagnose()
    assert.equal(setup.code, 'serviceUnavailable')
    assert.equal(setup.available, false)
    assert.doesNotMatch(setup.message, /Download an iOS Simulator runtime/)
  }
})

test('respects explicit DEVELOPER_DIR and diagnoses absent Xcode and unsupported hosts', async () => {
  const { service, calls } = fixture({ selected: '/Library/Developer/CommandLineTools', explicit: '/Applications/Xcode-Beta.app/Contents/Developer' })
  assert.equal((await service.diagnose()).code, 'ready')
  assert.ok(calls.every(({ binary, env }) => binary !== 'xcode-select' && env?.['DEVELOPER_DIR'] === '/Applications/Xcode-Beta.app/Contents/Developer'))
  assert.equal((await fixture({ installed: false, selected: '/Library/Developer/CommandLineTools', find: fail('simctl missing') }).service.diagnose()).message, 'Install Xcode from the App Store, open it once, then select it in Settings › Locations › Command Line Tools.')
  const unsupported = fixture({ platform: 'linux' })
  assert.equal((await unsupported.service.diagnose()).code, 'unsupportedHost')
  assert.equal(unsupported.calls.length, 0)
})

test('a denied service connection cannot masquerade as an empty runtime inventory', async () => {
  const result = { ...ok('{"runtimes":[]}'), stderr: 'CoreSimulatorService connection failed: permission denied' }
  const setup = await fixture({ runtimes: result }).service.diagnose()
  assert.equal(setup.code, 'serviceUnavailable')
  assert.match(setup.message, /permission denied/)
})
