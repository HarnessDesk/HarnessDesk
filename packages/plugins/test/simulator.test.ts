import assert from 'node:assert/strict'
import test from 'node:test'
import { simulatorPlugin } from '../src/simulator.js'

const pngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=='

interface Tool { name: string; inputSchema: { properties: Record<string, unknown> }; execute(args: Record<string, unknown>): Promise<unknown> }
const fixture = () => {
  const calls: unknown[][] = []
  const record = (name: string, result?: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return result }
  const ios = {
    booted: record('booted', { udid: 'B', name: 'iPhone B', runtime: 'iOS-27' }), screenshot: record('screenshot', pngUrl), boot: record('boot'), install: record('install'), launch: record('launch'), terminate: record('terminate'), tap: record('tap'), openUrl: record('openUrl'),
    frame: record('frame', { udid: 'B', width: 1, height: 1, frameId: 'frame-B', url: pngUrl, mimeType: 'image/png' }),
    diagnose: record('diagnose', { available: true, code: 'ready', message: 'iOS Simulator is ready.' }),
    getAppearance: record('getAppearance', 'light'), setAppearance: record('setAppearance', 'light'),
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
  assert.match(JSON.stringify(result), /light/)
  assert.doesNotMatch(JSON.stringify(result), /set to dark/i)
  assert.deepEqual(calls, [['booted', 'B'], ['setAppearance', 'dark', 'B']])
})

test('diagnosis and appearance reads use only the iOS capability', async () => {
  const { calls, run } = fixture()
  assert.deepEqual(simulatorPlugin.manifest.permissions, { ios: true })
  assert.match(JSON.stringify(await run('ios_diagnose')), /ready/)
  assert.equal(await run('ios_get_appearance', { udid: 'B' }), 'light')
  assert.deepEqual(calls, [['diagnose'], ['booted', 'B'], ['getAppearance', 'B']])
})
