import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'

import type { HostRuntime } from './runtime.js'
import { diagnoseIosEnvironment, type IosEnvironmentDependencies } from './ios-environment.js'
import type { IosAppearance, IosFrame, IosSetup } from './ios-types.js'
import { isPng, runDevice } from './device-exec.js'

/**
 * `ctx.ios` — the iOS Simulator, driven through Apple's own `simctl`.
 *
 * Everything except tapping is clean `xcrun simctl`. Tapping has no simctl
 * verb, so it goes through `cliclick` aimed at the Simulator window: the
 * window's position and scale are read from the window server each time,
 * and screenshot pixels are mapped into desktop pixels. That mapping is the
 * fragile part, so it recomputes per tap and fails with a sentence when the
 * Simulator window cannot be found — never with a click landing somewhere
 * unrelated.
 *
 * Gated by the manifest permission `ios: true`. `tap` takes coordinates in
 * the pixels of the screenshot the caller just took — click what you saw.
 */

const SIMCTL_BIN = 'xcrun'
const CLICLICK_PATHS = ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']

export interface SimDevice {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly runtime: string
}

export class IosService extends Service {
  static [Service.tracker] = { associate: 'ios', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
    private readonly dependencies: { run?: typeof runDevice; environment?: Partial<IosEnvironmentDependencies> } = {},
  ) {
    super(ctx, 'ios')
  }

  private readonly generations = new Map<string, { state: string; generation: string; lastBootedAt?: string }>()

  async diagnose(): Promise<IosSetup> {
    this.runtime.owner(this.ctx).gate.assertIos()
    return diagnoseIosEnvironment(this.dependencies.environment)
  }

  private get run(): typeof runDevice { return this.dependencies.run ?? runDevice }

  /** Devices from `simctl list -j`, flattened with their runtime names. */
  async devices(): Promise<readonly SimDevice[]> {
    this.runtime.owner(this.ctx).gate.assertIos()
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
    this.runtime.owner(this.ctx).gate.assertIos()
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
    this.runtime.owner(this.ctx).gate.assertIos()
    await this.run(SIMCTL_BIN, ['simctl', 'boot', udid], { what: 'Booting the simulator', timeoutMs: 60_000 })
    this.generations.set(udid, { state: 'Booted', generation: randomUUID() })
    // Open the Simulator app so the person can watch — same headed principle
    // as the browser engine.
    if (options.openWindow !== false) await this.run('open', ['-a', 'Simulator'], { what: 'Opening Simulator' }).catch(() => {})
  }

  async install(appPath: string, udid?: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted(udid)
    await this.run(SIMCTL_BIN, ['simctl', 'install', device.udid, appPath], {
      what: `Installing ${appPath}`,
      timeoutMs: 120_000,
    })
  }

  async launch(bundleId: string, udid?: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted(udid)
    await this.run(SIMCTL_BIN, ['simctl', 'launch', device.udid, bundleId], {
      what: `Launching ${bundleId}`,
      timeoutMs: 60_000,
    })
  }

  async terminate(bundleId: string, udid?: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted(udid)
    await this.run(SIMCTL_BIN, ['simctl', 'terminate', device.udid, bundleId], {
      what: `Terminating ${bundleId}`,
    }).catch(() => {})
  }

  async openUrl(url: string, udid?: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted(udid)
    await this.run(SIMCTL_BIN, ['simctl', 'openurl', device.udid, url], { what: `Opening ${url}` })
  }

  /** A PNG at original resolution; coordinates refer to this image's pixels. */
  async screenshot(udid?: string): Promise<string> {
    this.runtime.owner(this.ctx).gate.assertIos()
    return (await this.frame(udid)).url
  }

  async frame(udid?: string): Promise<IosFrame> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted(udid)
    const generation = this.generations.get(device.udid)!.generation
    const dir = mkdtempSync(join(tmpdir(), 'hd-sim-'))
    const file = join(dir, 'shot.png')
    try {
      await this.run(SIMCTL_BIN, ['simctl', 'io', device.udid, 'screenshot', file], { what: 'Screenshotting the simulator' })
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
      const frameId = createHash('sha256').update(device.udid).update(generation).update(randomUUID()).update(png).digest('hex')
      return { udid: device.udid, frameId, width, height, mimeType: 'image/png', url: `data:image/png;base64,${png.toString('base64')}` }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted(udid)
    return this.appearance(device.udid)
  }

  async setAppearance(value: 'light' | 'dark', udid?: string): Promise<IosAppearance> {
    this.runtime.owner(this.ctx).gate.assertIos()
    if (value !== 'light' && value !== 'dark') throw new Error('Appearance must be light or dark.')
    const device = await this.booted(udid)
    const applied = await this.appearance(device.udid, value)
    if (applied === 'unsupported') return applied
    return this.appearance(device.udid)
  }

  /** The Simulator window frame, from the window server via AppleScript. */
  private async windowFrame(): Promise<{ x: number; y: number; width: number; height: number }> {
    // The Simulator window frame, from the window server via AppleScript.
    const script =
      'tell application "System Events" to tell process "Simulator" to get {position, size} of front window'
    const { stdout } = await this.run('osascript', ['-e', script], {
      what: 'Locating the Simulator window',
    })
    const numbers = stdout.match(/-?\d+/g)?.map(Number) ?? []
    if (numbers.length < 4) throw new Error('Could not read the Simulator window frame. Is the Simulator app open and frontmost on this desktop?')
    return { x: numbers[0]!, y: numbers[1]!, width: numbers[2]!, height: numbers[3]! }
  }

  /**
   * Taps at SCREENSHOT-pixel coordinates — the same pixels the model just
   * looked at, the convention the browser engine set. The screenshot's own
   * dimensions give the mapping into the Simulator window, so no guess
   * about device points or scale factors is ever made: measure, then click.
   */
  async tap(x: number, y: number, udid?: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const cliclick = CLICLICK_PATHS.find((path) => existsSync(path))
    if (!cliclick) {
      throw new Error('Tapping needs cliclick (brew install cliclick). Screenshots and launches work without it.')
    }
    const shot = await this.screenshot(udid)
    const png = Buffer.from(shot.slice('data:image/png;base64,'.length), 'base64')
    const pixelWidth = png.readUInt32BE(16)
    const pixelHeight = png.readUInt32BE(20)
    if (!(pixelWidth > 0 && pixelHeight > 0)) throw new Error('Could not read the screenshot dimensions.')

    await this.run('open', ['-a', 'Simulator'], { what: 'Fronting Simulator' }).catch(() => {})
    const frame = await this.windowFrame()
    const TITLE_BAR = 28
    const contentWidth = frame.width
    const contentHeight = frame.height - TITLE_BAR
    const screenX = Math.round(frame.x + (x / pixelWidth) * contentWidth)
    const screenY = Math.round(frame.y + TITLE_BAR + (y / pixelHeight) * contentHeight)
    await this.run(cliclick, [`c:${screenX},${screenY}`], { what: `Tapping (${x}, ${y})` })
  }
}
