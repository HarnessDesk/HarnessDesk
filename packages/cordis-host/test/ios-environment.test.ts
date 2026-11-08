import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { iosService, type ProbeResult } from './fixtures/ios.js'
import { withIosInputSignal } from '../src/ios-invocation.js'
import { IOS_ENGINE_BOUNDS_MS } from '../src/ios-timeouts.js'

const ok = (stdout = ''): ProbeResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): ProbeResult => ({ exitCode: 1, stdout: '', stderr })
const fixture = (options: { selected?: string; selection?: ProbeResult; explicit?: string; installed?: boolean; validXcode?: boolean; sdk?: string; runtimes?: ProbeResult; launch?: ProbeResult; find?: ProbeResult; platform?: string } = {}) => {
  const calls: { binary: string; args: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs: number }[] = []
  const service = iosService({ environment: {
    platform: options.platform ?? 'darwin', developerDirectory: options.explicit,
    exists: (path: string) => options.installed !== false && (path === '/Applications/Xcode.app' || options.validXcode === true && path.endsWith('/Contents/Developer/usr/bin/xcodebuild')),
    execute: async (binary: string, args: readonly string[], limits: { env?: NodeJS.ProcessEnv; timeoutMs: number }) => {
      calls.push({ binary, args, ...limits })
      if (binary === 'xcode-select') return options.selection ?? ok(options.selected ?? '/Applications/Xcode.app/Contents/Developer')
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


test('first launch has its own actionable diagnosis', async () => {
  const { service, calls } = fixture({ launch: fail('') })
  const setup = await service.diagnose()
  assert.equal(setup.code, 'firstLaunch')
  assert.equal(setup.message, 'Open Xcode once so it can finish installing its components, then retry.')
  assert.ok(calls.every(({ args }) => !args.includes('-showsdks')), 'stop before querying SDKs')
})

test('missing simctl in a selected Xcode diagnoses pending first launch', async () => {
  for (const stderr of ['unable to find utility "simctl", not a developer tool or in PATH', 'simctl missing']) {
    const { service, calls } = fixture({ validXcode: true, find: fail(stderr), launch: fail('Install additional components with -runFirstLaunch') })
    const setup = await service.diagnose()
    assert.equal(setup.code, 'firstLaunch')
    assert.deepEqual(calls.map(({ binary, args }) => [binary, ...args]), [['xcode-select', '-p'], ['xcrun', '--find', 'simctl'], ['xcodebuild', '-checkFirstLaunchStatus']])
    assert.ok(calls.reduce((total, call) => total + call.timeoutMs, 0) <= IOS_ENGINE_BOUNDS_MS.diagnose)
  }
})

test('the missing-tool fallback preserves first-launch errors and the original selection diagnosis', async () => {
  for (const [launch, expected] of [
    [ok(), 'developerDirectory'],
    [fail('You have not agreed to the Xcode license.'), 'license'],
    [fail('Permission denied'), 'serviceUnavailable'],
    [{ ...fail('timed out'), timedOut: true }, 'serviceUnavailable'],
    [{ ...fail('terminated by SIGTERM'), exitCode: null }, 'serviceUnavailable'],
  ] as const) {
    const { service, calls } = fixture({ validXcode: true, explicit: '/Applications/Xcode-Beta.app/Contents/Developer', find: fail('unable to find utility "simctl"'), launch })
    assert.equal((await service.diagnose()).code, expected)
    assert.deepEqual(calls.map(({ args }) => args[0]), ['--find', '-checkFirstLaunchStatus'])
    assert.ok(calls.every(({ env }) => env?.['DEVELOPER_DIR'] === '/Applications/Xcode-Beta.app/Contents/Developer'))
  }
})

test('invalid selections and unrelated simctl failures do not invoke first launch', async () => {
  for (const find of [fail('invalid active developer path: unable to find utility simctl'), fail('permission denied'), { ...fail('unable to find simctl'), timedOut: true }]) {
    const { service, calls } = fixture({ validXcode: true, find })
    const result = await service.diagnose()
    assert.equal(result.code, find.timedOut || find.stderr === 'permission denied' ? 'serviceUnavailable' : 'developerDirectory')
    assert.ok(calls.every(({ args }) => args[0] !== '-checkFirstLaunchStatus'))
  }
  const missingTool = fixture({ validXcode: false, find: fail('unable to find utility simctl'), launch: fail('first launch pending') })
  assert.equal((await missingTool.service.diagnose()).code, 'developerDirectory')
  assert.ok(missingTool.calls.every(({ args }) => args[0] !== '-checkFirstLaunchStatus'))
})

test('cancellation during the missing-simctl first-launch probe stops diagnosis', async () => {
  const controller = new AbortController(), calls: string[] = []
  const service = iosService({ environment: {
    platform: 'darwin', developerDirectory: '/Applications/Xcode.app/Contents/Developer', exists: () => true,
    execute: async (_binary, args, options) => {
      calls.push(args[0]!)
      assert.equal(options.signal, controller.signal)
      if (args[0] === '--find') return fail('unable to find utility "simctl"')
      controller.abort(new Error('cancelled'))
      return fail('first launch pending')
    },
  } })
  await assert.rejects(withIosInputSignal(controller.signal, () => service.diagnose()), /cancelled/)
  assert.deepEqual(calls, ['--find', '-checkFirstLaunchStatus'])
})

test('empty selected developer directory fails before xcrun', async () => {
  const { service, calls } = fixture({ selected: '  \n' })
  const setup = await service.diagnose()
  assert.equal(setup.code, 'serviceUnavailable')
  assert.match(setup.message, /empty developer directory/i)
  assert.equal(setup.developerDirectory, undefined)
  assert.deepEqual(calls.map(({ binary }) => binary), ['xcode-select'])
})

const probeFailure = (t: TestContext, code: string, killed: boolean) => {
  t.mock.method(childProcess, 'execFile', ((_binary: string, _args: string[], _options: unknown,
    callback: (error: Error, stdout: string, stderr: string) => void) => {
    callback(Object.assign(new Error('synthetic probe failure'), { code, killed }), '', '')
  }) as unknown as typeof childProcess.execFile)
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return iosService({ environment: {
    platform: 'darwin', developerDirectory: '/Applications/Xcode.app/Contents/Developer', exists: () => true,
  } }).diagnose()
}

test('maxBuffer termination is not diagnosed as a timeout', async (t) => {
  const setup = await probeFailure(t, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', true)
  assert.equal(setup.code, 'serviceUnavailable')
  assert.doesNotMatch(setup.message, /timed out/i)
})

test('an aborted timeout is recognized without the killed flag', async (t) => {
  const setup = await probeFailure(t, 'ABORT_ERR', false)
  assert.equal(setup.code, 'serviceUnavailable')
  assert.match(setup.message, /timed out/i)
})

test('an empty-stderr non-zero first-launch exit remains firstLaunch', async (t) => {
  t.mock.method(childProcess, 'execFile', ((_binary: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (args[0] === '--find') callback(null, '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl', '')
    else callback(Object.assign(new Error('Command failed: xcodebuild -checkFirstLaunchStatus'), { code: 1 }), '', '')
  }) as unknown as typeof childProcess.execFile)
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const setup = await iosService({ environment: {
    platform: 'darwin', developerDirectory: '/Applications/Xcode.app/Contents/Developer', exists: () => true,
  } }).diagnose()
  assert.equal(setup.code, 'firstLaunch')
  assert.equal(setup.message, 'Open Xcode once so it can finish installing its components, then retry.')
})

test('permission and internal errors on a non-zero first-launch exit retain their failure', async () => {
  for (const stderr of ['Permission denied', 'internal error']) {
    const setup = await fixture({ launch: fail(stderr) }).service.diagnose()
    assert.equal(setup.code, 'serviceUnavailable', stderr)
    assert.ok(setup.message.includes(stderr), 'the original stderr remains actionable')
  }
})

test('recognized first-launch work is distinguished from a crash, signal or timeout', async () => {
  for (const stderr of ['Run -runFirstLaunch', 'FIRST LAUNCH work remains', 'Install COMPONENTS', 'Missing SYSTEM CONTENT']) {
    assert.equal((await fixture({ launch: fail(stderr) }).service.diagnose()).code, 'firstLaunch')
  }
  for (const launch of [fail('Segmentation fault'), { ...fail('terminated by SIGTERM'), exitCode: null }, { ...fail(''), timedOut: true }]) {
    const setup = await fixture({ launch }).service.diagnose()
    assert.equal(setup.code, 'serviceUnavailable')
    if (launch.stderr) assert.ok(setup.message.includes(launch.stderr))
  }
})

test('the execFile probe receives an AbortSignal in its options', async (t) => {
  const captured: { signal?: AbortSignal }[] = []
  t.mock.method(childProcess, 'execFile', ((_binary: string, _args: string[], options: { signal?: AbortSignal },
    callback: (error: Error, stdout: string, stderr: string) => void) => {
    captured.push(options)
    callback(Object.assign(new Error('synthetic probe failure'), { code: 'EACCES' }), '', 'Permission denied')
  }) as unknown as typeof childProcess.execFile)
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await iosService({ environment: {
    platform: 'darwin', developerDirectory: '/Applications/Xcode.app/Contents/Developer', exists: () => true,
  } }).diagnose()
  assert.equal(captured.length, 1)
  assert.ok(captured[0]!.signal instanceof AbortSignal)
  assert.equal(captured[0]!.signal!.aborted, false)
})

test('an unselected developer directory diagnoses installed and absent Xcode', async () => {
  const stderr = 'xcode-select: error: unable to get active developer directory, use `sudo xcode-select --switch path/to/Xcode.app` to set one (or see `man xcode-select`)'
  for (const installed of [true, false]) {
    const { service, calls } = fixture({ selection: fail(stderr), installed })
    assert.equal((await service.diagnose()).code, installed ? 'developerDirectory' : 'xcodeMissing')
    assert.deepEqual(calls.map(({ binary, args }) => [binary, ...args]), [['xcode-select', '-p']])
  }
  for (const stderr of ['UNABLE TO GET ACTIVE DEVELOPER DIRECTORY', 'Use XCODE-SELECT --SWITCH path', 'Use --INSTALL', 'NO DEVELOPER TOOLS']) {
    assert.equal((await fixture({ selection: fail(stderr) }).service.diagnose()).code, 'developerDirectory')
  }
})

test('selector EACCES preserves stderr or errorMessage as a service failure', async () => {
  for (const detail of [{ stderr: 'Permission denied' }, { stderr: '', errorMessage: 'spawn xcode-select EACCES' }]) {
    const { service, calls } = fixture({ selection: { ...fail(''), ...detail, exitCode: 'EACCES' } })
    const setup = await service.diagnose()
    assert.equal(setup.code, 'serviceUnavailable')
    assert.ok(setup.message.includes(detail.stderr || detail.errorMessage!))
    assert.deepEqual(calls.map(({ binary }) => binary), ['xcode-select'])
  }
})

test('a selector terminated by a signal remains a service failure', async () => {
  const setup = await fixture({ selection: { ...fail('terminated by SIGTERM'), exitCode: null } }).service.diagnose()
  assert.equal(setup.code, 'serviceUnavailable')
  assert.match(setup.message, /terminated by SIGTERM/)
})

test('an unrelated numeric selector failure retains its diagnostic', async () => {
  const setup = await fixture({ selection: fail('internal error') }).service.diagnose()
  assert.equal(setup.code, 'serviceUnavailable')
  assert.match(setup.message, /internal error/)
})

test('a missing selector binary diagnoses absent Xcode unless Xcode is installed', async () => {
  for (const installed of [false, true]) {
    const setup = await fixture({ selection: { ...fail(''), exitCode: 'ENOENT', errorMessage: 'spawn xcode-select ENOENT' }, installed }).service.diagnose()
    assert.equal(setup.code, installed ? 'developerDirectory' : 'xcodeMissing')
  }
})
