import assert from 'node:assert/strict'
import { test } from 'node:test'



import { ExtensionKernel, setForgeEngine, type ForgeEngine } from '../src/index.js'
import { describePermissions, readPermissions } from '../src/manifest.js'

const unavailableWrites = {
  repository: async () => 'acme/widgets',
  push: async () => { throw new Error('No gateway in this fixture') },
  pullRequest: { create: async () => { throw new Error('No gateway in this fixture') }, update: async () => { throw new Error('No gateway in this fixture') }, merge: async () => { throw new Error('No gateway in this fixture') } },
  review: async () => { throw new Error('No gateway in this fixture') },
  comment: async () => { throw new Error('No gateway in this fixture') },
  record: async () => [], attribute: async () => 'outside' as const,
}

/**
 * `ctx.forge` behind its grant. A plugin without `forge` cannot read a seat
 * or write a record — signing as somebody's conversation is exactly the
 * thing the gate exists for — and a plugin with it reaches the engine with
 * its own identity stamped on the scope, so the host knows who asked.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const engine = (): ForgeEngine & { readonly seats: unknown[]; readonly published: unknown[] } => {
  const seats: unknown[] = []
  const published: unknown[] = []
  return {
    ...unavailableWrites,
    seats,
    published,
    seat: async (scope) => {
      seats.push(scope)
      return { agent: 'Codex', version: null, model: 'GPT-5.4', effort: 'High', thinking: false, label: 'Codex GPT-5.4 · High', role: null, round: null, team: null }
    },
    identity: async (scope) => {
      seats.push({ identity: scope })
      return { via: 'gh', login: 'octocat', available: true, reason: null }
    },
    publish: async (reference, scope) => {
      published.push({ reference, scope })
    },
    publicationAllowed: async (scope) => {
      seats.push({ publicationAllowed: scope })
      return { ok: true }
    },
  }
}

test('the forge plane needs the grant; with it, the scope carries the plugin', async (t) => {
  const plane = engine()
  setForgeEngine(plane)
  t.after(() => setForgeEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())

  await kernel.load({
    manifest: { id: 'ungranted', name: 'Ungranted' },
    plugin: {
      name: 'ungranted',
      inject: ['tools', 'forge'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'ungranted_seat',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => {
            try {
              return JSON.stringify(await ctx.forge.seat(scope))
            } catch (error) {
              return `refused: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        })
        ctx.tools.register({
          name: 'ungranted_allowed',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => {
            try {
              return JSON.stringify(await ctx.forge.publicationAllowed(scope))
            } catch (error) {
              return `refused: ${error instanceof Error ? error.message : String(error)}`
            }
          },
        })
      },
    },
  })
  await kernel.load({
    manifest: { id: 'granted', name: 'Granted', permissions: { forge: true } },
    plugin: {
      name: 'granted',
      inject: ['tools', 'forge'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'granted_seat',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => JSON.stringify(await ctx.forge.seat(scope)),
        })
        ctx.tools.register({
          name: 'granted_allowed',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => JSON.stringify(await ctx.forge.publicationAllowed(scope)),
        })
        ctx.tools.register({
          name: 'granted_publish',
          description: 'x',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_args: unknown, scope: unknown) => {
            await ctx.forge.publish({ kind: 'pullRequest', number: 1, repo: 'a/b', url: 'https://x/pull/1' }, scope)
            return 'recorded'
          },
        })
      },
    },
  })
  await settle()

  const tool = (name: string) => {
    const found = kernel.list('tool').find((entry) => entry.name === name)
    assert.ok(found, `no tool ${name}`)
    return found.id
  }
  const scope = { runtime: 'codex', sessionId: 's1' } as any

  const refused = await kernel.invokeTool(tool('ungranted_seat'), {}, scope)
  assert.match(JSON.stringify(refused), /refused: .*forge/)
  assert.equal(plane.seats.length, 0, 'the engine never heard from the ungranted plugin')

  const seat = await kernel.invokeTool(tool('granted_seat'), {}, scope)
  assert.match(JSON.stringify(seat), /Codex GPT-5\.4 · High/)
  const asked = plane.seats[0] as { runtime: string; sessionId: string; plugin: string }
  assert.equal(asked.runtime, 'codex')
  assert.equal(asked.sessionId, 's1')
  assert.match(asked.plugin, /^granted#\d+$/, 'the engine is told which plugin instance asked, stamped by the service')

  await kernel.invokeTool(tool('granted_publish'), {}, scope)
  assert.equal(plane.published.length, 1)
  const recorded = (plane.published[0] as { scope: { plugin: string } }).scope
  assert.match(recorded.plugin, /^granted#\d+$/)

  // Phase 7: the embargo is asked with the same grant and the same stamped scope.
  const allowed = await kernel.invokeTool(tool('granted_allowed'), {}, scope)
  assert.match(JSON.stringify(allowed), /\{\\"ok\\":true\}/)
  const embargo = plane.seats.at(-1) as { publicationAllowed: { runtime: string; sessionId: string; plugin: string } }
  assert.equal(embargo.publicationAllowed.sessionId, 's1')
  assert.match(embargo.publicationAllowed.plugin, /^granted#\d+$/)
  const before = plane.seats.length
  assert.match(JSON.stringify(await kernel.invokeTool(tool('ungranted_allowed'), {}, scope)), /refused: .*forge/)
  assert.equal(plane.seats.length, before, 'an ungranted plugin never reaches the embargo either')
})

test('the grant is read from a manifest and described in a sentence', () => {
  const granted = readPermissions({ forge: true })
  assert.equal(granted.forge, true)
  assert.ok(describePermissions(granted).some((line) => /Sign pull requests/.test(line)))
  const plain = readPermissions({})
  assert.equal(plain.forge, false)
  assert.ok(!describePermissions(plain).some((line) => /Sign pull requests/.test(line)))
})

test('forge.write is an explicit grant and true remains publish-only', () => {
  const write = readPermissions({ forge: { publish: true, write: true } })
  assert.deepEqual(write.forge, { publish: true, write: true })
  assert.ok(describePermissions(write).includes("Push branches and open, update and merge pull requests through HarnessDesk, as you, recorded in the project's Git record."))
  assert.equal(readPermissions({ forge: true }).forge, true)
  assert.equal(readPermissions({ forge: { write: 'yes' } }).forge, false)
})

test('all writes require forge.write and every forge verb needs its own live invocation', async t => {
  let calls = 0
  const write = async () => { calls++; return { output: '', repository: 'acme/widgets' } }
  setForgeEngine({ ...engine(), push: write, pullRequest: { create: write, update: write, merge: write }, review: write, comment: write, record: async () => [], attribute: async () => 'outside' })
  t.after(() => setForgeEngine(null))
  const kernel = new ExtensionKernel(); t.after(() => kernel.dispose())
  const saved: Record<string, (() => Promise<unknown>) | undefined> = {}
  const operations = (ctx: any, scope: any) => ({
    push: () => ctx.forge.push({ branch: 'feature/widgets', sha: 'a'.repeat(40), expect: 'create' }, scope),
    create: () => ctx.forge.pullRequest.create({ head: 'feature/widgets', title: 'Widgets', body: 'Body' }, scope),
    update: () => ctx.forge.pullRequest.update({ number: 1, body: 'Body' }, scope),
    merge: () => ctx.forge.pullRequest.merge({ number: 1, head: 'a'.repeat(40), method: 'squash' }, scope),
    review: () => ctx.forge.review({ number: 1, event: 'approve', body: '' }, scope),
    comment: () => ctx.forge.comment({ subject: 'issue', number: 1, body: 'Body' }, scope),
    repository: () => ctx.forge.repository(scope),
    record: () => ctx.forge.record({}, scope), attribute: () => ctx.forge.attribute({ branch: 'feature/widgets', sha: 'a'.repeat(40) }, scope),
    seat: () => ctx.forge.seat(scope), identity: () => ctx.forge.identity(scope),
    publish: () => ctx.forge.publish({ kind: 'issue', repo: 'acme/widgets', number: 1, url: 'https://github.com/acme/widgets/issues/1', via: 'gh' }, scope),
    publicationAllowed: () => ctx.forge.publicationAllowed(scope),
  })
  for (const [id, forge] of [['legacy', true], ['writer', { write: true }]] as const) {
    await kernel.load({ manifest: { id, name: id, permissions: { forge } }, plugin: { name: id, inject: ['tools', 'forge'], apply(ctx: any) {
      ctx.tools.register({ name: id, description: 'Fixture', inputSchema: { type: 'object' }, execute: async (args: any, scope: any) => {
        const ops = operations(ctx, scope)
        if (args.save) { Object.assign(saved, ops); return 'saved' }
        if (args.spoof) return ctx.forge.record({}, { ...scope, sessionId: 'someone-else' })
        return JSON.stringify(await ops[args.verb as keyof typeof ops]())
      } })
    } } })
  }
  await settle()
  const call = (name: string, args: unknown) => kernel.invokeTool(kernel.list('tool').find(one => one.name === name)!.id, args, { runtime: 'fixture', sessionId: 's1' } as never)
  for (const verb of ['push', 'create', 'update', 'merge', 'review', 'comment']) {
    const denied = await call('legacy', { verb })
    assert.equal(denied.ok, false); assert.match(JSON.stringify(denied), /forge.write/)
    assert.equal(calls, 0)
  }
  for (const verb of ['repository', 'record', 'attribute']) assert.equal((await call('legacy', { verb })).ok, true)
  for (const verb of ['push', 'create', 'update', 'merge', 'review', 'comment']) assert.equal((await call('writer', { verb })).ok, true, verb)
  assert.equal(calls, 6)
  assert.match(JSON.stringify(await call('writer', { spoof: true })), /live invocation/)
  assert.equal((await call('writer', { save: true })).ok, true)
  for (const [verb, call] of Object.entries(saved)) await assert.rejects(call!, /live invocation/, verb)
})

test('forge arguments reject malformed heads, refs and operation shapes before reaching an engine', async t => {
  const { validateForgeArgs } = await import('../src/index.js')
  const sha = 'a'.repeat(40)
  for (const branch of ['', '-flag', 'a..b', 'a@{b', '.hidden', 'a/.hidden', 'a.lock', 'a//b', 'a b', 'a\\b', 'a?', 'a/', 'a.']) {
    assert.throws(() => validateForgeArgs('push', { branch, sha, expect: 'create' }), /Invalid forge/, branch)
  }
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'G'.repeat(40), null, 12]) {
    assert.throws(() => validateForgeArgs('push', { branch: 'feature/a', sha: bad, expect: 'create' }))
    assert.throws(() => validateForgeArgs('push', { branch: 'feature/a', sha, expect: { head: bad } }))
  }
  for (const [verb, args] of [
    ['push', { branch: 'feature/a', sha, expect: 'create', repository: 'acme/decoy' }],
    ['create', { head: '-flag', title: 'Title', body: '' }], ['create', { head: 'feature/a', title: '', body: '' }],
    ['update', { number: 1 }], ['update', { number: -1, body: '' }], ['merge', { number: 1, head: sha, method: 'force' }],
    ['review', { number: 1, event: 'unknown', body: '' }], ['comment', { number: 1, subject: 'unknown', body: '' }],
    ['record', { limit: 0 }], ['record', { limit: 1001 }], ['attribute', { branch: 'main', sha: 'bad' }],
  ] as const) assert.throws(() => validateForgeArgs(verb, args))
  validateForgeArgs('push', { branch: 'feature/a', sha: 'b'.repeat(64), expect: { head: sha } })
})


test('forge scopes distinguish commands from tools and refuse context writes', async t => {
  const heard: string[] = []
  setForgeEngine({ ...engine(), comment: async (_args, scope) => { heard.push(scope.actor ?? 'missing'); return { repository: 'acme/widgets', output: 'ok' } } })
  t.after(() => setForgeEngine(null))
  const kernel = new ExtensionKernel(); t.after(() => kernel.dispose())
  await kernel.load({ manifest: { id: 'actors', name: 'Actors', permissions: { forge: { write: true } } }, plugin: {
    name: 'actors', inject: ['tools', 'commands', 'context', 'forge'], apply(ctx: any) {
      const write = (scope: any) => ctx.forge.comment({ subject: 'issue', number: 1, body: 'Body' }, scope)
      ctx.tools.register({ name: 'write', description: 'Fixture', inputSchema: { type: 'object' }, execute: (_args: any, scope: any) => write(scope).then(() => 'ok') })
      ctx.commands.register({ name: 'write', description: 'Fixture', run: (_args: any, scope: any) => write(scope).then(() => {}) })
      ctx.context.register({ label: 'Write', resolve: (scope: any) => write(scope).then(() => 'unexpected') })
    },
  } })
  await settle()
  const scope = { runtime: 'fixture', sessionId: 's1' } as never
  const tool = kernel.list('tool').find(one => one.name === 'write')!
  assert.equal((await kernel.invokeTool(tool.id, {}, scope)).ok, true)
  await kernel.runCommand('write', '', scope)
  assert.deepEqual(heard, ['agent', 'human'])
  await kernel.resolveContext(scope)
  assert.deepEqual(heard, ['agent', 'human'], 'context resolvers never reach a write engine')
})
