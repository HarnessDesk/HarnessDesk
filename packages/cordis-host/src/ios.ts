import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'

import type { HostRuntime } from './runtime.js'
import { runDevice } from './device-exec.js'

/**
 * `ctx.ios` — the iOS Simulator, driven through Apple's own `simctl`.
 *
 * Everything except tapping is clean `xcrun simctl`. Tapping has no simctl
 * verb, so it goes through `cliclick` aimed at the Simulator window: the
 * window's position and scale are read from the window server each time,
 * and device points are mapped into screen pixels. That mapping is the
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
  ) {
    super(ctx, 'ios')
  }


  /** Devices from `simctl list -j`, flattened with their runtime names. */
  async devices(): Promise<readonly SimDevice[]> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const { stdout } = await runDevice(SIMCTL_BIN, ['simctl', 'list', 'devices', '-j'], {
      what: 'Listing simulators',
    })
    const parsed = JSON.parse(stdout) as {
      devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]>
    }
    const out: SimDevice[] = []
    for (const [runtime, list] of Object.entries(parsed.devices)) {
      for (const device of list) {
        if (device.isAvailable === false) continue
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
  async booted(): Promise<SimDevice> {
    const booted = (await this.devices()).filter((device) => device.state === 'Booted')
    if (booted.length === 0) {
      throw new Error('No simulator is booted. Boot one with ios_boot (see ios_devices for the list).')
    }
    return booted[0]!
  }

  async boot(udid: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    await runDevice(SIMCTL_BIN, ['simctl', 'boot', udid], { what: 'Booting the simulator', timeoutMs: 60_000 })
    // Open the Simulator app so the person can watch — same headed principle
    // as the browser engine.
    await runDevice('open', ['-a', 'Simulator'], { what: 'Opening Simulator' }).catch(() => {})
  }

  async install(appPath: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted()
    await runDevice(SIMCTL_BIN, ['simctl', 'install', device.udid, appPath], {
      what: `Installing ${appPath}`,
      timeoutMs: 120_000,
    })
  }

  async launch(bundleId: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted()
    await runDevice(SIMCTL_BIN, ['simctl', 'launch', device.udid, bundleId], {
      what: `Launching ${bundleId}`,
      timeoutMs: 60_000,
    })
  }

  async terminate(bundleId: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted()
    await runDevice(SIMCTL_BIN, ['simctl', 'terminate', device.udid, bundleId], {
      what: `Terminating ${bundleId}`,
    }).catch(() => {})
  }

  async openUrl(url: string): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted()
    await runDevice(SIMCTL_BIN, ['simctl', 'openurl', device.udid, url], { what: `Opening ${url}` })
  }

  /** A PNG of the booted device's screen, as a data URL. */
  async screenshot(): Promise<string> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const device = await this.booted()
    const dir = mkdtempSync(join(tmpdir(), 'hd-sim-'))
    const file = join(dir, 'shot.png')
    try {
      await runDevice(SIMCTL_BIN, ['simctl', 'io', device.udid, 'screenshot', file], {
        what: 'Screenshotting the simulator',
      })
      return `data:image/png;base64,${readFileSync(file).toString('base64')}`
    } finally {
      // The directory as well: removing the file alone left one behind per screenshot (#46).
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** The Simulator window frame, from the window server via AppleScript. */
  private async windowFrame(): Promise<{ x: number; y: number; width: number; height: number }> {
    // The Simulator window frame, from the window server via AppleScript.
    const script =
      'tell application "System Events" to tell process "Simulator" to get {position, size} of front window'
    const { stdout } = await runDevice('osascript', ['-e', script], {
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
  async tap(x: number, y: number): Promise<void> {
    this.runtime.owner(this.ctx).gate.assertIos()
    const cliclick = CLICLICK_PATHS.find((path) => existsSync(path))
    if (!cliclick) {
      throw new Error('Tapping needs cliclick (brew install cliclick). Screenshots and launches work without it.')
    }
    const shot = await this.screenshot()
    const png = Buffer.from(shot.slice('data:image/png;base64,'.length), 'base64')
    const pixelWidth = png.readUInt32BE(16)
    const pixelHeight = png.readUInt32BE(20)
    if (!(pixelWidth > 0 && pixelHeight > 0)) throw new Error('Could not read the screenshot dimensions.')

    await runDevice('open', ['-a', 'Simulator'], { what: 'Fronting Simulator' }).catch(() => {})
    const frame = await this.windowFrame()
    const TITLE_BAR = 28
    const contentWidth = frame.width
    const contentHeight = frame.height - TITLE_BAR
    const screenX = Math.round(frame.x + (x / pixelWidth) * contentWidth)
    const screenY = Math.round(frame.y + TITLE_BAR + (y / pixelHeight) * contentHeight)
    await runDevice(cliclick, [`c:${screenX},${screenY}`], { what: `Tapping (${x}, ${y})` })
  }
}
