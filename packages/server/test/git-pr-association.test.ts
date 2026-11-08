import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ForgeScope } from '@harnessdesk/cordis-host'
import { ForgePlane } from '../src/forge.js'
import type { ForgeAssociatedPullRequest } from '@harnessdesk/protocol'
import { GitGateway } from '../src/git-gateway/index.js'

const repository = 'acme/widgets'
const caller = { runtime: 'fake', sessionId: 'conversation-1' }
const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), 'hd-pr-association-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const calls: Array<{ cwd: string; args: readonly string[]; host: string | undefined; repo: string | undefined }> = []
  const replies = new Map<number, { stdout: string; stderr: string; exitCode: number }>()
  const options = { directory, gh: async (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
    calls.push({ cwd, args: [...args], host: env.GH_HOST, repo: env.GH_REPO })
    return replies.get(Number(args[2])) ?? { stdout: '', stderr: 'inaccessible fixture candidate', exitCode: 1 }
  } }
  const gateway = new GitGateway(options)
  await gateway.ready()
  const create = async (number: number, branch = 'worker', identity = caller) => {
    await gateway.gitRecord.append({ id: `create-${number}-${branch}`, repository, branch, number,
      op: 'pr.create', outcome: 'ok', at: 1, approval: null,
      requester: { kind: 'session', id: `${identity.runtime}/${identity.sessionId}`, conversation: identity } })
  }
  const reply = (number: number, state = 'OPEN', headRefName = 'worker') => {
    replies.set(number, { stdout: JSON.stringify({ number, state, headRefName }), stderr: '', exitCode: 0 })
  }
  const query = (engine = gateway, identity = caller) =>
    (engine as GitGateway & { associatedPullRequest(repository: string, caller: typeof identity): Promise<ForgeAssociatedPullRequest> })
      .associatedPullRequest(repository, identity)
  return { directory, options, gateway, calls, replies, create, reply, query }
}

test('recorded creation numbers accept repository case and reject foreign or malformed URLs', async t => {
  const cases = [
    { name: 'mixed-case', url: 'https://github.com/Acme/Widgets/pull/7', number: 7 },
    { name: 'lowercase', url: 'https://github.com/acme/widgets/pull/7', number: 7 },
    { name: 'other-repository', url: 'https://github.com/Acme/Other/pull/7', number: undefined },
    { name: 'repository-prefix', url: 'https://github.com/acme/widgets-extra/pull/7', number: undefined },
    { name: 'foreign-host', url: 'https://github.com.evil.example/acme/widgets/pull/7', number: undefined },
    { name: 'nondecimal-number', url: 'https://github.com/acme/widgets/pull/1e3', number: undefined },
    { name: 'unsafe-number', url: 'https://github.com/acme/widgets/pull/9007199254740992', number: undefined },
    { name: 'zero-number', url: 'https://github.com/acme/widgets/pull/0', number: undefined },
  ] as const
  for (const item of cases) await t.test(item.name, async t => {
    const f = await fixture(t)
    const gateway = new GitGateway({ ...f.options, gh: async (cwd, args, env) => {
      if (args[0] === 'pr' && args[1] === 'create') return { stdout: `${item.url}\n`, stderr: '', exitCode: 0 }
      return f.options.gh(cwd, args, env)
    } })
    await gateway.ready()
    await gateway.createPullRequest({ repository, branch: 'worker', title: 'Widgets', body: 'Body',
      requester: { kind: 'session', id: `${caller.runtime}/${caller.sessionId}`, conversation: caller } })
    const rows = await gateway.record({ repository, limit: 10 })
    const created = rows.find(row => row.op === 'pr.create' && row.outcome === 'ok')
    assert.ok(created)
    assert.equal(created.number, item.number)
    f.reply(7)
    assert.deepEqual(await gateway.associatedPullRequest(repository, caller), item.number === undefined
      ? { status: 'none' } : { status: 'found', number: item.number, repository })
    if (item.number === undefined) assert.equal(f.calls.length, 0, 'a missing actual number confers no candidate')
  })
})

test('associated PR network reads leave the repository record writable', { timeout: 5000 }, async t => {
  let release = () => {}
  let pending: Promise<ForgeAssociatedPullRequest> | undefined
  let observation: Promise<void> | undefined
  // Registered before fixture removal; even a controlled old-code deadlock releases and joins owned work first.
  t.after(async () => { release(); await Promise.allSettled([pending, observation]) })
  const f = await fixture(t)
  await f.create(7); f.reply(7)
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const gateway = new GitGateway({ ...f.options, gh: async (cwd, args, env) => {
    entered(); await held
    return f.options.gh(cwd, args, env)
  } })
  await gateway.ready()
  pending = gateway.associatedPullRequest(repository, caller)
  await reading
  observation = gateway.observe(repository, 'observed', 'a'.repeat(40), null)
  await observation
  release()
  assert.deepEqual(await pending, { status: 'found', number: 7, repository })
})

test('associated PR cancellation does not schedule another candidate read', async t => {
  const f = await fixture(t)
  await f.create(7); await f.create(8); f.reply(7); f.reply(8)
  const controller = new AbortController()
  const gateway = new GitGateway({ ...f.options, gh: async (cwd, args, env) => {
    const reply = await f.options.gh(cwd, args, env)
    controller.abort()
    return reply
  } })
  await gateway.ready()
  const engine = gateway as GitGateway & { associatedPullRequest(repository: string, identity: typeof caller, signal?: AbortSignal): Promise<ForgeAssociatedPullRequest> }
  assert.deepEqual(await engine.associatedPullRequest(repository, caller, controller.signal), { status: 'unavailable' })
  assert.deepEqual(f.calls.map(call => call.args[2]), ['7'])
})

test('associated PR reads each explicit pinned candidate and survives gateway restart', async t => {
  const f = await fixture(t)
  await f.create(7); await f.create(7); await f.create(8); await f.create(9)
  await f.create(10, 'other-head')
  f.reply(7); f.reply(8, 'CLOSED'); f.reply(9, 'MERGED'); f.reply(10)
  const reopened = new GitGateway(f.options)
  await reopened.ready()
  assert.deepEqual(await f.query(reopened), { status: 'found', number: 7, repository })
  assert.deepEqual(f.calls.map(call => call.args[2]), ['7', '8', '9', '10'])
  for (const call of f.calls) {
    assert.equal(call.cwd, f.directory)
    assert.deepEqual(call.args.slice(0, 3), ['pr', 'view', call.args[2]])
    assert.deepEqual(call.args.slice(-2), ['--repo', repository])
    assert.equal(call.host, 'github.com')
    assert.equal(call.repo, undefined)
  }
})

test('associated PR refuses ambiguity and unreadable candidate evidence', async t => {
  for (const mode of ['ambiguous', 'inaccessible', 'malformed', 'wrong-number', 'missing-head', 'non-string-state'] as const) {
    await t.test(mode, async t => {
      const f = await fixture(t)
      await f.create(7); await f.create(8)
      f.reply(7)
      if (mode === 'ambiguous') f.reply(8)
      else if (mode === 'malformed') f.replies.set(8, { stdout: '{broken', stderr: '', exitCode: 0 })
      else if (mode === 'wrong-number') f.replies.set(8, { stdout: JSON.stringify({ number: 99, state: 'OPEN', headRefName: 'worker' }), stderr: '', exitCode: 0 })
      else if (mode === 'missing-head') f.replies.set(8, { stdout: JSON.stringify({ number: 8, state: 'OPEN' }), stderr: '', exitCode: 0 })
      else if (mode === 'non-string-state') f.replies.set(8, { stdout: JSON.stringify({ number: 8, state: ['OPEN'], headRefName: 'worker' }), stderr: '', exitCode: 0 })
      assert.deepEqual(await f.query(), { status: mode === 'ambiguous' ? 'ambiguous' : 'unavailable' })
      assert.deepEqual(f.calls.map(call => call.args[2]), ['7', '8'], 'an accessible open candidate does not hide another inaccessible one')
    })
  }
})

test('associated PR keeps caller isolation and damaged journal failure separate from no match', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.query(), { status: 'none' })
  await f.create(7)
  f.reply(7)
  assert.deepEqual(await f.query(f.gateway, { ...caller, sessionId: 'other' }), { status: 'none' })
  assert.deepEqual(await f.query(f.gateway, { ...caller, runtime: 'other' }), { status: 'none' })
  assert.equal(f.calls.length, 0)
  const path = join(f.directory, 'git-record', 'acme__widgets.ndjson')
  await writeFile(path, (await readFile(path, 'utf8')).replace('"number":7', '"number":8'))
  assert.deepEqual(await f.query(), { status: 'unavailable' })
  assert.equal(f.calls.length, 0, 'unverified history never reaches the forge')
})

test('associated PR counts one number once across duplicate recorded branches', async t => {
  const f = await fixture(t)
  await f.create(7, 'old-head'); await f.create(7, 'current-head')
  f.reply(7, 'OPEN', 'current-head')
  assert.deepEqual(await f.query(), { status: 'found', number: 7, repository })
  assert.equal(f.calls.length, 1)
  f.reply(7, 'OPEN', 'unrecorded-head')
  assert.deepEqual(await f.query(), { status: 'none' })
})


test('association host boundary keeps live caller and destination fences around the awaited read', async t => {
  for (const mode of ['success', 'missing-pin', 'origin-before', 'human', 'context', 'expired-before', 'expired-after', 'pin-after', 'origin-after'] as const) {
    await t.test(mode, async t => {
      const f = await fixture(t)
      let pin: string | null = mode === 'missing-pin' ? null : repository
      let origin = mode !== 'origin-before'
      f.gateway.pins.pinned = async () => pin
      f.gateway.originMatches = async () => origin
      const controller = new AbortController()
      const scope: ForgeScope = { ...caller, plugin: 'git#1', actor: mode === 'human' ? 'human' : mode === 'context' ? 'context' : 'agent', signal: controller.signal }
      let reads = 0
      let heard: unknown
      f.gateway.associatedPullRequest = async (repo, identity) => {
        reads++
        heard = { repo, identity }
        await Promise.resolve()
        if (mode === 'expired-after') controller.abort()
        if (mode === 'pin-after') pin = 'acme/other'
        if (mode === 'origin-after') origin = false
        return { status: 'found', number: 7, repository }
      }
      const plane = new ForgePlane({
        gitGateway: f.gateway,
        checkoutOf: async () => ({ root: f.directory, cwd: f.directory }),
        agentOf: () => ({ name: 'Test Agent', version: null }),
        optionsOf: () => [], toolsOffered: () => true, record: () => false,
        admitWrite: async () => { throw new Error('association must remain a read') },
      })
      if (mode === 'expired-before') controller.abort()
      const query = () => (plane as ForgePlane & { associatedPullRequest(scope: ForgeScope): Promise<ForgeAssociatedPullRequest> }).associatedPullRequest(scope)
      if (mode === 'success') {
        assert.deepEqual(await query(), { status: 'found', number: 7, repository })
        assert.deepEqual(heard, { repo: repository, identity: caller }, 'caller comes from the live host scope')
        assert.equal(reads, 1)
      } else {
        const expected = mode === 'expired-before' || mode === 'expired-after' ? /live invocation/
          : mode === 'human' || mode === 'context' ? /live agent conversation/
          : mode === 'missing-pin' ? /no pinned repository/ : /git-gateway-repository-changed/
        await assert.rejects(query, expected)
        assert.equal(reads, ['expired-after', 'pin-after', 'origin-after'].includes(mode) ? 1 : 0)
      }
    })
  }
})
