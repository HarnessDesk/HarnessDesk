import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionKernel, type IosCapability } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'
import type { ToolResult } from '@harnessdesk/protocol'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const REFUSAL = 'Simulator access for installed plugins needs every enabled installed plugin to hold the iOS permission, because installed plugins share one process.'

async function setup(t: TestContext, granted: boolean, options: { disableBeforeLoad?: boolean; passive?: boolean } = {}) {
  const scratch = fileURLToPath(new URL('../../../../output/ios-input/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'cohabitation-')), store = join(dir, 'plugins')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(join(FIXTURES, options.passive ? 'plugin-ios-passive' : 'plugin-ios'), join(store, 'iosish'), { recursive: true })
  await cp(join(FIXTURES, 'plugin-ios-resident'), join(store, 'resident'), { recursive: true })
  const source = join(store, 'iosish', 'index.js')
  await writeFile(source, (await readFile(source, 'utf8')).replace('apply(ctx) {', `apply(ctx) {
    ctx.tools.register({name:'ios_owner',description:'Synthetic live invocation.',inputSchema:{type:'object',properties:{}},execute:async()=>JSON.stringify(await ctx.ios.devices())})`))
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
  return { host, store, grant, invoke, probe, calls: () => calls, hold: () => { pause = true; return invoke('ios_owner', { iosOwner: true }) }, started, release: () => release() }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await readFile(path).then(() => true, () => false)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('The synthetic resident did not reach its startup barrier.')
}

test('mixed installed grants issue no token and refuse raw simulator frames', async t => {
  const f = await setup(t, false)
  const result = await f.invoke('ios_owner', { iosOwner: true })
  assert.deepEqual(result, { ok: false, error: REFUSAL })
  assert.deepEqual(await f.probe(), { observedToken: false, error: REFUSAL })
  assert.equal(f.calls(), 0)
})

test('disabling a resident before it loads does not exempt its enabled instance', async t => {
  const f = await setup(t, false, { disableBeforeLoad: true })
  assert.equal(f.host.plugins().find(plugin => plugin.identity.id === 'resident')!.enabled, true)
  assert.deepEqual(await f.invoke('ios_owner', { iosOwner: true }), { ok: false, error: REFUSAL })
  assert.deepEqual(await f.probe(), { observedToken: false, error: REFUSAL })
  assert.equal(f.calls(), 0)
})

function toolText(result: ToolResult): string {
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error('The synthetic tool did not execute.')
  const content = result.content[0]!
  assert.equal(content.type, 'text')
  return (content as { text: string }).text
}

async function assertRefusedWithoutBearer(f: Awaited<ReturnType<typeof setup>>, method: string) {
  assert.deepEqual(await f.probe(), { observedToken: false, error: REFUSAL })
  const history = JSON.parse(await readFile(join(f.store, 'resident', 'authority-history.json'), 'utf8')) as { method: string; values: unknown[] }[]
  assert.ok(history.some(entry => entry.method === method && entry.values.length > 0), 'The invocation must reach the child with an owner-specific refusal marker.')
  for (const entry of history) for (const value of entry.values) assert.deepEqual(value, { refused: REFUSAL }, 'No invocation may expose an iOS bearer while shared consent is missing.')
  assert.equal(f.calls(), 0)
}

test('mixed grants preserve all installed hooks while withholding iOS authority', async t => {
  const f = await setup(t, false, { passive: true })
  assert.deepEqual(await f.host.runHooks({ event: 'preTurn', scope: {} }), { decision: 'allow' })
  assert.equal(JSON.parse(toolText(await f.invoke('owner_safe'))).hooks, 1)
  assert.equal(JSON.parse(toolText(await f.invoke('resident_safe'))).hooks, 1)
  await assertRefusedWithoutBearer(f, 'hooks/run')
})

test('mixed grants preserve context from both installed plugins', async t => {
  const f = await setup(t, false, { passive: true })
  assert.deepEqual(await f.host.resolveContext({}), [
    { label: 'Owner context', text: 'owner context ran' },
    { label: 'Resident context', text: 'resident context ran' },
  ])
  await assertRefusedWithoutBearer(f, 'context/resolve')
})

test('mixed grants preserve an iOS-declaring tool that does not use iOS', async t => {
  const f = await setup(t, false, { passive: true })
  assert.deepEqual(JSON.parse(toolText(await f.invoke('owner_safe'))), { hooks: 0, commands: 0 })
  await assertRefusedWithoutBearer(f, 'tool/invoke')
})

test('mixed grants refuse ctx.ios inside the dispatched invocation with the cohabitation reason', async t => {
  const f = await setup(t, false, { passive: true })
  assert.equal(toolText(await f.invoke('owner_ios_caught')), REFUSAL)
  await assertRefusedWithoutBearer(f, 'tool/invoke')
})

test('mixed grants preserve an iOS-declaring command that does not use iOS', async t => {
  const f = await setup(t, false, { passive: true })
  assert.equal(await f.host.runCommand('owner_command', '', {}), true)
  assert.equal(JSON.parse(toolText(await f.invoke('owner_safe'))).commands, 1)
  await assertRefusedWithoutBearer(f, 'command/run')
})

test('non-plugin directories do not block installed simulator authority', async t => {
  const f = await setup(t, true)
  await mkdir(join(f.store, 'leftover'))
  const malformed = join(f.store, 'malformed')
  await mkdir(malformed)
  await writeFile(join(malformed, 'harnessdesk.plugin.json'), '{')
  assert.equal((await f.invoke('ios_owner', { iosOwner: true })).ok, true)
  assert.equal(f.calls(), 1)
  await f.grant(false)
  assert.deepEqual(await f.invoke('ios_owner', { iosOwner: true }), { ok: false, error: REFUSAL })
  assert.equal(f.calls(), 1)
})

test('both granted residents work until a stored resident grant is revoked', async t => {
  const f = await setup(t, true)
  const running = f.hold()
  try {
    await f.started
    assert.deepEqual(await f.probe(), { observedToken: true, result: [] })
    assert.equal(f.calls(), 2)
    await f.grant(false)
    assert.deepEqual(await f.probe(), { observedToken: true, error: REFUSAL })
    assert.equal(f.calls(), 2)
  } finally { f.release(); await running }
})

test('enabling an ungranted resident rejects a previously issued live token', async t => {
  const f = await setup(t, false)
  await f.host.setEnabled('resident', false)
  const running = f.hold()
  try {
    await f.started
    await f.host.setEnabled('resident', true)
    assert.deepEqual(await f.probe(), { observedToken: true, error: REFUSAL })
    assert.equal(f.calls(), 1)
  } finally { f.release(); await running }
})

test('enabling a resident blocks forwarding before its first enabled snapshot', async t => {
  const f = await setup(t, false)
  await f.host.setEnabled('resident', false)
  const running = f.hold()
  let enabling: Promise<void> | undefined
  const pause = join(f.store, 'resident', 'pause-apply')
  try {
    await f.started
    await writeFile(pause, 'pause')
    enabling = f.host.setEnabled('resident', true)
    await waitForFile(join(f.store, 'resident', 'apply-started'))
    assert.deepEqual(await f.probe(), { observedToken: true, error: REFUSAL })
    assert.equal(f.calls(), 1)
  } finally { await rm(pause, { force: true }); await enabling; f.release(); await running }
})

test('loading an ungranted resident blocks forwarding before its first snapshot', async t => {
  const f = await setup(t, true)
  const running = f.hold()
  const plugin = join(f.store, 'new-resident'), pause = join(plugin, 'pause-apply')
  let loading: Promise<void> | undefined
  try {
    await f.started
    await cp(join(FIXTURES, 'plugin-ios-resident'), plugin, { recursive: true })
    const path = join(plugin, 'harnessdesk.plugin.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.id = 'new-resident'
    await writeFile(path, JSON.stringify(manifest))
    await writeFile(join(plugin, 'index.js'), `import {readFile,writeFile} from 'node:fs/promises'
      export const plugin={name:'new-resident',async apply(){
        await writeFile(new URL('./apply-started',import.meta.url),'ready')
        while(await readFile(new URL('./pause-apply',import.meta.url)).then(()=>true,()=>false)) await new Promise(resolve=>setTimeout(resolve,10))
      }}`)
    await writeFile(pause, 'pause')
    loading = f.host.loadInstalledPlugins()
    await waitForFile(join(plugin, 'apply-started'))
    assert.deepEqual(await f.probe(), { observedToken: true, error: REFUSAL })
    assert.equal(f.calls(), 1)
  } finally { await rm(pause, { force: true }); await loading; f.release(); await running }
})

test('a child snapshot cannot hide an enabled ungranted resident', async t => {
  const f = await setup(t, true)
  const running = f.hold()
  try {
    await f.started
    await f.grant(false)
    const plugins = f.host.plugins().map(plugin => ({ ...plugin, enabled: plugin.identity.id === 'resident' ? false : plugin.enabled,
      contributions: plugin.contributions.map(entry => ({ ...entry, id: String(entry.id).replace(/^child:/, '') })) }))
    const snapshot = { kind: 'snapshot', plugins, contributions: plugins.flatMap(plugin => plugin.contributions) }
    assert.deepEqual(await f.probe(snapshot), { observedToken: true, error: REFUSAL })
    assert.equal(f.calls(), 1)
  } finally { f.release(); await running }
})

test('an announced resident stays in the census if its manifest and snapshot disappear', async t => {
  const f = await setup(t, true)
  const running = f.hold()
  try {
    await f.started
    const plugin = join(f.store, 'new-resident')
    await cp(join(FIXTURES, 'plugin-ios-resident'), plugin, { recursive: true })
    const path = join(plugin, 'harnessdesk.plugin.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.id = 'new-resident'
    await writeFile(path, JSON.stringify(manifest))
    await writeFile(join(plugin, 'index.js'), "export const plugin={name:'new-resident',apply(){}}")
    await f.host.loadInstalledPlugins()
    assert.ok(f.host.plugins().some(resident => resident.identity.id === 'new-resident'))
    await rm(path)
    const plugins = f.host.plugins().filter(resident => resident.identity.id !== 'new-resident').map(resident => ({ ...resident,
      contributions: resident.contributions.map(entry => ({ ...entry, id: String(entry.id).replace(/^child:/, '') })) }))
    assert.deepEqual(await f.probe({ kind: 'snapshot', plugins, contributions: plugins.flatMap(resident => resident.contributions) }), { observedToken: true, error: REFUSAL })
    assert.equal(f.calls(), 1)
  } finally { f.release(); await running }
})

test('built-in simulator calls remain available alongside ungranted installed residents', async t => {
  const f = await setup(t, false)
  await f.host.loadBuiltin({ manifest: { id: 'builtin-ios', name: 'Synthetic built-in', permissions: { ios: true } }, plugin: {
    name: 'builtin-ios', inject: ['tools', 'ios'], apply(ctx: any) {
      ctx.tools.register({ name: 'builtin_ios', description: 'Synthetic built-in simulator control.', inputSchema: { type: 'object', properties: {} }, execute: async () => JSON.stringify(await ctx.ios.devices()) })
    },
  } })
  assert.equal((await f.invoke('builtin_ios')).ok, true)
  assert.equal(f.calls(), 1)
  assert.deepEqual(await f.invoke('ios_owner', { iosOwner: true }), { ok: false, error: REFUSAL })
  assert.equal(f.calls(), 1)
})
