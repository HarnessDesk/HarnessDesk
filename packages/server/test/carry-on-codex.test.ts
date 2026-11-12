import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { HANDOFF_PREFIX, runtimeId, type CarryOnIncidentView, type CarryOnItem, type Session } from '@harnessdesk/protocol'

import { Host, StateStore, serve } from '../src/index.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, silent } from './fixtures/harness.js'

/**
 * Carry-on end to end, the way the window drives it: a real Codex adapter over
 * the scripted Codex in its limit mode, whose every turn ends on the account's
 * usage limit, and a second agent to carry the conversation on to. The calls
 * are the ones the carry-on card makes — `carryOn/list` on connect, then
 * `carryOn/decide` with the Switch button's target — and the rule "Always do
 * this" saves is the one the next limit follows without asking.
 */

const FAKE = fileURLToPath(new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url))
const CODEX = runtimeId('codex')
const OTHER = runtimeId('other')

interface Rig {
  readonly client: Client
  readonly other: FakeRuntime
  readonly sent: { session: string; text: string }[]
  readonly cwd: string
}

const rig = async (t: TestContext): Promise<Rig> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-carry-on-codex-'))
  const codexHome = join(stateDir, 'codex-home')
  const cwd = join(stateDir, 'work')
  await mkdir(codexHome, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const codex = new CodexRuntime({ id: CODEX, codexHome, binaryPath: FAKE, env: { FAKE_CODEX_MODE: 'limit' } })
  const other = new FakeRuntime({ id: OTHER, name: 'Other Agent', accountLabel: 'Jane Doe' })
  // Each runtime is an agent of its own: the switch is to another agent, with a handoff.
  const accounts = {
    canAdd: () => false,
    slotOf: () => null,
    add: async () => { throw new Error('unused') },
    remove: async () => { throw new Error('unused') },
  }
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), version: '9.9.9', accounts } as never)
  host.register(codex)
  host.register(other)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  const client = await Client.connect(server)
  t.after(async () => {
    await client.close()
    await server.close()
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const sent: Rig['sent'] = []
  other.onSend = (session, text) => { sent.push({ session: String(session.id), text }) }
  return { client, other, sent, cwd }
}

/** The desk rule, as Settings › Carry-on writes it. */
const prefer = (r: Rig, onLimit: 'ask' | 'switch') =>
  r.client.call('app/state/set', { patch: { carryOn: { onLimit, otherAgents: true } } })

/** A Codex conversation whose first turn runs into the account's usage limit. */
const limited = async (r: Rig, text: string): Promise<Session> => {
  const session = (await r.client.call('session/create', { runtime: CODEX, options: { cwd: r.cwd } })) as Session
  await r.client.call('turn/send', { runtime: CODEX, sessionId: session.id, input: [{ type: 'text', text }] })
  return session
}

const changes = (r: Rig): CarryOnIncidentView[] => r.client.notifications.flatMap(message =>
  'method' in message && message.method === 'carryOn/changed' ? [(message.params as { incident: CarryOnIncidentView | null }).incident ?? []].flat() : [])

const of = (session: Session) => (incident: CarryOnIncidentView) => incident.runtime === CODEX && incident.sessionId === session.id

const list = async (r: Rig): Promise<CarryOnIncidentView[]> =>
  ((await r.client.call('carryOn/list', {})) as { incidents: CarryOnIncidentView[] }).incidents

const markers = (session: Session): CarryOnItem[] =>
  session.turns.flatMap(turn => turn.items.filter((item): item is CarryOnItem => item.type === 'carryOn'))

test('a Codex turn that hits its limit is asked about, the card’s Switch moves it to the target, and it continues there', async t => {
  const r = await rig(t)
  await prefer(r, 'ask')
  const session = await limited(r, 'Fix the failing build on main.')

  await r.client.until(() => changes(r).some(one => of(session)(one) && one.state === 'asked'), 10_000, 'the question')
  // What the card reads on connect: the incident, asked, offering the other agent.
  const listed = (await list(r)).filter(of(session))
  assert.equal(listed.length, 1, 'the incident lists once')
  const asked = listed[0]!
  assert.equal(asked.state, 'asked')
  assert.equal(asked.owner, 'chat')
  assert.equal(asked.choices.target?.runtime, OTHER, 'the card offers the other agent')
  assert.equal(r.sent.length, 0, 'nothing moves before the answer')

  // The card's Switch: the offered target, named; not "Always".
  const answered = (await r.client.call('carryOn/decide', {
    incidentId: asked.incidentId, choice: 'switch', target: asked.choices.target!.runtime, always: false,
  })) as { incident: CarryOnIncidentView }
  assert.notEqual(answered.incident.state, 'asked', 'the answer is taken')

  await r.client.until(() => r.sent.some(one => one.text.includes(HANDOFF_PREFIX)), 10_000, 'the handoff on the other agent')
  const packet = r.sent.find(one => one.text.includes(HANDOFF_PREFIX))!
  assert.match(packet.text, /Fix the failing build on main\./, 'the conversation goes on from what was asked')
  await r.client.until(() => changes(r).some(one => of(session)(one) && one.state === 'moved'), 10_000, 'the moved incident')
  const moved = changes(r).findLast(one => of(session)(one) && one.state === 'moved')!
  assert.equal(moved.mode, 'handoff')
  assert.equal(moved.link?.runtime, OTHER)
  assert.equal(String(moved.link?.sessionId), packet.session, 'the card links to where it went on')

  // The conversation continues: the other agent has it open, with its first turn, and it points back.
  const continued = (await r.client.call('session/read', { runtime: OTHER, sessionId: packet.session as never })) as Session
  assert.ok(continued.turns.length >= 1, 'the other agent took a turn')
  assert.deepEqual(markers(continued).find(one => one.phase === 'arrived')?.link, { runtime: CODEX, sessionId: session.id })
  assert.deepEqual((await list(r)).filter(of(session)), [], 'and nothing is left to answer')
})

test('“Always do this” saves the rule, and the next limit switches without asking', async t => {
  const r = await rig(t)
  await prefer(r, 'ask')
  const first = await limited(r, 'Fix the failing build on main.')
  await r.client.until(() => changes(r).some(one => of(first)(one) && one.state === 'asked'), 10_000, 'the first question')
  const [asked] = (await list(r)).filter(of(first))
  assert.ok(asked)
  assert.equal(asked.alwaysScope, 'desk', 'with no rule of the agent’s own, "Always" is the desk’s rule')

  await r.client.call('carryOn/decide', { incidentId: asked.incidentId, choice: 'switch', target: asked.choices.target!.runtime, always: true })
  await r.client.until(() => r.sent.length === 1, 10_000, 'the first handoff')
  const state = (await r.client.call('app/state/get', {})) as { carryOn?: { onLimit?: string } }
  assert.equal(state.carryOn?.onLimit, 'switch', 'the answer became the desk rule')

  const second = await limited(r, 'Now update the release notes.')
  await r.client.until(() => r.sent.length === 2, 10_000, 'the second handoff')
  assert.match(r.sent[1]!.text, /Now update the release notes\./)
  await r.client.until(() => changes(r).some(one => of(second)(one) && one.state === 'moved'), 10_000, 'the second moved incident')
  assert.ok(!changes(r).some(one => of(second)(one) && one.state === 'asked'), 'the second limit was never asked about')
  assert.deepEqual((await list(r)).filter(of(second)), [], 'and nothing waits on the person')
})
