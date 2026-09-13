import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { itemId, sessionId, turnId, type AgentItem, type ForgeReference, type PublicationItem, type Session } from '@harnessdesk/protocol'

import { FORGE_INSTRUCTION, ForgePlane, type ForgeRunner, type GhRunner } from '../src/forge.js'
import { StateStore } from '../src/index.js'
import { FAKE_RUNTIME_ID, type FakeSession } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'

/**
 * The forge plane: the seat a publication is signed as, the record of it in
 * the transcript, the identity the desk reaches the forge with, and the one
 * sentence the agents are told. The seat and the record are driven through
 * a real host over the wire, because they are read off the host's own
 * runtimes and records; the identity and the sentence are unit-tested on
 * the plane, because they are the plane's own.
 */

const reference: ForgeReference = {
  kind: 'pullRequest',
  action: 'opened',
  repo: 'acme/widgets',
  number: 7,
  url: 'https://github.com/acme/widgets/pull/7',
  title: 'Add widgets',
  state: 'open',
  author: 'octocat',
  additions: 12,
  deletions: 3,
  files: 2,
  excerpt: 'Widgets.\n\n🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Fake Runtime Fake One)',
  via: 'gh',
  signature: '🤖 Generated with [HarnessDesk](https://harnessdesk.app) (Fake Runtime Fake One)',
}

test('the seat is read off the host: the agent’s name and version, the model by its label', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  const scope = { runtime: String(FAKE_RUNTIME_ID), sessionId: session.id, plugin: 'git' }
  const seat = await harness.host.forgePlane.seat(scope)
  assert.deepEqual(seat, {
    agent: 'Fake Runtime',
    version: '1.0.0',
    model: 'Fake One',
    effort: null,
    thinking: false,
    label: 'Fake Runtime Fake One',
  })

  // The seat follows the conversation's controls, not a value read at open.
  await client.call('session/options/set', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, optionId: 'model', value: 'fake-2' })
  assert.equal((await harness.host.forgePlane.seat(scope))?.label, 'Fake Runtime Fake Two')

  // Nothing the host holds is not a seat: no invented agent, no invented model.
  assert.equal(await harness.host.forgePlane.seat({ runtime: 'nobody', sessionId: session.id }), null)
  assert.equal(await harness.host.forgePlane.seat({ runtime: String(FAKE_RUNTIME_ID), sessionId: 'nothing' }), null)
  assert.equal(await harness.host.forgePlane.seat({}), null)
})

test('a publication lands in the running turn, reaches every window, and outlives the turn’s own completion', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'open the PR' }] })
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))

  const scope = { runtime: String(FAKE_RUNTIME_ID), sessionId: session.id, plugin: 'git' }
  await harness.host.forgePlane.publish(reference, scope)

  // Every window hears it as an item of the turn, the shape the agent's own items arrive in.
  await client.until(() =>
    client.events.some((event) => event.type === 'item/completed' && event.item.type === 'publication'),
  )
  const heard = client.events.find((event) => event.type === 'item/completed' && event.item.type === 'publication')
  assert.ok(heard && heard.type === 'item/completed')
  assert.deepEqual((heard.item as PublicationItem).reference, reference)

  const record = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))
  const turn = record!.session.turns.at(-1)!
  assert.deepEqual(
    turn.items.map((item) => item.type),
    ['userMessage', 'assistantMessage', 'publication'],
    'the record is in the turn that was running, after what the agent had said so far',
  )

  // The fake, like Codex, completes the turn with its own account of the
  // items — which has never heard of the publication. The host keeps it.
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))
  const completed = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))!.session.turns.at(-1)!
  assert.equal(completed.status, 'completed')
  assert.ok(completed.items.some((item) => item.type === 'publication'), 'the publication survived the turn’s completion')

  // A conversation the host does not hold cannot be published into.
  await assert.rejects(
    harness.host.forgePlane.publish(reference, { runtime: String(FAKE_RUNTIME_ID), sessionId: 'nothing', plugin: 'git' }),
    /No conversation nothing/,
  )
  await assert.rejects(harness.host.forgePlane.publish(reference, { plugin: 'git' }), /named none/)
})

test('a publication after the turn ended goes into the last turn, never nowhere', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'go' }] })
  const live = harness.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))

  await harness.host.forgePlane.publish(reference, { runtime: String(FAKE_RUNTIME_ID), sessionId: session.id, plugin: 'git' })
  const turn = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))!.session.turns.at(-1)!
  assert.ok(turn.items.some((item) => item.type === 'publication'))
})

/**
 * The runtime's own account of a turn, longer than what it streamed — the
 * shape Codex hands back when a rollout stored more than the wire carried.
 * It has never heard of a publication. The host keeps the row where it
 * stood, in its own record and in what the windows are told.
 */
test('a publication keeps its place when the runtime’s account of the turn is longer, and the windows are told the kept list', async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())

  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'go' }] })
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))
  await harness.host.forgePlane.publish(reference, { runtime: String(FAKE_RUNTIME_ID), sessionId: session.id, plugin: 'git' })
  await client.until(() => client.events.some((event) => event.type === 'item/completed' && event.item.type === 'publication'))

  const longer: AgentItem[] = [
    { id: itemId('u-1'), type: 'userMessage', content: [{ type: 'text', text: 'go' }] },
    { id: itemId('a-1'), type: 'assistantMessage', text: 'echo: go' },
    { id: itemId('a-stored-1'), type: 'assistantMessage', text: 'a step the wire never carried' },
    { id: itemId('a-stored-2'), type: 'assistantMessage', text: 'and another' },
  ]
  harness.runtime.emit({
    type: 'turn/completed',
    sessionId: sessionId(session.id),
    turn: { id: turnId('fake-turn-1'), items: longer, status: 'completed' },
  })
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))

  const expected = ['userMessage', 'assistantMessage', 'publication', 'assistantMessage', 'assistantMessage']
  const held = harness.host.registry.get(FAKE_RUNTIME_ID, sessionId(session.id))!.session.turns.at(-1)!
  assert.deepEqual(held.items.map((item) => item.type), expected, 'the host’s record: the longer list, with the row where it stood')
  const told = client.events.find((event) => event.type === 'turn/completed')
  assert.ok(told && told.type === 'turn/completed')
  assert.deepEqual(told.turn.items.map((item) => item.type), expected, 'the windows were told the same list, not the runtime’s')
})

/**
 * Across a restart, and across a read the backend answers with as much as
 * the host knew. The old rule preferred the backend's turn whenever it was
 * not shorter — right for everything the backend produced, and wrong for the
 * one item it never produced.
 */
test('a publication survives a restart and a read the backend answers with as much as the host knew', async (t) => {
  const first = await start()
  const client = await Client.connect(first.server)
  const session = (await client.call('session/create', { runtime: FAKE_RUNTIME_ID, options: { cwd: '/w' } })) as Session
  await client.call('turn/send', { runtime: FAKE_RUNTIME_ID, sessionId: session.id, input: [{ type: 'text', text: 'go' }] })
  await client.until(() => client.events.some((event) => event.type === 'turn/started'))
  await first.host.forgePlane.publish(reference, { runtime: String(FAKE_RUNTIME_ID), sessionId: session.id, plugin: 'git' })
  const live = first.runtime.sessions.get(session.id) as FakeSession
  live.finish()
  await client.until(() => client.events.some((event) => event.type === 'turn/completed'))
  client.close()
  // Down, but not gone: `stop` would remove the state directory, and the
  // state directory — the transcript in it — is the point.
  await first.server.close()
  await first.host.dispose()

  const second = await start({ state: new StateStore(join(first.stateDir, 'state.json')) })
  t.after(() => stop(second))
  t.after(() => rm(first.stateDir, { recursive: true, force: true }))
  const again = await Client.connect(second.server)
  t.after(() => again.close())
  // The backend's own account: the two items it streamed and one it stored
  // besides — as many as the host held, and no publication among them.
  second.runtime.stored.set(sessionId(session.id), [
    {
      id: turnId('fake-turn-1'),
      status: 'completed',
      items: [
        { id: itemId('u-1'), type: 'userMessage', content: [{ type: 'text', text: 'go' }] },
        { id: itemId('a-1'), type: 'assistantMessage', text: 'echo: go' },
        { id: itemId('a-stored-1'), type: 'assistantMessage', text: 'a step the wire never carried' },
      ],
    },
  ])
  const read = (await again.call('session/read', { runtime: FAKE_RUNTIME_ID, sessionId: session.id })) as Session
  assert.deepEqual(
    read.turns.at(-1)?.items.map((item) => item.type),
    ['userMessage', 'assistantMessage', 'publication', 'assistantMessage'],
    'the backend’s list, with the host’s row put back where it stood',
  )
  const kept = read.turns.at(-1)?.items.find((item) => item.type === 'publication') as PublicationItem | undefined
  assert.deepEqual(kept?.reference, reference)
})

const answering = (script: (args: readonly string[]) => { stdout?: string; stderr?: string; exitCode?: number }): { gh: GhRunner; calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    gh: async (args) => {
      calls.push([...args])
      const said = script(args)
      return { stdout: said.stdout ?? '', stderr: said.stderr ?? '', exitCode: said.exitCode ?? 0 }
    },
  }
}

const port = (tools: boolean) => ({
  agentOf: () => null,
  optionsOf: () => null,
  record: () => false,
  toolsOffered: () => tools,
})

test('the identity is gh’s login, asked once and remembered', async () => {
  const { gh, calls } = answering(() => ({ stdout: 'octocat\n' }))
  const plane = new ForgePlane(port(true), { gh, identityTtlMs: 60_000 })
  const [first, second] = await Promise.all([plane.identity(), plane.identity()])
  assert.deepEqual(first, { via: 'gh', login: 'octocat', available: true, reason: null })
  assert.deepEqual(second, first)
  assert.equal(await plane.identity(), first)
  assert.equal(calls.length, 1, 'one gh call answers three asks')
  assert.deepEqual(calls[0], ['api', 'user', '--jq', '.login'])
  plane.forgetIdentity()
  await plane.identity()
  assert.equal(calls.length, 2, 'forgetting asks again')
})

test('gh’s refusals are states with a reason, never errors', async () => {
  const signedOut = new ForgePlane(port(true), {
    gh: answering(() => ({ exitCode: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' })).gh,
  })
  assert.deepEqual(await signedOut.identity(), {
    via: 'gh',
    login: null,
    available: false,
    reason: 'gh is not signed in: run `gh auth login`.',
  })
  const missing = new ForgePlane(port(true), { gh: answering(() => ({ exitCode: 1, stderr: 'spawn gh ENOENT' })).gh })
  assert.match((await missing.identity()).reason ?? '', /not installed/)
  const other = new ForgePlane(port(true), { gh: answering(() => ({ exitCode: 1, stderr: 'HTTP 503: down\nmore' })).gh })
  assert.equal((await other.identity()).reason, 'HTTP 503: down')
})

test('a future App runner is selected per repository without becoming a plugin shell', async () => {
  const calls: unknown[] = []
  const runner: ForgeRunner = {
    identity: async (options, scope) => {
      calls.push({ identity: { options, scope } })
      return { via: 'app', login: 'harnessdesk[bot]', available: true, reason: null }
    },
    run: async (args, options, scope) => {
      calls.push({ args, options, scope })
      return { stdout: 'ok', stderr: '', exitCode: 0 }
    },
  }
  const plane = new ForgePlane(port(true), { runner })
  const scope = { runtime: 'codex', sessionId: 's1', plugin: 'git#1' }

  assert.deepEqual(await plane.identity({ cwd: '/work/widgets' }, scope), { via: 'app', login: 'harnessdesk[bot]', available: true, reason: null })
  assert.deepEqual(await plane.run(['pr', 'view', '7'], { cwd: '/work/widgets', timeoutMs: 60_000 }, scope), {
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
  })
  assert.deepEqual(calls, [
    { identity: { options: { cwd: '/work/widgets' }, scope } },
    { args: ['pr', 'view', '7'], options: { cwd: '/work/widgets', timeoutMs: 60_000 }, scope },
  ])
  await assert.rejects(plane.run(['auth', 'token'], { cwd: '/work/widgets' }, scope), /only the Git plugin’s/)
})

test('the sentence is told only while the tools it names are offered', () => {
  assert.equal(new ForgePlane(port(true)).instructions(), FORGE_INSTRUCTION)
  assert.equal(new ForgePlane(port(false)).instructions(), '')
  assert.match(FORGE_INSTRUCTION, /pr_create, pr_update and pr_review/)
  assert.ok(!FORGE_INSTRUCTION.includes('\n'), 'one sentence, not a briefing')
})
