import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IosSetup } from './ios-types.js'
import { IOS_COMMAND_TIMEOUTS, IOS_DIAGNOSTIC_PROBES } from './ios-timeouts.js'
import { currentIosInputSignal } from './ios-invocation.js'

/** Probe results retain exit status and stderr; a failed query never means an empty inventory. */
export interface IosProbeResult {
  readonly exitCode: number | string | null
  readonly stdout: string
  readonly stderr: string
  readonly errorMessage?: string
  readonly timedOut?: boolean
}

export interface IosEnvironmentDependencies {
  readonly platform: string
  readonly developerDirectory: string | undefined
  readonly exists: (path: string) => boolean
  readonly execute: (binary: string, args: readonly string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<IosProbeResult>
}

const execute: IosEnvironmentDependencies['execute'] = (binary, args, options) => new Promise((resolve) => {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  execFile(binary, [...args], { signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout, env: options.env, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ exitCode: error ? error.code ?? null : 0, stdout, stderr, errorMessage: error?.message, timedOut: error?.code === 'ABORT_ERR' })
  })
})

const messages = {
  ready: 'iOS Simulator is ready.',
  xcodeMissing: 'Install Xcode from the App Store, open it once, then select it in Settings › Locations › Command Line Tools.',
  developerDirectory: 'Select the installed Xcode in Xcode › Settings › Locations › Command Line Tools; the current developer directory does not provide the iOS Simulator.',
  license: 'Open Xcode and accept its license, then retry.',
  firstLaunch: 'Open Xcode once so it can finish installing its components, then retry.',
  platformMissing: 'Install iOS support in Xcode › Settings › Components.',
  runtimeMissing: 'Download an iOS Simulator runtime in Xcode › Settings › Components.',
  serviceUnavailable: 'Could not query the iOS Simulator service.',
  unsupportedHost: 'The iOS Simulator requires macOS and Xcode.',
} satisfies Record<IosSetup['code'], string>

/** Read-only, bounded probes. Never select Xcode, accept a license or install a component. */
export const diagnoseIosEnvironment = async (overrides: Partial<IosEnvironmentDependencies> = {}): Promise<IosSetup> => {
  const deps: IosEnvironmentDependencies = { platform: process.platform, developerDirectory: process.env['DEVELOPER_DIR'], exists: existsSync, execute, ...overrides }
  let developerDirectory = deps.developerDirectory
  const answer = (code: IosSetup['code'], detail?: string): IosSetup => ({
    available: code === 'ready', code, message: detail ? `${messages[code]} ${detail}` : messages[code],
    ...(developerDirectory ? { developerDirectory } : {}),
  })
  if (deps.platform !== 'darwin') return answer('unsupportedHost')
  const signal = currentIosInputSignal()
  const probe = async (step: keyof typeof IOS_DIAGNOSTIC_PROBES) => {
    signal?.throwIfAborted()
    const [binary, args] = IOS_DIAGNOSTIC_PROBES[step]
    const result = await deps.execute(binary, args, {
      timeoutMs: IOS_COMMAND_TIMEOUTS.probe, env: { ...process.env, ...(developerDirectory !== undefined ? { DEVELOPER_DIR: developerDirectory } : {}) },
      ...(signal ? { signal } : {}),
    })
    signal?.throwIfAborted()
    return result
  }
  const failed = (result: IosProbeResult): IosSetup => {
    if (!result.timedOut && /license|licence/i.test(`${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ''}`)) return answer('license')
    const detail = (result.stderr || result.errorMessage || result.stdout).trim().split('\n').slice(-2).join(' · ')
    return answer('serviceUnavailable', `${result.timedOut ? 'Probe timed out. ' : ''}${detail}`.trim() || `Probe exited with status ${result.exitCode}.`)
  }
  const firstLaunchFailure = (launch: IosProbeResult): IosSetup => {
    const failure = failed(launch)
    const pending = !launch.stderr.trim() || /runFirstLaunch|first launch|components|system content/i.test(launch.stderr)
    return failure.code !== 'license' && !launch.timedOut && typeof launch.exitCode === 'number' && pending ? answer('firstLaunch') : failure
  }
  if (developerDirectory === undefined) {
    const selected = await probe('selection')
    if (selected.exitCode !== 0) {
      if (selected.timedOut) return failed(selected)
      const unselected = typeof selected.exitCode === 'number' && /unable to get active developer directory|xcode-select\s+--switch|--install|no developer tools/i.test(selected.stderr)
      if (selected.exitCode !== 'ENOENT' && !unselected) return failed(selected)
      return answer(deps.exists('/Applications/Xcode.app') ? 'developerDirectory' : 'xcodeMissing')
    }
    const directory = selected.stdout.trim()
    if (!directory) return failed({ ...selected, exitCode: null, stderr: 'xcode-select returned an empty developer directory.' })
    developerDirectory = directory
  }
  const found = await probe('simctl')
  if (found.exitCode !== 0) {
    if (found.timedOut || /license|licence/i.test(found.stderr)) return failed(found)
    // A service failure is not an install problem. Only a missing tool/invalid
    // developer selection earns a setup instruction.
    if (!/unable to find|not found|missing|invalid.*developer|active developer|ENOENT/i.test(found.stderr)) return failed(found)
    // A selected Xcode can lack simctl until first launch installs its
    // components. Do not make that inference for CLT or an invalid selection.
    if (developerDirectory && !developerDirectory.includes('CommandLineTools') &&
        deps.exists(join(developerDirectory, 'usr/bin/xcodebuild')) &&
        !/invalid[^\n]*developer|developer[^\n]*invalid/i.test(found.stderr) &&
        /unable to find[^\n]*simctl|simctl[^\n]*(?:not found|missing)|(?:not found|missing)[^\n]*simctl/i.test(found.stderr)) {
      const launch = await probe('firstLaunch')
      if (launch.exitCode !== 0) return firstLaunchFailure(launch)
    }
    const installed = deps.exists('/Applications/Xcode.app') || (!!developerDirectory && !developerDirectory.includes('CommandLineTools') && deps.exists(developerDirectory))
    return answer(installed ? 'developerDirectory' : 'xcodeMissing')
  }
  const launch = await probe('firstLaunch')
  if (launch.exitCode !== 0) {
    return firstLaunchFailure(launch)
  }
  const sdks = await probe('sdks')
  if (sdks.exitCode !== 0) return failed(sdks)
  if (!/\b(?:iphoneos|iphonesimulator)\d/i.test(sdks.stdout)) return answer('platformMissing')
  const runtimes = await probe('runtimes')
  if (runtimes.exitCode !== 0 || runtimes.timedOut || /CoreSimulator.*(?:invalid|failed|unavailable)|permission denied|connection refused/i.test(runtimes.stderr)) return failed(runtimes)
  try {
    const parsed: unknown = JSON.parse(runtimes.stdout)
    if (!parsed || typeof parsed !== 'object' || !('runtimes' in parsed) || !Array.isArray(parsed.runtimes)) throw new Error('Missing runtime inventory')
    if (parsed.runtimes.some((runtime: unknown) => !runtime || typeof runtime !== 'object' || !('identifier' in runtime) || typeof runtime.identifier !== 'string' || !('isAvailable' in runtime) || typeof runtime.isAvailable !== 'boolean')) throw new Error('Invalid runtime inventory')
    const installed = parsed.runtimes.some((runtime: { identifier: string; isAvailable: boolean }) => /\.iOS-/.test(runtime.identifier) && runtime.isAvailable)
    return answer(installed ? 'ready' : 'runtimeMissing')
  } catch {
    return answer('serviceUnavailable', 'The runtime inventory was not valid JSON with runtime availability.')
  }
}
