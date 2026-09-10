import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Service, type Context } from '@deepseek-ai/cordis'

import type { HostRuntime } from './runtime.js'
import { runDevice, runDeviceForPng } from './device-exec.js'

/**
 * `ctx.android` — Android devices and emulators, through `adb`.
 *
 * adb is the rare device CLI that needs no workarounds: install, launch,
 * screenshot, tap, key events and text input are all first-class verbs.
 * Screenshots come from `exec-out screencap -p` as raw PNG; `tap` takes the
 * pixels of that screenshot, because Android screencap pixels ARE the input
 * coordinate space — the cleanest see-then-act loop of the three engines.
 *
 * Gated by the manifest permission `android: true`. A machine without adb
 * gets a sentence naming the install, not a stack trace.
 */

const ADB_CANDIDATES = [
  'adb',
  join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
  '/usr/local/bin/adb',
  '/opt/homebrew/bin/adb',
]

const adbBinary = (): string => {
  const explicit = process.env['HARNESSDESK_ADB']
  if (explicit) return explicit
  for (const candidate of ADB_CANDIDATES) {
    if (candidate === 'adb' || existsSync(candidate)) return candidate
  }
  return 'adb'
}

const missingAdb = (error: Error): Error =>
  /ENOENT/.test(error.message)
    ? new Error(
        'adb was not found. Install Android platform-tools (brew install --cask android-platform-tools) or set HARNESSDESK_ADB to its path.',
      )
    : error

/**
 * One argument, safe for the shell **on the device**.
 *
 * `adb shell a b c` does not pass three arguments: it joins them and hands
 * the line to the device's own shell, which then parses it. So every value a
 * caller supplies is shell source over there, and `;`, `&`, `|`, `$`, a
 * backtick or a parenthesis in it runs whatever follows — on the phone. An
 * agent driving the device is the caller, and a page it read is where the
 * text often comes from.
 *
 * Single quotes, because inside them the device shell expands nothing at all.
 * The one character that cannot appear inside single quotes is a single
 * quote, which is closed, escaped, and reopened — the standard `'\''`.
 *
 * Applied at every call site rather than the one that was reported: `text`
 * was found, and `launch` and `key` are the same door. `tap` is not on this
 * list because its arguments are numbers this file rounds itself.
 */
export const deviceArg = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

export interface AndroidDevice {
  readonly serial: string
  readonly state: string
  readonly description: string
}

/**
 * The devices in `adb devices -l`, and nothing adb says about itself.
 *
 * Everything up to *and including* adb's own header is dropped, not only the
 * first line. When adb has to start its daemon on demand it prints
 * `* daemon not running; starting now at tcp:5037` and
 * `* daemon started successfully` **above** `List of devices attached`, and a
 * one-line slice turned both into devices — serial `*`, state `daemon` — and
 * then the header itself into one more, serial `List`. A line opening with `*`
 * is adb talking about itself wherever it appears, so it is never a device.
 * Without a header at all, every other line is still read, so an adb that
 * someday words its header differently lists devices rather than none. #43.
 */
/** `-s <serial>` ahead of the subcommand when a device was named; nothing when not. */
const onDevice = (serial: string | undefined): string[] => (serial ? ['-s', serial] : [])

export const parseAdbDevices = (stdout: string): AndroidDevice[] => {
  const lines = stdout.split('\n').map((line) => line.trim())
  const header = lines.findIndex((line) => line.startsWith('List of devices attached'))
  return lines
    .slice(header + 1)
    .filter((line) => line.length > 0 && !line.startsWith('*'))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/)
      return { serial: serial ?? '', state: state ?? '', description: rest.join(' ') }
    })
}

export class AndroidService extends Service {
  static [Service.tracker] = { associate: 'android', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'android')
  }

  private async adb(args: readonly string[], what: string, timeoutMs?: number, serial?: string): Promise<string> {
    this.runtime.owner(this.ctx).gate.assertAndroid()
    try {
      const { stdout } = await runDevice(adbBinary(), [...onDevice(serial), ...args], {
        what,
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      return stdout
    } catch (error) {
      throw await this.refusal(error as Error, serial)
    }
  }

  /**
   * adb's refusal, in words a caller can act on.
   *
   * With more than one device or emulator attached, adb refuses every
   * command that does not name one — `error: more than one device/emulator`
   * — and nothing here could name one, so a second emulator broke every
   * Android tool at once (#42). Named now, each command takes the serial
   * `android_devices` lists; not named, adb and `ANDROID_SERIAL` decide
   * exactly as before, which costs nothing while one device is attached. Only
   * the refusal is new, and it lists the devices to choose from.
   *
   * The listing goes to adb directly rather than through `adb()`, so a
   * refusal can never lead back into itself.
   */
  private async refusal(error: Error, serial: string | undefined): Promise<Error> {
    if (serial !== undefined || !/more than one (device|emulator)/i.test(error.message)) return missingAdb(error)
    const ready = await runDevice(adbBinary(), ['devices', '-l'], { what: 'Listing Android devices' }).then(
      ({ stdout }) => parseAdbDevices(stdout).filter((device) => device.state === 'device'),
      () => [],
    )
    const which = ready.length > 0 ? ` (${ready.map((device) => device.serial).join(', ')})` : ''
    return new Error(
      `More than one Android device or emulator is connected${which}. Name one with \`serial\`, or set ANDROID_SERIAL for the desk.`,
    )
  }

  /** Connected devices and running emulators, from `adb devices -l`. */
  async devices(): Promise<readonly AndroidDevice[]> {
    return parseAdbDevices(await this.adb(['devices', '-l'], 'Listing Android devices'))
  }

  async install(apkPath: string, serial?: string): Promise<void> {
    await this.adb(['install', '-r', apkPath], `Installing ${apkPath}`, 180_000, serial)
  }

  /** Launches an activity (`com.example/.MainActivity`) or a package's default. */
  async launch(target: string, serial?: string): Promise<void> {
    if (target.includes('/')) {
      await this.adb(['shell', 'am', 'start', '-n', deviceArg(target)], `Launching ${target}`, 60_000, serial)
    } else {
      await this.adb(
        ['shell', 'monkey', '-p', deviceArg(target), '-c', 'android.intent.category.LAUNCHER', '1'],
        `Launching ${target}`,
        60_000,
        serial,
      )
    }
  }

  /** A PNG of the device screen, as a data URL. Pixels are tap coordinates. */
  async screenshot(serial?: string): Promise<string> {
    this.runtime.owner(this.ctx).gate.assertAndroid()
    try {
      return await runDeviceForPng(adbBinary(), [...onDevice(serial), 'exec-out', 'screencap', '-p'], {
        what: 'Screenshotting the device',
      })
    } catch (error) {
      throw await this.refusal(error as Error, serial)
    }
  }

  async tap(x: number, y: number, serial?: string): Promise<void> {
    await this.adb(
      ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))],
      `Tapping (${x}, ${y})`,
      undefined,
      serial,
    )
  }

  /** `KEYCODE_*` names or bare names like ENTER, BACK, HOME. */
  async key(key: string, serial?: string): Promise<void> {
    const code = key.startsWith('KEYCODE_') ? key : `KEYCODE_${key.toUpperCase()}`
    await this.adb(['shell', 'input', 'keyevent', deviceArg(code)], `Pressing ${key}`, undefined, serial)
  }

  async text(text: string, serial?: string): Promise<void> {
    // `input text` treats %s as space and chokes on raw spaces.
    await this.adb(['shell', 'input', 'text', deviceArg(text.replaceAll(' ', '%s'))], 'Typing', undefined, serial)
  }

  /** The last `lines` of logcat, optionally filtered to a tag. */
  async logcat(lines = 100, tag?: string, serial?: string): Promise<string> {
    const args = ['logcat', '-d', '-t', String(Math.min(lines, 1000))]
    // logcat's own `-s` — a tag filter, after `logcat`. The device's `-s` is
    // adb's, and goes before the subcommand; the two never meet.
    if (tag) args.push('-s', tag)
    return this.adb(args, 'Reading logcat', 30_000, serial)
  }
}
