import type { IosCapability } from './ios-types.js'
import { DEVICE_RUN_TIMEOUT_MS } from './device-exec.js'

/** The engine's subprocess limits, also used to derive complete operation bounds. */
export const IOS_COMMAND_TIMEOUTS = {
  device: DEVICE_RUN_TIMEOUT_MS,
  probe: 15_000,
  boot: 60_000,
  install: 120_000,
  launch: 60_000,
  input: DEVICE_RUN_TIMEOUT_MS,
} as const

/** Diagnosis executes these steps sequentially, skipping selection for an explicit developer directory. */
export const IOS_DIAGNOSTIC_PROBES = {
  selection: ['xcode-select', ['-p']],
  simctl: ['xcrun', ['--find', 'simctl']],
  firstLaunch: ['xcodebuild', ['-checkFirstLaunchStatus']],
  sdks: ['xcodebuild', ['-showsdks']],
  runtimes: ['xcrun', ['simctl', 'list', 'runtimes', '-j']],
} as const

const device = IOS_COMMAND_TIMEOUTS.device
// captureFrame: target lookup, orientation before, PNG capture, orientation after.
const capture = 4 * device
// Input: target lookup, both captures, native work, and the optional legacy window path.
const input = device + 2 * capture + IOS_COMMAND_TIMEOUTS.input + 4 * device
export const IOS_ENGINE_BOUNDS_MS = {
  devices: device,
  booted: device,
  diagnose: Object.keys(IOS_DIAGNOSTIC_PROBES).length * IOS_COMMAND_TIMEOUTS.probe,
  boot: device + IOS_COMMAND_TIMEOUTS.boot + device,
  install: device + IOS_COMMAND_TIMEOUTS.install,
  launch: device + IOS_COMMAND_TIMEOUTS.launch,
  terminate: 2 * device,
  openUrl: 2 * device,
  getAppearance: 2 * device,
  setAppearance: 3 * device,
  frame: device + capture,
  screenshot: device + capture,
  tap: input,
  interact: input,
} satisfies Readonly<Record<keyof IosCapability, number>>
