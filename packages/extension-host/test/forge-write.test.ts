import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ExtensionKernel, type ForgeEngine, type ForgeScope } from '@harnessdesk/cordis-host'
import { SupervisedExtensionHost } from '../src/index.js'

const plugin = `
const speak = (method, params) => new Promise(resolve => {
  const id = 900000 + Math.floor(Math.random() * 10000)
  const listen = chunk => { if (!String(chunk).includes(String(id))) return; process.stdin.off('data', listen); resolve(String(chunk)) }
  process.stdin.on('data', listen); process.stdout.write(JSON.stringify({ request: id, method, params }) + '\\n')
})
export const plugin = { name: 'writer', inject: ['tools', 'context', 'forge'], apply(ctx) {
  ctx.tools.register({ name: 'forge_write', description: 'Fixture', inputSchema: { type: 'object' }, execute: async (args, scope) => {
    if (args.raw) return speak('forge/' + args.verb, { args: args.input, scope: { runtime: scope.runtime, sessionId: scope.sessionId, plugin: 'writer#1' } })
    if (args.verb === 'repository') return JSON.stringify(await ctx.forge.repository(scope))
    if (['create', 'update', 'merge'].includes(args.verb)) return JSON.stringify(await ctx.forge.pullRequest[args.verb](args.input, scope))
    return JSON.stringify(await ctx.forge[args.verb](args.input, scope))
  } })
  ctx.context.register({ label: 'Record', resolve: async scope => JSON.stringify(await ctx.forge.record({}, scope)) })
} }
`

const inputs = {
  push: { branch: 'feature/widgets', sha: 'a'.repeat(40), expect: 'create' },
  create: { head: 'feature/widgets', title: 'Widgets', body: 'Body' }, update: { number: 1, body: 'Body' },
  merge: { number: 1, head: 'a'.repeat(40), method: 'squash' }, review: { number: 1, event: 'approve', body: '' },
  comment: { subject: 'pullRequest', number: 1, body: 'Body' }, repository: {}, record: {}, attribute: { branch: 'feature/widgets', sha: 'a'.repeat(40) },
}

test('forge writes cross the child only with a write grant, valid shapes, and a host-owned live scope', async t => {
  for (const forge of [true, { publish: true, write: true }]) {
    const root = await mkdtemp(join(tmpdir(), 'hd-forge-child-')), store = join(root, 'plugins'), directory = join(store, 'writer')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'harnessdesk.plugin.json'), JSON.stringify({ id: 'writer', name: 'Writer', main: './index.mjs', permissions: { forge } }))
    await writeFile(join(directory, 'index.mjs'), plugin)
    const heard: ForgeScope[] = []
    const answer = async (_args: unknown, scope: ForgeScope) => {
      assert.ok(scope.signal && !scope.signal.aborted)
      heard.push(scope)
      return { output: 'written', repository: 'acme/widgets' }
    }
    const engine: ForgeEngine = {
      seat: async () => null, identity: async () => ({ via: 'gh', login: null, available: true, reason: null }),
      publish: async () => {}, publicationAllowed: async () => ({ ok: true }),
      repository: async () => 'acme/widgets',
      push: answer, pullRequest: { create: answer, update: answer, merge: answer }, review: answer, comment: answer,
      record: async (_args, scope) => { assert.ok(scope.signal && !scope.signal.aborted); heard.push(scope); return [] }, attribute: async () => 'outside',
    }
    const host = new SupervisedExtensionHost(new ExtensionKernel(), { invokeTimeoutMs: 3000, env: { HARNESSDESK_PLUGINS: store }, forgeEngine: engine })
    try {
      await host.loadInstalledPlugins()
      const tool = host.list('tool').find(one => one.name === 'forge_write'); assert.ok(tool)
      const scope = { runtime: 'fixture', sessionId: 's1' } as never
      for (const [verb, input] of Object.entries(inputs)) {
        const result = await host.invokeTool(tool.id, { verb, input }, scope)
        const needsWrite = !['repository', 'record', 'attribute'].includes(verb)
        if (forge === true && needsWrite) { assert.equal(result.ok, false); assert.match(JSON.stringify(result), /forge.write/) }
        else assert.equal(result.ok, true, JSON.stringify(result))
        if (needsWrite) {
          const raw = await host.invokeTool(tool.id, { verb, input, raw: true }, scope)
          if (forge === true) assert.match(JSON.stringify(raw), /forge.write/)
          else assert.match(JSON.stringify(raw), /written/)
        }
      }
      const before = heard.length
      const invalid = await host.invokeTool(tool.id, { verb: 'push', input: { ...inputs.push, sha: 'bad' }, raw: true }, scope)
      assert.match(JSON.stringify(invalid), forge === true ? /forge.write/ : /Invalid forge push/)
      assert.equal(heard.length, before)
      const context = await host.resolveContext(scope)
      assert.equal(context.length, 1)
      assert.ok(heard.every(one => one.runtime === 'fixture' && one.sessionId === 's1' && one.plugin === 'writer#1'))
      assert.ok(heard.every(one => one.signal?.aborted), 'the parent closes every invocation lease')
    } finally { await host.dispose(); await rm(root, { recursive: true, force: true }) }
  }
})


test('a host-held forge approval keeps a child invocation alive beyond its injected timeout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hd-forge-held-')), store = join(root, 'plugins'), directory = join(store, 'writer')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'harnessdesk.plugin.json'), JSON.stringify({ id: 'writer', name: 'Writer', main: './index.mjs', permissions: { forge: { write: true } } }))
  // Model registration outlasting the old 200ms budget on a cold or busy host.
  // The test must reach the host-held response instead of timing out at startup.
  const slowRegistration = plugin.replace('apply(ctx) {', 'apply(ctx) { const ready = Date.now() + 250; while (Date.now() < ready) {}')
  await writeFile(join(directory, 'index.mjs'), slowRegistration)
  const invokeTimeoutMs = 3_000
  const heard: ForgeScope[] = []
  const answer = async (_args: unknown, scope: ForgeScope) => {
    heard.push(scope)
    await new Promise(resolve => setTimeout(resolve, invokeTimeoutMs + 500))
    assert.equal(scope.signal?.aborted, false, 'answering after the normal deadline is still live')
    return { output: 'written', repository: 'acme/widgets' }
  }
  const engine: ForgeEngine = {
    repository: async () => 'acme/widgets', seat: async () => null, identity: async () => ({ via: 'gh', login: null, available: true, reason: null }),
    publish: async () => {}, publicationAllowed: async () => ({ ok: true }),
    push: answer, pullRequest: { create: answer, update: answer, merge: answer }, review: answer, comment: answer,
    record: async () => [], attribute: async () => 'outside',
  }
  const host = new SupervisedExtensionHost(new ExtensionKernel(), { invokeTimeoutMs, env: { HARNESSDESK_PLUGINS: store }, forgeEngine: engine })
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }) })
  await host.loadInstalledPlugins()
  const tool = host.list('tool').find(one => one.name === 'forge_write')!
  const result = await host.invokeTool(tool.id, { verb: 'push', input: inputs.push }, { runtime: 'fixture', sessionId: 's1', turnId: 't1' } as never)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(heard.length, 1)
  assert.equal(heard[0]?.turnId, 't1')
  assert.equal(heard[0]?.actor, 'agent')
  assert.equal(heard[0]?.signal?.aborted, true)
})
