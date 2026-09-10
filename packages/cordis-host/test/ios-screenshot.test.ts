import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { ExtensionKernel, type HarnessPlugin } from '../src/index.js'

/**
 * #46: every simulator screenshot left an `hd-sim-` directory behind. An
 * `xcrun` on PATH that answers the two calls a screenshot makes stands in for
 * the simulator, and TMPDIR points at a directory the test can count.
 *
 * `/bin/sh` runs the fake, so the test skips where there is none, like the
 * adb ones.
 */
const SH = '/bin/sh'
const posixShell = existsSync(SH)

const fakeXcrun = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'hd-xcrun-'))
  const scratch = mkdtempSync(join(tmpdir(), 'hd-xcrun-tmp-'))
  const listing = join(dir, 'devices.json')
  writeFileSync(
    listing,
    JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'FAKE-UDID', name: 'iPhone Test', state: 'Booted', isAvailable: true },
        ],
      },
    }),
  )
  writeFileSync(
    join(dir, 'xcrun'),
    [
      `#!${SH}`,
      `if [ "$1 $2" = 'simctl list' ]; then cat '${listing}'; exit 0; fi`,
      `if [ "$1 $2" = 'simctl io' ] && [ "$4" = screenshot ]; then printf PNG > "$5"; exit 0; fi`,
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(join(dir, 'xcrun'), 0o755)
  const previous = { PATH: process.env['PATH'], TMPDIR: process.env['TMPDIR'] }
  process.env['PATH'] = `${dir}${delimiter}${previous.PATH ?? ''}`
  process.env['TMPDIR'] = scratch
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  })
  return { left: (): string[] => readdirSync(scratch).filter((name) => name.startsWith('hd-sim-')) }
}

const driver: HarnessPlugin = {
  manifest: { id: 'ios-driver', name: 'iOS driver', permissions: { ios: true } },
  plugin: {
    name: 'ios-driver',
    inject: ['tools', 'ios'],
    apply(ctx: any) {
      ctx.tools.register({
        name: 'ios_shot',
        description: 'Takes one simulator screenshot.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => JSON.stringify({ shot: await ctx.ios.screenshot() }),
      })
    },
  },
}

test('a simulator screenshot leaves nothing behind in the temporary directory', { skip: !posixShell }, async (t) => {
  const xcrun = fakeXcrun(t)
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(driver)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const tool = kernel.list('tool').find((entry) => entry.name === 'ios_shot')!
  for (let i = 0; i < 2; i += 1) {
    const result = await kernel.invokeTool(tool.id, {}, {})
    assert.equal(result.ok, true, JSON.stringify(result))
    const text = result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
    const { shot } = JSON.parse(text) as { shot: string }
    assert.equal(shot, `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`, 'the control: a screenshot was taken')
  }
  assert.deepEqual(xcrun.left(), [])
})
