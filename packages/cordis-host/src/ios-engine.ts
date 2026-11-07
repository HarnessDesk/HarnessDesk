import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IosHelper, type IosInputTransport } from './ios-helper.js'
import { currentIosInputSignal } from './ios-invocation.js'
import { validateIosAction } from './ios-validation.js'

import type { HostRuntime } from './runtime.js'
import { diagnoseIosEnvironment, type IosEnvironmentDependencies } from './ios-environment.js'
import type { IosAction, IosAppearance, IosFrame, IosSetup } from './ios-types.js'
import { isPng, runDevice } from './device-exec.js'

const SIMCTL_BIN = 'xcrun'


const assertBundleId = (bundleId: string): void => {
  if (bundleId.startsWith('-')) throw new Error('An app bundle id cannot begin with -.')
}

export interface SimDevice {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly runtime: string
}

export interface IosEngineDependencies {
  run?: typeof runDevice
  environment?: Partial<IosEnvironmentDependencies>
  input?: IosInputTransport
  helperPath?: string
}
export class IosEngine {
  private readonly input: IosInputTransport
  private inputQueue: Promise<unknown> = Promise.resolve()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly frames = new Map<string, { frame: IosFrame; generation: string }>()
  constructor(private readonly dependencies: IosEngineDependencies = {}) {
    this.input = dependencies.input ?? new IosHelper(dependencies.helperPath ? { executable: dependencies.helperPath } : {})
  }
  dispose(): void { this.input.dispose?.() }

  private readonly generations = new Map<string, { state: string; generation: string; lastBootedAt?: string }>()

  async diagnose(): Promise<IosSetup> {
    return diagnoseIosEnvironment(this.dependencies.environment)
  }

  private get run(): typeof runDevice { return this.dependencies.run ?? runDevice }

  /** Devices from `simctl list -j`, flattened with their runtime names. */
  async devices(): Promise<readonly SimDevice[]> {
    const { stdout } = await this.run(SIMCTL_BIN, ['simctl', 'list', 'devices', '-j'], {
      what: 'Listing simulators',
    })
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean; lastBootedAt?: string }[]>
    }
    const out: SimDevice[] = []
    for (const [runtime, list] of Object.entries(parsed.devices)) {
      for (const device of list) {
        if (device.isAvailable === false) continue
        const previous = this.generations.get(device.udid)
        if (!previous || previous.state !== device.state || previous.lastBootedAt !== device.lastBootedAt) {
          this.generations.set(device.udid, { state: device.state, generation: randomUUID(), lastBootedAt: device.lastBootedAt })
        }
        out.push({
          udid: device.udid,
          name: device.name,
          state: device.state,
          runtime: runtime.split('.').pop() ?? runtime,
        })
      }
    }
    return out
  }

  /** The booted device, or a sentence saying how to get one. */
  async booted(udid?: string): Promise<SimDevice> {
    const booted = (await this.devices()).filter((device) => device.state === 'Booted')
    if (udid !== undefined) {
      const device = booted.find((device) => device.udid === udid)
      if (!device) throw new Error(`Simulator ${udid} is not booted. Choose a device from ios_devices and boot it with ios_boot.`)
      return device
    }
    if (booted.length > 1) throw new Error(`More than one simulator is booted (${booted.map((device) => device.udid).join(', ')}). Name one with udid.`)
    if (booted.length === 0) {
      throw new Error('No simulator is booted. Boot one with ios_boot (see ios_devices for the list).')
    }
    return booted[0]!
  }

  async boot(udid: string, options: { openWindow?: boolean } = {}): Promise<void> {
    const device = (await this.devices()).find((device) => device.udid === udid)
    if (!device) throw new Error('Choose an exact device udid from ios_devices before booting a simulator.')
    await this.run(SIMCTL_BIN, ['simctl', 'boot', device.udid], { what: 'Booting the simulator', timeoutMs: 60_000 })
    this.generations.set(device.udid, { state: 'Booted', generation: randomUUID() })
    // Open the Simulator app so the person can watch — same headed principle
    // as the browser engine.
    if (options.openWindow !== false) await this.run('open', ['-a', 'Simulator'], { what: 'Opening Simulator' }).catch(() => {})
  }

  async install(appPath: string, udid?: string): Promise<void> {
    const device = await this.booted(udid)
    await this.exclusive(device.udid, () => this.run(SIMCTL_BIN, ['simctl', 'install', device.udid, appPath], {
      what: `Installing ${appPath}`,
      timeoutMs: 120_000,
    }))
  }

  async launch(bundleId: string, udid?: string): Promise<void> {
    assertBundleId(bundleId)
    const device = await this.booted(udid)
    await this.exclusive(device.udid, () => this.run(SIMCTL_BIN, ['simctl', 'launch', device.udid, bundleId], {
      what: `Launching ${bundleId}`,
      timeoutMs: 60_000,
    }))
  }

  async terminate(bundleId: string, udid?: string): Promise<void> {
    assertBundleId(bundleId)
    const device = await this.booted(udid)
    await this.exclusive(device.udid, () => this.run(SIMCTL_BIN, ['simctl', 'terminate', device.udid, bundleId], {
      what: `Terminating ${bundleId}`,
    }).catch(() => {}))
  }

  async openUrl(url: string, udid?: string): Promise<void> {
    const device = await this.booted(udid)
    await this.exclusive(device.udid, () => this.run(SIMCTL_BIN, ['simctl', 'openurl', device.udid, url], { what: `Opening ${url}` }))
  }

  /** A PNG at original resolution; coordinates refer to this image's pixels. */
  async screenshot(udid?: string): Promise<string> {
    return (await this.frame(udid)).url
  }

  private async exclusive<T>(udid: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(udid) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(run)
    this.queues.set(udid, work)
    try { return await work } finally { if (this.queues.get(udid) === work) this.queues.delete(udid) }
  }
  async frame(udid?: string): Promise<IosFrame> {
    const device = await this.booted(udid)
    return this.exclusive(device.udid, () => this.captureFrame(device.udid))
  }

  private async captureFrame(udid?: string): Promise<IosFrame> {
    const device = await this.booted(udid)
    const generation = this.generations.get(device.udid)!.generation
    const dir = mkdtempSync(join(tmpdir(), 'hd-sim-'))
    const file = join(dir, 'shot.png')
    try {
      const orientationBefore = await this.readRotation(device.udid)
      await this.run(SIMCTL_BIN, ['simctl', 'io', device.udid, 'screenshot', file], { what: 'Screenshotting the simulator' })
      const rotation = await this.readRotation(device.udid)
      if (rotation !== orientationBefore) throw new Error('The simulator display changed orientation during capture; capture a fresh frame.')
      const png = readFileSync(file)
      if (!isPng(png) || png.length < 33 || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('Could not read the screenshot PNG dimensions.')
      }
      const width = png.readUInt32BE(16)
      const height = png.readUInt32BE(20)
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) throw new Error('Could not read the screenshot dimensions.')
      // The digest binds the full currently oriented image, including rotations
      // that have the same dimensions. A nonce prevents reuse after an unobserved
      // restart; the generation also changes on observed boots.
      const frameId = createHash('sha256').update(device.udid).update(generation).update(randomUUID()).update(String(rotation)).update(png).digest('hex')
      const frame: IosFrame = { udid: device.udid, frameId, width, height, mimeType: 'image/png', url: `data:image/png;base64,${png.toString('base64')}`, ...(rotation === undefined ? {} : { rotation }) }
      this.frames.set(device.udid, { frame, generation })
      return frame
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  private async readRotation(udid: string): Promise<0 | 1 | 2 | 3 | undefined> {
    const { stdout } = await this.run(SIMCTL_BIN, ['simctl', 'io', udid, 'enumerate'], { what: 'Reading simulator display orientation' }).catch(() => ({ stdout: '', stderr: '' }))
    // The integrated screen has the geometry the screenshot and digitizer share.
    const integrated = stdout.split(/Screen Type: Integrated/)[1]?.split(/Screen Type:/)[0]
    const value = integrated?.match(/UI Orientation:\s*([^\r\n]+)/)?.[1]?.trim().toLowerCase().replace(/[ _-]/g, '')
    return ({ portrait: 0, portraitupsidedown: 2, landscapeleft: 3, landscaperight: 1 } as const)[value as 'portrait']
  }

  private async appearance(udid: string, value?: 'light' | 'dark'): Promise<IosAppearance> {
    try {
      const { stdout } = await this.run(SIMCTL_BIN, ['simctl', 'ui', udid, 'appearance', ...(value ? [value] : [])], { what: 'Reading simulator appearance' })
      const result = stdout.trim().toLowerCase()
      if (result === 'light' || result === 'dark') return result
      return /not supported|unsupported/.test(result) ? 'unsupported' : 'unknown'
    } catch (error) {
      if (/not supported|unsupported/i.test((error as Error).message)) return 'unsupported'
      throw error
    }
  }

  async getAppearance(udid?: string): Promise<IosAppearance> {
    const device = await this.booted(udid)
    return this.appearance(device.udid)
  }

  async setAppearance(value: 'light' | 'dark', udid?: string): Promise<IosAppearance> {
    if (value !== 'light' && value !== 'dark') throw new Error('Appearance must be light or dark.')
    const device = await this.booted(udid)
    return this.exclusive(device.udid, async () => {
      const applied = await this.appearance(device.udid, value)
      if (applied === 'unsupported') return applied
      return this.appearance(device.udid)
    })
  }

  private inputTurn<T>(run: () => Promise<T>): Promise<T> {
    const work = this.inputQueue.catch(() => {}).then(run)
    this.inputQueue = work.catch(() => {})
    return work
  }
  /** Serialize input and its frame together across all capability callers. */
  async interact(action: IosAction, udid?: string): Promise<IosFrame> {
    const device = await this.booted(udid).catch((error: unknown) => {
      if (/unable to find utility ["']?simctl|requires Xcode|invalid active developer path|spawn xcrun ENOENT/i.test(String(error))) throw new Error('iOS Simulator control requires Xcode; install and open Xcode, then select it in Settings › Locations › Command Line Tools.')
      throw error
    })
    const signal = currentIosInputSignal()
    return this.exclusive(device.udid, () => this.inputTurn(async () => {
      signal?.throwIfAborted()
      const remembered = this.frames.get(device.udid)
      const before = await this.captureFrame(device.udid)
      validateIosAction(action, before)
      if ('frameId' in action && action.frameId !== undefined &&
          (!remembered || remembered.frame.frameId !== action.frameId || remembered.generation !== this.generations.get(device.udid)?.generation || remembered.frame.width !== before.width || remembered.frame.height !== before.height || remembered.frame.rotation !== before.rotation)) {
        throw new Error('The simulator screenshot is stale; capture a fresh frame before sending input.')
      }
      const result = await this.input.request(device.udid, action, before, signal)
      const after = await this.captureFrame(device.udid)
      return typeof result['method'] === 'string' ? { ...after, inputMethod: result['method'] } : after
    }))
  }
  async tap(x: number, y: number, udid?: string): Promise<void> { await this.interact({ kind: 'tap', x, y }, udid) }
}
