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

export class AndroidService extends Service {
  static [Service.tracker] = { associate: 'android', property: 'ctx' }

  constructor(
    ctx: Context,
    private readonly runtime: HostRuntime,
  ) {
    super(ctx, 'android')
  }

  private async adb(args: readonly string[], what: string, timeoutMs?: number): Promise<string> {
    this.runtime.owner(this.ctx).gate.assertAndroid()
    try {
      const { stdout } = await runDevice(adbBinary(), args, { what, ...(timeoutMs ? { timeoutMs } : {}) })
      return stdout
    } catch (error) {
      throw missingAdb(error as Error)
    }
  }

  /** Connected devices and running emulators, from `adb devices -l`. */
  async devices(): Promise<readonly { serial: string; state: string; description: string }[]> {
    const stdout = await this.adb(['devices', '-l'], 'Listing Android devices')
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...rest] = line.split(/\s+/)
        return { serial: serial ?? '', state: state ?? '', description: rest.join(' ') }
      })
  }

  async install(apkPath: string): Promise<void> {
    await this.adb(['install', '-r', apkPath], `Installing ${apkPath}`, 180_000)
  }

  /** Launches an activity (`com.example/.MainActivity`) or a package's default. */
  async launch(target: string): Promise<void> {
    if (target.includes('/')) {
      await this.adb(['shell', 'am', 'start', '-n', deviceArg(target)], `Launching ${target}`, 60_000)
    } else {
      await this.adb(
        ['shell', 'monkey', '-p', deviceArg(target), '-c', 'android.intent.category.LAUNCHER', '1'],
        `Launching ${target}`,
        60_000,
      )
    }
  }

  /** A PNG of the device screen, as a data URL. Pixels are tap coordinates. */
  async screenshot(): Promise<string> {
    this.runtime.owner(this.ctx).gate.assertAndroid()
    try {
      return await runDeviceForPng(adbBinary(), ['exec-out', 'screencap', '-p'], {
        what: 'Screenshotting the device',
      })
    } catch (error) {
      throw missingAdb(error as Error)
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], `Tapping (${x}, ${y})`)
  }

  /** `KEYCODE_*` names or bare names like ENTER, BACK, HOME. */
  async key(key: string): Promise<void> {
    const code = key.startsWith('KEYCODE_') ? key : `KEYCODE_${key.toUpperCase()}`
    await this.adb(['shell', 'input', 'keyevent', deviceArg(code)], `Pressing ${key}`)
  }

  async text(text: string): Promise<void> {
    // `input text` treats %s as space and chokes on raw spaces.
    await this.adb(['shell', 'input', 'text', deviceArg(text.replaceAll(' ', '%s'))], 'Typing')
  }

  /** The last `lines` of logcat, optionally filtered to a tag. */
  async logcat(lines = 100, tag?: string): Promise<string> {
    const args = ['logcat', '-d', '-t', String(Math.min(lines, 1000))]
    if (tag) args.push('-s', tag)
    return this.adb(args, 'Reading logcat', 30_000)
  }
}
