import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  runtimeId,
  SessionBusyError,
  sessionId,
  type Page,
  type Session,
  type SessionSummary,
} from '@harnessdesk/protocol'

import { Host, StateStore, serve } from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, silent } from './fixtures/harness.js'

/**
 * Two accounts of one agent, over one shelf of conversations.
 *
 * Agents that keep their conversations in files on the machine allow one live
 * writer each, and two accounts of such an agent are two processes over the
 * same files — so a conversation *listed* by one account can be *held* by the
 * other. Before this, the list said the lister owned every row, opening one
 * the other account held was refused, and the refusal named neither account:
 * it quoted the agent's own words about writers and locks.
 *
 * Neither process can see the other's live handles. This host runs both, so
 * it is the only thing that can.
 */

const PRIMARY = runtimeId('fake')
const SLOT = runtimeId('fake-2')
const STORE = '/home/agent/sessions'

interface TwoAccounts {
  readonly host: Host
  readonly server: Awaited<ReturnType<typeof serve>>
  readonly primary: FakeRuntime
  readonly slot: FakeRuntime
  readonly stateDir: string
}

/** One agent, two accounts — sharing a store unless a suite says otherwise. */
const twoAccounts = async (
  options: { readonly shareStore?: boolean } = {},
): Promise<TwoAccounts> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-holder-'))
  const share = options.shareStore ?? true
  const primary = new FakeRuntime({
    id: PRIMARY,
    accountLabel: 'work',
    ...(share ? { sessionStore: STORE } : {}),
  })
  const slot = new FakeRuntime({
    id: SLOT,
    name: 'Fake Runtime',
    accountLabel: 'Shane-OL',
    // The point of the fixture: a second account is a second runtime, and its
    // conversations are the same files unless the test says they are not.
    ...(share ? { sessionStore: STORE } : { sessionStore: '/somewhere/else' }),
  })
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(primary)
  host.register(slot)
  await host.start()
  const server = await serve({ host, logger: silent, port: 0 })
  return { host, server, primary, slot, stateDir }
}

const close = async (rig: TwoAccounts): Promise<void> => {
  await rig.server.close()
  await rig.host.dispose()
  await rm(rig.stateDir, { recursive: true, force: true })
}

/**
 * A conversation open on the slot account and listed by the primary — which
 * is what the shared store makes of it, because only one account lists.
 */
const heldBySlot = async (rig: TwoAccounts, client: Client): Promise<Session> => {
  const session = (await client.call('session/create', {
    runtime: SLOT,
    options: { cwd: '/w' },
  })) as Session
  rig.primary.history.push({
    id: session.id,
    runtime: PRIMARY,
    title: 'help me to perform code review',
    preview: 'code review',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
  } as SessionSummary)
  return session
}

test('a row the other account is holding is listed as that account’s', async (t) => {
  const rig = await twoAccounts()
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const session = await heldBySlot(rig, client)

  const page = (await client.call('session/list', { runtime: PRIMARY })) as Page<SessionSummary>
  const row = page.data.find((entry) => entry.id === session.id)
  assert.equal(row?.runtime, SLOT, 'the row should be addressed to whoever can open it')
  // And clicking it lands: the account that holds it can always take it back.
  const resumed = (await client.call('session/resume', {
    runtime: SLOT,
    sessionId: session.id,
  })) as Session
  assert.equal(resumed.id, session.id)
})

test('search is addressed the same way as the list', async (t) => {
  const rig = await twoAccounts()
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const session = await heldBySlot(rig, client)

  const page = (await client.call('session/search', {
    runtime: PRIMARY,
    query: 'code review',
  })) as Page<SessionSummary>
  assert.equal(page.data.find((entry) => entry.id === session.id)?.runtime, SLOT)
})

test('a row nobody is holding stays with the account that listed it', async (t) => {
  const rig = await twoAccounts()
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const session = await heldBySlot(rig, client)

  // Closing the pane hands the conversation back; the row is the lister's
  // again, and either account may open it.
  await client.call('session/close', { runtime: SLOT, sessionId: session.id })
  const page = (await client.call('session/list', { runtime: PRIMARY })) as Page<SessionSummary>
  assert.equal(page.data.find((entry) => entry.id === session.id)?.runtime, PRIMARY)
})

test('accounts that do not share a store are not each other’s business', async (t) => {
  const rig = await twoAccounts({ shareStore: false })
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const session = await heldBySlot(rig, client)

  // Same id under two agents means two different conversations — an ACP agent
  // numbers its sessions from one — so re-addressing here would open a
  // stranger's transcript under the right-looking title.
  const page = (await client.call('session/list', { runtime: PRIMARY })) as Page<SessionSummary>
  assert.equal(page.data.find((entry) => entry.id === session.id)?.runtime, PRIMARY)
})

test('a conversation held elsewhere is refused by name, with a code to act on', async (t) => {
  const rig = await twoAccounts()
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const session = await heldBySlot(rig, client)

  // The layout restores a pane addressed to the primary — the one path that
  // still reaches an account that cannot have it.
  rig.primary.resumeFailure = new SessionBusyError(
    'This conversation is open in another Fake Runtime, which is the only one that can continue it.',
  )
  const failure = await client
    .call('session/resume', { runtime: PRIMARY, sessionId: session.id })
    .then(() => null, (error: unknown) => error as Error & { code?: string })

  assert.ok(failure, 'the primary must not claim a conversation it cannot write')
  assert.equal(failure.code, 'sessionBusy')
  // The account is named as the user named it, not as the agent is named:
  // both accounts are called "Fake Runtime", and only one of them has it.
  assert.match(failure.message, /Shane-OL/)
  assert.doesNotMatch(failure.message, /active writer/)
})

test('an account too busy to say its own name still gets the refusal out', async (t) => {
  const rig = await twoAccounts()
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())
  const session = await heldBySlot(rig, client)

  // The account holding the conversation is by definition busy, and asking a
  // wedged app-server for its label must cost a better sentence rather than
  // the sentence. `catch` covers a call that throws; this covers one that
  // never answers at all.
  rig.slot.getAccount = () => new Promise(() => {})
  rig.primary.resumeFailure = new SessionBusyError('held by another writer')

  const started = Date.now()
  const failure = await client
    .call('session/resume', { runtime: PRIMARY, sessionId: session.id })
    .then(() => null, (error: unknown) => error as Error & { code?: string })

  assert.ok(failure)
  assert.equal(failure.code, 'sessionBusy')
  // The agent's own name is the fallback when the account cannot give one.
  assert.match(failure.message, /Fake Runtime/)
  assert.ok(Date.now() - started < 4_000, 'the refusal must not wait on a hung account')
})

test('a refusal that is not about writers keeps its own explanation', async (t) => {
  const rig = await twoAccounts()
  t.after(() => close(rig))
  const client = await Client.connect(rig.server)
  t.after(() => client.close())

  rig.primary.resumeFailure = new Error('Session not found')
  const failure = await client
    .call('session/resume', { runtime: PRIMARY, sessionId: sessionId('gone') })
    .then(() => null, (error: unknown) => error as Error & { code?: string })

  assert.ok(failure)
  assert.notEqual(failure.code, 'sessionBusy')
  assert.match(failure.message, /could not reopen this conversation: Session not found/)
})
