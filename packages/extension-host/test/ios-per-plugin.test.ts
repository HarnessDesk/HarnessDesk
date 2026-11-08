import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionKernel, type IosCapability } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'
import type { ToolResult } from '@harnessdesk/protocol'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const REFUSAL = 'This plugin has no simulator access: it was not granted when the plugin was installed, or its manifest has changed since.'

async function setup(t: TestContext, granted: boolean, options: { disableBeforeLoad?: boolean; passive?: boolean } = {}) {
  const scratch = fileURLToPath(new URL('../../../../output/ios-input/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'per-plugin-')), store = join(dir, 'plugins')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(join(FIXTURES, options.passive ? 'plugin-ios-passive' : 'plugin-ios'), join(store, 'iosish'), { recursive: true })
  await cp(join(FIXTURES, 'plugin-ios-resident'), join(store, 'resident'), { recursive: true })
  const source = join(store, 'iosish', 'index.js')
  await writeFile(source, (await readFile(source, 'utf8')).replace('apply(ctx) {', `apply(ctx) {
    ctx.tools.register({name:'ios_owner',description:'Synthetic live invocation.',inputSchema:{type:'object',properties:{}},execute:async()=>JSON.stringify(await ctx.ios.devices())})
    ctx.tools.register({name:'ios_twice',description:'Two simulator requests in one invocation.',inputSchema:{type:'object',properties:{}},execute:async()=>{await ctx.ios.devices();return JSON.stringify(await ctx.ios.devices())}})`))
  const manifestPath = join(store, 'resident', 'harnessdesk.plugin.json')
  const grant = async (value: boolean) => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.permissions.ios = value
    await writeFile(manifestPath, JSON.stringify(manifest))
  }
  await grant(granted)
  let calls = 0, release = () => {}, entered = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  let pause = false
  const engine = { devices: async () => {
    calls++
    if (pause && calls === 1) { entered(); await new Promise<void>(resolve => { release = resolve }) }
    return []
  } } as unknown as IosCapability
  const kernel = new ExtensionKernel({ iosEngine: engine })
  const host = new SupervisedExtensionHost(kernel, { env: { HARNESSDESK_PLUGINS: store }, iosEngine: engine })
  t.after(async () => { release(); await host.dispose() })
  if (options.disableBeforeLoad) await host.setEnabled('resident', false)
  await host.loadInstalledPlugins()
  const invoke = (name: string, args = {}) => host.invokeTool(host.list('tool').find(tool => tool.name === name)!.id, args, {})
  const probe = async (snapshot?: unknown): Promise<{ observedToken: boolean; error?: string; result?: unknown }> => {
    const path = join(store, 'resident', 'probe-result.json')
    await rm(path, { force: true })
    if (snapshot) await writeFile(join(store, 'resident', 'snapshot.json'), JSON.stringify(snapshot))
    await host.stats()
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = await readFile(path, 'utf8').catch(() => '')
      if (text) return JSON.parse(text)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('The synthetic resident did not receive a simulator reply.')
  }
  return { host, store, grant, invoke, probe, calls: () => calls, hold: (name = 'ios_owner') => { pause = true; return invoke(name, { iosOwner: true }) }, started, release: () => release() }
}

function toolText(result: ToolResult): string {
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error('The synthetic tool did not execute.')
  const content = result.content[0]!
  assert.equal(content.type, 'text')
  return (content as { text: string }).text
}

async function residentHistory(f: Awaited<ReturnType<typeof setup>>) {
  return JSON.parse(await readFile(join(f.store, 'resident', 'authority-history.json'), 'utf8')) as { method: string; values: unknown[] }[]
}

// Each installed plugin runs in a process of its own (docs/plugin-isolation.md),
// so simulator authority is one plugin's consented grant: a neighbour neither
// widens nor blocks it, and nothing a process says about itself changes it.

test('an ungranted plugin installed beside a granted one does not block it', async t => {
  const f = await setup(t, false)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  assert.equal(f.calls(), 1)
})

test('an ungranted plugin never sees a simulator token and its raw frames are refused', async t => {
  const f = await setup(t, false)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  assert.equal(JSON.parse(toolText(await f.invoke('resident_safe'))).hooks, 0)
  assert.deepEqual(await f.probe(), { observedToken: false, error: REFUSAL })
  for (const entry of await residentHistory(f)) assert.deepEqual(entry.values, [], `${entry.method} carried simulator authority into a process that holds none`)
  assert.equal(f.calls(), 1)
})

test('a plugin that grants itself simulator access after installation gets none', async t => {
  const f = await setup(t, false)
  await f.grant(true)
  assert.deepEqual(await f.probe(), { observedToken: false, error: REFUSAL })
  assert.equal(f.calls(), 0)
})

test('a granted plugin keeps its grant when its neighbour is enabled or disabled', async t => {
  const f = await setup(t, false)
  await f.host.setEnabled('resident', false)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  await f.host.setEnabled('resident', true)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  assert.equal(f.calls(), 2)
})

test('a granted plugin reaches the simulator from its hooks, commands and context', async t => {
  const f = await setup(t, false)
  assert.deepEqual(await f.host.runHooks({ event: 'preTurn', scope: {} }), { decision: 'allow' })
  assert.equal(f.calls(), 1)
  assert.equal(await f.host.runCommand('ios_command', '', {}), true)
  assert.equal(f.calls(), 2)
  const context = await f.host.resolveContext({})
  assert.ok(context.some(entry => entry.label === 'Synthetic iOS context' && entry.text === '[]'), JSON.stringify(context))
  assert.equal(f.calls(), 3)
})

test('hooks, tools and context run in both plugins whatever their grants', async t => {
  const f = await setup(t, false, { passive: true })
  assert.deepEqual(await f.host.runHooks({ event: 'preTurn', scope: {} }), { decision: 'allow' })
  assert.equal(JSON.parse(toolText(await f.invoke('owner_safe'))).hooks, 1)
  assert.equal(JSON.parse(toolText(await f.invoke('resident_safe'))).hooks, 1)
  assert.deepEqual(await f.host.resolveContext({}), [
    { label: 'Owner context', text: 'owner context ran' },
    { label: 'Resident context', text: 'resident context ran' },
  ])
  assert.equal(f.calls(), 0)
})

test('built-in simulator calls and a granted installed plugin both work beside an ungranted one', async t => {
  const f = await setup(t, false)
  await f.host.loadBuiltin({ manifest: { id: 'builtin-ios', name: 'Synthetic built-in', permissions: { ios: true } }, plugin: {
    name: 'builtin-ios', inject: ['tools', 'ios'], apply(ctx: any) {
      ctx.tools.register({ name: 'builtin_ios', description: 'Synthetic built-in simulator control.', inputSchema: { type: 'object', properties: {} }, execute: async () => JSON.stringify(await ctx.ios.devices()) })
    },
  } })
  assert.equal((await f.invoke('builtin_ios')).ok, true)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  assert.equal(f.calls(), 2)
})

test('a granted plugin whose manifest changes while it runs loses simulator access at once', async t => {
  const f = await setup(t, false)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  const path = join(f.store, 'iosish', 'harnessdesk.plugin.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...manifest, version: '9.9.9' }))
  assert.deepEqual(await f.invoke('ios_owner', { iosOwner: true }), { ok: false, error: REFUSAL })
  assert.equal(f.calls(), 1)
})

test('a granted plugin with no consent record on file is given no simulator access', async t => {
  const f = await setup(t, false)
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  await writeFile(join(dirname(f.store), 'plugin-consent.json'), '{}')
  assert.deepEqual(await f.invoke('ios_owner', { iosOwner: true }), { ok: false, error: REFUSAL })
  assert.equal(f.calls(), 1)
})

test('a changed manifest refuses the next simulator request inside a live invocation', async t => {
  const f = await setup(t, false)
  const running = f.hold('ios_twice')
  try {
    await f.started
    const path = join(f.store, 'iosish', 'harnessdesk.plugin.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...manifest, version: '9.9.9' }))
  } finally { f.release() }
  assert.deepEqual(await running, { ok: false, error: REFUSAL })
  assert.equal(f.calls(), 1, 'the second request never reached the engine')
})
