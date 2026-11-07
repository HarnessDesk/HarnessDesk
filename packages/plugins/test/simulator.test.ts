import assert from 'node:assert/strict'
import test from 'node:test'
import { simulatorPlugin } from '../src/simulator.js'

const pngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='

interface Tool { name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean }; execute(args: Record<string, unknown>): Promise<unknown> }
const fixture = (appearance = 'light') => {
  const calls: unknown[][] = []
  const record = (name: string, result?: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return result }
  const ios = {
    booted: record('booted', { udid: 'B', name: 'iPhone B', runtime: 'iOS-27' }), screenshot: record('screenshot', pngUrl), boot: record('boot'), install: record('install'), launch: record('launch'), terminate: record('terminate'), tap: record('tap'), openUrl: record('openUrl'),
    frame: record('frame', { udid: 'B', width: 1, height: 1, frameId: 'frame-B', url: pngUrl, mimeType: 'image/png' }),
    diagnose: record('diagnose', { available: true, code: 'ready', message: 'iOS Simulator is ready.' }),
    getAppearance: record('getAppearance', 'light'), setAppearance: record('setAppearance', appearance),
  }
  const tools = new Map<string, Tool>()
  simulatorPlugin.plugin.apply({ tools: { register: (tool: Tool) => tools.set(tool.name, tool) }, ios } as never)
  return { calls, tools, run: (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(args) }
}

test('explicit target is used by action and screenshot at the tool surface', async () => {
  const { calls, run, tools } = fixture()
  await run('ios_launch', { bundleId: 'com.example.App', udid: 'B' })
  assert.deepEqual(calls, [['booted', 'B'], ['launch', 'com.example.App', 'B'], ['frame', 'B']])
  for (const [name, tool] of tools) if (!['ios_devices', 'ios_diagnose'].includes(name)) assert.ok(tool.inputSchema.properties['udid'], name)
})

test('boot options and structured screenshot metadata reach the tool result', async () => {
  const { calls, run } = fixture()
  const result = await run('ios_boot', { udid: 'B', openWindow: false })
  assert.deepEqual(calls, [['boot', 'B', { openWindow: false }], ['frame', 'B']])
  assert.match(JSON.stringify(result), /B.*1.*1.*frame-B/)
})

test('invalid appearance is rejected', async () => {
  const { calls, run } = fixture()
  await assert.rejects(run('ios_set_appearance', { appearance: 'sepia' }), /appearance.*light.*dark/i)
  assert.deepEqual(calls, [])
})

test('set/readback disagreement is reported', async () => {
  const { calls, run } = fixture()
  const result = await run('ios_set_appearance', { appearance: 'dark', udid: 'B' })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { requested: 'dark', observed: 'light', applied: false })
  assert.deepEqual(calls, [['booted', 'B'], ['setAppearance', 'dark', 'B']])
})

test('diagnosis and appearance reads use only the iOS capability', async () => {
  const { calls, run } = fixture()
  assert.deepEqual(simulatorPlugin.manifest.permissions, { ios: true })
  assert.match(JSON.stringify(await run('ios_diagnose')), /ready/)
  assert.equal(await run('ios_get_appearance', { udid: 'B' }), 'light')
  assert.deepEqual(calls, [['diagnose'], ['booted', 'B'], ['getAppearance', 'B']])
})


test('all udid schemas require a UUID', () => {
  const { tools } = fixture()
  const valid = '00000000-0000-0000-0000-00000000000A'
  for (const [name, tool] of tools) {
    if (['ios_devices', 'ios_diagnose'].includes(name)) continue
    const schema = tool.inputSchema.properties['udid'] as { pattern?: string }
    assert.equal(typeof schema.pattern, 'string', `${name} has a UUID pattern`)
    const pattern = new RegExp(schema.pattern!)
    assert.ok(pattern.test(valid), `${name} accepts a UUID`)
    for (const invalid of ['--help', 'booted', 'iPhone Test', 'B', valid + 'extra', ' ' + valid]) {
      assert.equal(pattern.test(invalid), false, `${name} refuses ${invalid}`)
    }
  }
})

test('bundle-id options are refused before the tool resolves a simulator', async () => {
  const { calls, run } = fixture()
  await assert.rejects(run('ios_launch', { bundleId: '--help' }), /bundle.*begin.*-/i)
  await assert.rejects(run('ios_terminate', { bundleId: '--help' }), /bundle.*begin.*-/i)
  assert.deepEqual(calls, [])
})

test('appearance application status distinguishes matches from unsupported and unknown', async () => {
  for (const observed of ['dark', 'unsupported', 'unknown']) {
    const { run } = fixture(observed)
    const result = await run('ios_set_appearance', { appearance: 'dark', udid: 'B' })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { requested: 'dark', observed, applied: observed === 'dark' })
  }
})

test('ios_devices refuses additional schema properties', () => {
  assert.equal(fixture().tools.get('ios_devices')!.inputSchema.additionalProperties, false)
})
