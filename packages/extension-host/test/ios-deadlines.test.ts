import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ExtensionKernel, IosEngine, type IosCapability } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function fixture(t: TestContext, engine: IosCapability, finish = () => {}) {
  const scratch = fileURLToPath(new URL('../../../../output/ios-input/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'forward-deadline-')), store = join(dir, 'plugins'), plugin = join(store, 'iosish')
  await cp(join(FIXTURES, 'plugin-ios'), plugin, { recursive: true })
  const source = join(plugin, 'index.js')
  await writeFile(source, (await readFile(source, 'utf8')).replace('apply(ctx) {', `apply(ctx) {
    ctx.tools.register({name:'ios_deadline',description:'Synthetic forwarding deadline.',inputSchema:{type:'object',properties:{}},execute:async args=>{
      if(args.method==='boot') await ctx.ios.boot('11111111-1111-1111-1111-111111111111',{openWindow:false})
      else await ctx.ios.diagnose()
      return 'completed'
    }})`))
  // Scale the shared request clock; leave the outer invocation at one second.
  const options = { env: { HARNESSDESK_PLUGINS: store }, iosEngine: engine, invokeTimeoutMs: 1000, requestTimeoutScale: 0.02 }
  const host = new SupervisedExtensionHost(new ExtensionKernel(), options)
  t.after(async () => { finish(); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  await host.loadInstalledPlugins()
  const pid = (await host.stats()).pid
  return { host, pid, invoke: (method: string) => host.invokeTool(host.list('tool').find(tool => tool.name === 'ios_deadline')!.id, { method }, {}) }
}

test('forwarded boot outlives both generic IPC timers without restarting the host', async t => {
  let timer: ReturnType<typeof setTimeout> | undefined, finish = () => {}, completed = false
  const engine = { boot: async () => {
    await new Promise<void>(resolve => { finish = resolve; timer = setTimeout(resolve, 1400) })
    completed = true
  } } as unknown as IosCapability
  const f = await fixture(t, engine, () => { clearTimeout(timer); finish() })
  const result = await f.invoke('boot')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(completed, true)
  assert.equal((await f.host.stats()).pid, f.pid)
})

test('a forwarded operation past its engine bound aborts and reports the deadline', async t => {
  let finish = () => {}, aborted = false
  const engine = new IosEngine({ run: async (_binary, args, options) => {
    if (args[1] === 'list') return { stdout: JSON.stringify({ devices: { fixture: [{ udid: '11111111-1111-1111-1111-111111111111', name: 'Synthetic device', state: 'Shutdown' }] } }), stderr: '' }
    const signal = (options as { signal?: AbortSignal }).signal
    return new Promise(resolve => {
      finish = () => resolve({ stdout: '', stderr: '' })
      signal?.addEventListener('abort', () => { aborted = true; finish() }, { once: true })
    })
  } })
  t.after(() => engine.dispose())
  const f = await fixture(t, engine, () => finish())
  const result = await f.invoke('boot')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /exceeded its bounded work deadline/)
  assert.equal(aborted, true)
  assert.equal((await f.host.stats()).pid, f.pid)
})

test('diagnose forwarding covers all sequential engine probes', async t => {
  const probes: number[] = []
  const engine = new IosEngine({ environment: {
    platform: 'darwin', developerDirectory: undefined, exists: () => true,
    execute: async (binary, args, options) => {
      probes.push(options.timeoutMs)
      await sleep(250)
      const stdout = binary === 'xcode-select' ? '/Applications/Xcode.app/Contents/Developer' :
        args[0] === '--find' ? '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl' :
        args[0] === '-showsdks' ? 'iphonesimulator27.0' :
        args[0] === 'simctl' ? JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', isAvailable: true }] }) : ''
      return { stdout, stderr: '', exitCode: 0 }
    },
  } })
  t.after(() => engine.dispose())
  const f = await fixture(t, engine)
  const result = await f.invoke('diagnose')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(probes.length, 5)
  const api = await import('@harnessdesk/cordis-host') as unknown as { iosCallTimeoutMs?: (call: { method: string; args: unknown[] }) => number }
  assert.equal(typeof api.iosCallTimeoutMs, 'function', 'Forwarding must use one engine-derived deadline policy.')
  assert.ok(api.iosCallTimeoutMs!({ method: 'diagnose', args: [] }) > probes.reduce((total, ms) => total + ms, 0))
  assert.equal((await f.host.stats()).pid, f.pid)
})
