import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { parseAdbDevices } from '../src/android.js'
import { ExtensionKernel, type HarnessPlugin } from '../src/index.js'

/**
 * #42 and #43 — which device a call reaches, and what counts as one.
 *
 * #43: `adb devices -l` prints lines about adb itself when it has to start
 * its daemon, above its own header, and they were read as devices.
 * #42: with two devices attached adb refuses every command that names
 * neither, and nothing here could name one.
 *
 * The service is driven through a real kernel, against an adb that is a
 * script: it writes down every argument vector it is called with and answers
 * the way adb does for the devices it is told are attached — including
 * adb's own refusal when there are several and none is named. So what is
 * pinned is what reaches adb, in the order adb reads it.
 */

test('adb talking about itself is not a device, above its header or below it', () => {
  const listed = parseAdbDevices(
    [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1',
      '* a line adb prints about itself',
      'R58M123ABC             unauthorized usb:1-1 transport_id:2',
      '',
    ].join('\n'),
  )
  assert.deepEqual(listed, [
    {
      serial: 'emulator-5554',
      state: 'device',
      description: 'product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:1',
    },
    { serial: 'R58M123ABC', state: 'unauthorized', description: 'usb:1-1 transport_id:2' },
  ])
})

test('without a header every line is still read; with nothing attached, nothing is', () => {
  assert.deepEqual(parseAdbDevices('emulator-5554\tdevice\n'), [
    { serial: 'emulator-5554', state: 'device', description: '' },
  ])
  assert.deepEqual(parseAdbDevices('List of devices attached\n\n'), [])
})

/*
 * `/bin/sh` for the fake adb, and the tests that need it skip where there is
 * none — the same stand-in, and the same reason, as `android-arg.test.ts`.
 */
const SH = '/bin/sh'
const posixShell = existsSync(SH)

/** An adb with these `adb devices` lines attached, that writes down how it was called. */
const fakeAdb = (t: TestContext, attached: readonly string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-adb-'))
  const log = join(dir, 'calls.log')
  const listing = join(dir, 'devices.txt')
  const binary = join(dir, 'adb')
  writeFileSync(listing, ['List of devices attached', ...attached, ''].join('\n'))
  writeFileSync(
    binary,
    [
      `#!${SH}`,
      `printf '%s\\n' "$*" >> '${log}'`,
      `if [ "$1" = devices ]; then cat '${listing}'; exit 0; fi`,
      // adb's own rule: with more than one attached, a command naming none is refused.
      `if [ "$1" != -s ] && [ ${attached.length} -gt 1 ]; then echo 'adb: error: more than one device/emulator' >&2; exit 1; fi`,
      `if [ "$1" = -s ] && ! grep -q "^$2[[:space:]]" '${listing}'; then echo "adb: device '$2' not found" >&2; exit 1; fi`,
      `if [ "$1" = -s ]; then shift 2; fi`,
      `if [ "$1" = exec-out ]; then printf PNG; fi`,
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(binary, 0o755)
  const previous = process.env['HARNESSDESK_ADB']
  process.env['HARNESSDESK_ADB'] = binary
  t.after(() => {
    if (previous === undefined) delete process.env['HARNESSDESK_ADB']
    else process.env['HARNESSDESK_ADB'] = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { calls: (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

/** A plugin with the android permission and one tool that calls whichever `ctx.android` method it is asked to. */
const driver: HarnessPlugin = {
  manifest: { id: 'android-driver', name: 'Android driver', permissions: { android: true } },
  plugin: {
    name: 'android-driver',
    inject: ['tools', 'android'],
    apply(ctx: any) {
      ctx.tools.register({
        name: 'android_call',
        description: 'Calls one ctx.android method.',
        inputSchema: { type: 'object', properties: {} },
        execute: async (input: { verb: string; args: unknown[] }) => {
          try {
            return JSON.stringify({ out: await ctx.android[input.verb](...input.args) })
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
    },
  },
}

const withKernel = async (t: TestContext) => {
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(driver)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const tool = kernel.list('tool').find((entry) => entry.name === 'android_call')!
  return async (verb: string, ...args: unknown[]): Promise<{ out?: unknown; error?: string }> => {
    const result = await kernel.invokeTool(tool.id, { verb, args }, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
    return JSON.parse(text) as { out?: unknown; error?: string }
  }
}

test('a named device is named to adb ahead of the subcommand, by every verb', { skip: !posixShell }, async (t) => {
  const adb = fakeAdb(t, ['emulator-5554\tdevice', 'emulator-5556\tdevice'])
  const call = await withKernel(t)
  const on = 'emulator-5556'
  const verbs: [string, ...unknown[]][] = [
    ['install', '/tmp/app.apk', on],
    ['launch', 'com.example', on],
    ['launch', 'com.example/.Main', on],
    ['screenshot', on],
    ['tap', 10, 20, on],
    ['key', 'ENTER', on],
    ['text', 'hi there', on],
    ['logcat', 5, 'MyTag', on],
  ]
  for (const [verb, ...args] of verbs) {
    const { error } = await call(verb, ...args)
    assert.equal(error, undefined, `${verb} was refused`)
  }
  assert.deepEqual(adb.calls(), [
    '-s emulator-5556 install -r /tmp/app.apk',
    "-s emulator-5556 shell monkey -p 'com.example' -c android.intent.category.LAUNCHER 1",
    "-s emulator-5556 shell am start -n 'com.example/.Main'",
    '-s emulator-5556 exec-out screencap -p',
    '-s emulator-5556 shell input tap 10 20',
    "-s emulator-5556 shell input keyevent 'KEYCODE_ENTER'",
    "-s emulator-5556 shell input text 'hi%sthere'",
    // logcat's own `-s` is a tag filter and comes after the subcommand; adb's
    // comes before it. The two never meet.
    '-s emulator-5556 logcat -d -t 5 -s MyTag',
  ])
})

test('with one device attached and none named, the command is what it always was', { skip: !posixShell }, async (t) => {
  const adb = fakeAdb(t, ['emulator-5554\tdevice'])
  const call = await withKernel(t)
  assert.equal((await call('tap', 1, 2)).error, undefined)
  assert.equal((await call('logcat', 5)).error, undefined)
  assert.deepEqual(adb.calls(), ['shell input tap 1 2', 'logcat -d -t 5'])
})

test('with several attached and none named, the refusal lists the ones ready to use', { skip: !posixShell }, async (t) => {
  fakeAdb(t, ['emulator-5554\tdevice', 'emulator-5556\tdevice', 'R58M123ABC\tunauthorized'])
  const call = await withKernel(t)
  const refusal =
    'More than one Android device or emulator is connected (emulator-5554, emulator-5556). ' +
    'Name one with `serial`, or set ANDROID_SERIAL for the desk.'
  assert.equal((await call('tap', 1, 2)).error, refusal)
  // The screenshot reaches adb by a path of its own, and says the same.
  assert.equal((await call('screenshot')).error, refusal)
})

test("a device adb does not know is adb's own refusal, not the one about several", { skip: !posixShell }, async (t) => {
  fakeAdb(t, ['emulator-5554\tdevice', 'emulator-5556\tdevice'])
  const call = await withKernel(t)
  const { error } = await call('tap', 1, 2, 'nope')
  assert.match(error ?? '', /device 'nope' not found/)
  assert.doesNotMatch(error ?? '', /More than one/)
})

test('a blank serial names no device at the service either', { skip: !posixShell }, async (t) => {
  // The tools trimmed it; a plugin calling ctx.android directly did not.
  const adb = fakeAdb(t, ['emulator-5554\tdevice'])
  const call = await withKernel(t)
  assert.equal((await call('tap', 1, 2, '   ')).error, undefined)
  assert.equal((await call('tap', 3, 4, ' emulator-5554 ')).error, undefined)
  assert.deepEqual(adb.calls(), ['shell input tap 1 2', '-s emulator-5554 shell input tap 3 4'])
})

test('with several attached and none ready, the refusal still says how to choose', { skip: !posixShell }, async (t) => {
  fakeAdb(t, ['R58M123ABC\tunauthorized', 'emulator-5556\toffline'])
  const call = await withKernel(t)
  assert.equal(
    (await call('tap', 1, 2)).error,
    'More than one Android device or emulator is connected. Name one with `serial`, or set ANDROID_SERIAL for the desk.',
  )
})

