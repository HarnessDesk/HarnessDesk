import assert from 'node:assert/strict'
import { test } from 'node:test'

import { androidPlugin } from '../src/android.js'

/**
 * #42 at the tool surface. The service puts a serial where adb reads it;
 * what is pinned here is that every tool hands the service the serial it was
 * given — and that the screenshot a tool answers with is of the device it
 * just acted on, not of whichever one adb would pick.
 */
interface Tool {
  readonly name: string
  readonly execute: (args: unknown) => Promise<unknown>
  readonly inputSchema: { readonly properties: Record<string, unknown> }
}

const withAndroid = () => {
  const calls: unknown[][] = []
  const record =
    (verb: string, answer?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([verb, ...args])
      return answer
    }
  const android = {
    devices: record('devices', []),
    install: record('install'),
    launch: record('launch'),
    screenshot: record('screenshot', 'data:image/png;base64,AAAA'),
    tap: record('tap'),
    key: record('key'),
    text: record('text'),
    logcat: record('logcat', 'I/Tag: hello'),
  }
  const tools = new Map<string, Tool>()
  androidPlugin.plugin.apply({ tools: { register: (tool: Tool) => tools.set(tool.name, tool) }, android } as never)
  const run = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args)
  return { tools, calls, run }
}

test('every tool that acts on a device takes a serial', () => {
  const { tools } = withAndroid()
  const acting = [...tools.keys()].filter((name) => name !== 'android_devices')
  assert.equal(acting.length, 7)
  for (const name of acting) assert.ok(tools.get(name)!.inputSchema.properties['serial'], `${name} takes a serial`)
})

test('the serial reaches the device, and the screenshot after is of that device', async () => {
  const { calls, run } = withAndroid()
  const on = 'emulator-5556'
  await run('android_install', { path: '/tmp/app.apk', serial: on })
  await run('android_launch', { target: 'com.example', serial: on })
  await run('android_screenshot', { serial: on })
  await run('android_tap', { x: 3, y: 4, serial: on })
  await run('android_key', { key: 'BACK', serial: on })
  await run('android_text', { text: 'hi', serial: on })
  await run('android_logcat', { lines: 5, tag: 'MyTag', serial: on })
  assert.deepEqual(calls, [
    ['install', '/tmp/app.apk', on],
    ['launch', 'com.example', on],
    ['screenshot', on],
    ['screenshot', on],
    ['tap', 3, 4, on],
    ['screenshot', on],
    ['key', 'BACK', on],
    ['screenshot', on],
    ['text', 'hi', on],
    ['screenshot', on],
    ['logcat', 5, 'MyTag', on],
  ])
})

test('a serial that is blank or missing names no device, and one with space around it is trimmed', async () => {
  const { calls, run } = withAndroid()
  await run('android_install', { path: '/tmp/app.apk', serial: '   ' })
  await run('android_screenshot', {})
  await run('android_logcat', { serial: '' })
  await run('android_screenshot', { serial: ' emulator-5556\n' })
  assert.deepEqual(calls, [
    ['install', '/tmp/app.apk', undefined],
    ['screenshot', undefined],
    ['logcat', 100, undefined, undefined],
    ['screenshot', 'emulator-5556'],
  ])
})
