import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import type { AgentRuntime, RuntimeInfo } from '@harnessdesk/protocol'

import {
  AccountSlots,
  accountIdentity,
  gatewayPrivateEntries,
  linkHome,
  slotHasCredential,
  writeGatewayConfig,
} from '../src/accounts.js'
import { Host, Logger, StateStore, type AccountFactory } from '../src/index.js'
import { FAKE_RUNTIME_ID, FakeRuntime } from './fixtures/fake-runtime.js'

/**
 * More than one account of one agent.
 *
 * The mechanism under test is the credential home: a symlink farm over the
 * agent's real home that keeps everything shared except `auth.json`. Measured
 * against Codex 0.149.0 before it was written — two app-servers over such a
 * pair list the same threads and only one of them is signed in — so what these
 * tests hold is the farm's own contract, not Codex's behaviour.
 */

const silent = new Logger('test', { level: 'error', console: false })

const home = async (): Promise<string> => mkdtemp(join(tmpdir(), 'harnessdesk-accounts-'))

test('a credential home shares everything except the credential', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(join(primary, 'sessions'), { recursive: true })
  await writeFile(join(primary, 'sessions', 'one.jsonl'), 'thread\n')
  await writeFile(join(primary, 'config.toml'), 'model = "x"\n')
  await writeFile(join(primary, 'auth.json'), '{"token":"primary"}')

  const slot = join(root, 'slot')
  linkHome(primary, slot)

  // The session store is the same file on disk, not a copy: this is what lets
  // every account of one agent open every one of that agent's threads.
  assert.equal(await readFile(join(slot, 'sessions', 'one.jsonl'), 'utf8'), 'thread\n')
  assert.equal(await readlink(join(slot, 'sessions')), join(primary, 'sessions'))
  assert.equal(await readFile(join(slot, 'config.toml'), 'utf8'), 'model = "x"\n')

  // The credential is the one thing that is not shared — the whole point.
  assert.equal(slotHasCredential(slot), false)
  await assert.rejects(() => stat(join(slot, 'auth.json')))

  // Writing the slot's own credential leaves the agent's alone.
  await writeFile(join(slot, 'auth.json'), '{"token":"second"}')
  assert.equal(slotHasCredential(slot), true)
  assert.equal(await readFile(join(primary, 'auth.json'), 'utf8'), '{"token":"primary"}')
})

/**
 * The one thing sharing a home is *for*, beyond the credential.
 *
 * Codex keeps one `flock` per conversation in `thread-writer-locks` so that
 * exactly one process is ever appending to a thread's rollout. A slot farmed
 * before the agent had ever opened a conversation would find no directory to
 * link, make its own, and leave two accounts each certain they were the only
 * writer — two processes appending to one file. So the directory is created
 * in order to be shared.
 */
test('the lock directory is shared even before the agent has made one', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'config.toml'), 'model = "x"\n')

  const slot = join(root, 'slot')
  linkHome(primary, slot)

  assert.equal(await readlink(join(slot, 'thread-writer-locks')), join(primary, 'thread-writer-locks'))
  // A lock one account takes is a file the other can see, which is the whole
  // point: the operating system refuses the second writer.
  await writeFile(join(primary, 'thread-writer-locks', 'thread-1.lock'), '')
  assert.equal((await stat(join(slot, 'thread-writer-locks', 'thread-1.lock'))).isFile(), true)

  // And a second account of the same agent lands on the same directory.
  const other = join(root, 'slot-2')
  linkHome(primary, other)
  assert.equal(await readlink(join(other, 'thread-writer-locks')), join(primary, 'thread-writer-locks'))
})

test('relinking picks up new files and repairs a link the agent overwrote', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'config.toml'), 'first\n')
  const slot = join(root, 'slot')
  linkHome(primary, slot)

  // A file the agent rewrites atomically lands as a real file where the link
  // was; left alone the slot would quietly drift into a private copy.
  await rm(join(slot, 'config.toml'))
  await writeFile(join(slot, 'config.toml'), 'diverged\n')
  await writeFile(join(primary, 'config.toml'), 'second\n')
  await writeFile(join(primary, 'skills.json'), '[]')
  linkHome(primary, slot)
  assert.equal(await readFile(join(slot, 'config.toml'), 'utf8'), 'second\n')
  assert.equal(await readFile(join(slot, 'skills.json'), 'utf8'), '[]')

  // And a link to something the agent no longer has is pruned, because a
  // dangling `config.toml` reads worse than an absent one.
  await rm(join(primary, 'skills.json'))
  linkHome(primary, slot)
  await assert.rejects(() => stat(join(slot, 'skills.json')))
})

test('removing a slot never reaches the files it only linked to', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(join(primary, 'sessions'), { recursive: true })
  await writeFile(join(primary, 'sessions', 'one.jsonl'), 'thread\n')

  const slots = new AccountSlots(join(root, 'accounts.json'))
  const slot = slots.add(FAKE_RUNTIME_ID, primary, root)
  assert.equal(slots.of(FAKE_RUNTIME_ID).length, 1)
  assert.equal(await readFile(join(slot.home, 'sessions', 'one.jsonl'), 'utf8'), 'thread\n')

  slots.remove(slot.id)
  assert.equal(slots.of(FAKE_RUNTIME_ID).length, 0)
  await assert.rejects(() => stat(slot.home))
  assert.equal(await readFile(join(primary, 'sessions', 'one.jsonl'), 'utf8'), 'thread\n')
})

test('a slot nobody finished signing into is dropped on the next start', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  const slots = new AccountSlots(join(root, 'accounts.json'))

  const abandoned = slots.add(FAKE_RUNTIME_ID, primary, root)
  const used = slots.add(FAKE_RUNTIME_ID, primary, root)
  await writeFile(join(used.home, 'auth.json'), '{"token":"second"}')

  // Otherwise a change of mind leaves a "Not connected" row behind, one per
  // click, which is what made adding an account feel broken.
  assert.deepEqual([...slots.pruneEmpty(FAKE_RUNTIME_ID)], [abandoned.id])
  assert.deepEqual(
    slots.of(FAKE_RUNTIME_ID).map((slot) => slot.id),
    [used.id],
  )
  await assert.rejects(() => stat(abandoned.home))
  assert.equal(slots.pruneEmpty(FAKE_RUNTIME_ID).length, 0)
})

/* --- one account, signed in twice ----------------------------------------- */

/**
 * The shape of a ChatGPT credential, as Codex 0.149.0 writes it: an OIDC id
 * token whose `sub` is the person and whose `chatgpt_account_id` is the
 * workspace. Written here rather than fixtured from a real file because a real
 * one is a live credential; every field these tests read is reproduced.
 */
const chatgptAuth = (
  subject: string,
  workspace: string | null,
  token = 'access',
  /** Where the workspace is written, since Codex puts it in both places. */
  carry: 'both' | 'claim' | 'tokenField' = 'both',
): string => {
  const claim = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const scoped: Record<string, unknown> = { chatgpt_plan_type: 'team' }
  if (workspace !== null && carry !== 'tokenField') scoped['chatgpt_account_id'] = workspace
  const idToken = [
    claim({ alg: 'RS256' }),
    claim({ sub: subject, email: `${subject}@example.com`, 'https://api.openai.com/auth': scoped }),
    'not-a-real-signature',
  ].join('.')
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      access_token: token,
      refresh_token: `${token}-r`,
      id_token: idToken,
      ...(workspace !== null && carry !== 'claim' ? { account_id: workspace } : {}),
    },
  })
}

test('an identity is the person and the workspace, never the email alone', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const at = async (name: string, body: string): Promise<string> => {
    const where = join(root, name)
    await mkdir(where, { recursive: true })
    await writeFile(join(where, 'auth.json'), body)
    return where
  }

  // Two sign-ins of one account: different tokens every time, same person.
  const first = await at('first', chatgptAuth('user-a', 'workspace-1', 'one'))
  const again = await at('again', chatgptAuth('user-a', 'workspace-1', 'two'))
  assert.equal(accountIdentity(first), accountIdentity(again))

  // The same person in a second ChatGPT workspace is a second account, with
  // its own limits — folding those together would delete a real account.
  const elsewhere = await at('elsewhere', chatgptAuth('user-a', 'workspace-2'))
  assert.notEqual(accountIdentity(first), accountIdentity(elsewhere))

  // Two people in one workspace are two accounts too, which is why an email
  // and a workspace are both needed and neither is enough.
  const colleague = await at('colleague', chatgptAuth('user-b', 'workspace-1'))
  assert.notEqual(accountIdentity(first), accountIdentity(colleague))

  // Nothing readable is "cannot tell", which is never "the same".
  assert.equal(accountIdentity(join(root, 'nowhere')), null)
  assert.equal(accountIdentity(await at('empty', 'not json')), null)
  assert.equal(accountIdentity(await at('anonymous', '{"tokens":{"access_token":"x"}}')), null)

  // An API-key home has no token; the key is the identity, and is hashed
  // rather than kept — the fingerprint must not contain it.
  const keyed = await at('keyed', '{"OPENAI_API_KEY":"sk-secret","auth_mode":"apiKey"}')
  const keyedAgain = await at('keyed-again', '{"OPENAI_API_KEY":"sk-secret"}')
  assert.equal(accountIdentity(keyed), accountIdentity(keyedAgain))
  assert.ok(!String(accountIdentity(keyed)).includes('sk-secret'))
  assert.notEqual(accountIdentity(keyed), accountIdentity(await at('other-key', '{"OPENAI_API_KEY":"sk-other"}')))
})

test('a credential with no workspace is "cannot tell", never "the same"', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const at = async (name: string, body: string): Promise<string> => {
    const where = join(root, name)
    await mkdir(where, { recursive: true })
    await writeFile(join(where, 'auth.json'), body)
    return where
  }

  // Codex documents the claim as optional — "this may be `null` when the prior
  // auth state did not include a workspace identifier" — so a token can arrive
  // with a person and no workspace. Two of those are not knowably one account:
  // they could be the same person's two workspaces, which is exactly the pair
  // this whole function exists to keep apart. Folding them would delete a real
  // account, so the answer is null and both rows stay.
  const one = await at('one', chatgptAuth('user-a', null, 'first'))
  const two = await at('two', chatgptAuth('user-a', null, 'second'))
  assert.equal(accountIdentity(one), null)
  assert.equal(accountIdentity(two), null)

  // Either place Codex writes the workspace is enough — it copies the claim
  // into `tokens.account_id`, so a file carrying only one of them is still
  // fully identified, and identified the same way.
  const claimOnly = await at('claim', chatgptAuth('user-a', 'workspace-1', 'a', 'claim'))
  const fieldOnly = await at('field', chatgptAuth('user-a', 'workspace-1', 'b', 'tokenField'))
  assert.notEqual(accountIdentity(claimOnly), null)
  assert.equal(accountIdentity(claimOnly), accountIdentity(fieldOnly))

  // And a workspaceless credential is never folded into a complete one.
  assert.notEqual(accountIdentity(one), accountIdentity(claimOnly))
})

test('two accounts with no workspace between them are both left alone', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', null, 'first'))
  const slots = new AccountSlots(join(root, 'accounts.json'))

  const slot = slots.add(FAKE_RUNTIME_ID, primary, root)
  await writeFile(join(slot.home, 'auth.json'), chatgptAuth('user-a', null, 'second'))

  // The sweep is not allowed to guess. A duplicate row is the bug still being
  // visible; a wrong fold is an account gone.
  assert.deepEqual([...slots.pruneDuplicates(FAKE_RUNTIME_ID, primary)], [])
  assert.deepEqual(
    slots.of(FAKE_RUNTIME_ID).map((entry) => entry.id),
    [slot.id],
  )
})

test('a slot signed in as somebody the user already is gets folded away', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))
  const slots = new AccountSlots(join(root, 'accounts.json'))

  const copy = slots.add(FAKE_RUNTIME_ID, primary, root)
  await writeFile(join(copy.home, 'auth.json'), chatgptAuth('user-a', 'workspace-1', 'fresh'))
  const second = slots.add(FAKE_RUNTIME_ID, primary, root)
  await writeFile(join(second.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1'))
  const third = slots.add(FAKE_RUNTIME_ID, primary, root)
  await writeFile(join(third.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'copy'))

  // The agent's own account wins, then the oldest slot: the copy of the
  // primary goes, and of the two `user-b` rows the first one stays.
  assert.deepEqual([...slots.pruneDuplicates(FAKE_RUNTIME_ID, primary)], [copy.id, third.id])
  assert.deepEqual(
    slots.of(FAKE_RUNTIME_ID).map((slot) => slot.id),
    [second.id],
  )
  await assert.rejects(() => stat(copy.home))

  // The credential the fold dropped is one the surviving account still holds:
  // the agent's own home must be untouched by the repair.
  assert.equal(await readFile(join(primary, 'auth.json'), 'utf8'), chatgptAuth('user-a', 'workspace-1'))
  assert.equal(slots.pruneDuplicates(FAKE_RUNTIME_ID, primary).length, 0)
})

test('a gateway account is never folded into the plan account beside it', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))
  const slots = new AccountSlots(join(root, 'accounts.json'))

  // It has no `auth.json` at all — its key is the broker's — so it can never
  // match anything, which is what keeps `pruneDuplicates` off it.
  const paid = slots.add(FAKE_RUNTIME_ID, primary, root, {
    name: 'Acme',
    endpoint: 'https://gateway.example',
    credentialRef: 'ref-1',
  })
  assert.equal(accountIdentity(paid.home), null)
  assert.deepEqual([...slots.pruneDuplicates(FAKE_RUNTIME_ID, primary)], [])
  assert.deepEqual(
    slots.of(FAKE_RUNTIME_ID).map((slot) => slot.id),
    [paid.id],
  )
})

test('the roster survives a restart, and an unreadable one is not fatal', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  const file = join(root, 'accounts.json')

  const first = new AccountSlots(file)
  const slot = first.add(FAKE_RUNTIME_ID, primary, root)
  assert.deepEqual([...new AccountSlots(file).list()], [slot])

  await writeFile(file, 'not json')
  assert.deepEqual([...new AccountSlots(file).list()], [])
})

/** A host whose fake agent can hold more than one account. */
const hostWithAccounts = async (options: {
  /**
   * Every account this factory makes plays an agent that cannot answer for
   * itself until it has started — which is what Codex does, and what a caller
   * that acts on a fresh account id runs into.
   */
  readonly newAccountsNeedStart?: boolean
  /** How long a new account takes to start, when `newAccountsNeedStart` is set. */
  readonly newAccountStartMs?: number
  /** Passed straight to the host, so a test can make the deadline short. */
  readonly startTimeoutMs?: number
} = {}): Promise<{
  host: Host
  stateDir: string
  primary: string
  slots: AccountSlots
  accounts: AccountFactory
  /** Every runtime the factory made, so a test can drive one directly. */
  created: Map<string, FakeRuntime>
  own: FakeRuntime
}> => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-accounts-host-'))
  const primary = join(stateDir, 'agent')
  await mkdir(primary, { recursive: true })
  const slots = new AccountSlots(join(stateDir, 'accounts.json'))
  const created = new Map<string, FakeRuntime>()
  const accounts: AccountFactory = {
    canAdd: (info: RuntimeInfo) => info.id === FAKE_RUNTIME_ID || slots.find(info.id) !== null,
    slotOf: (info: RuntimeInfo) => {
      if (info.id !== FAKE_RUNTIME_ID && !slots.find(info.id)) return null
      const slot = slots.find(info.id)
      return slot
        ? {
            agent: slot.agent,
            home: slot.home,
            removable: true,
            ...(slot.gateway ? { gateway: { ...slot.gateway } } : {}),
          }
        : { agent: FAKE_RUNTIME_ID, home: primary, removable: false }
    },
    add: async (info: RuntimeInfo, gateway): Promise<AgentRuntime> => {
      const slot = slots.add(slots.find(info.id)?.agent ?? info.id, primary, stateDir, gateway)
      // A label per slot, so a test can tell which row a notice named.
      const runtime = new FakeRuntime({
        id: slot.id,
        name: 'Fake Runtime',
        accountLabel: `slot-${created.size + 1}@example.com`,
      })
      if (options.newAccountsNeedStart) {
        runtime.accountNeedsStart = true
        runtime.signInDriveable = true
        if (options.newAccountStartMs !== undefined) runtime.startDelayMs = options.newAccountStartMs
      }
      created.set(slot.id, runtime)
      return runtime
    },
    remove: async (id: RuntimeInfo['id']) => {
      slots.remove(id)
    },
    identityOf: (info: RuntimeInfo) => {
      const slot = slots.find(info.id)
      if (slot?.gateway) return null
      return accountIdentity(slot?.home ?? primary)
    },
    prepare: async (id, resolved) => {
      const slot = slots.find(id)
      if (!slot?.gateway) return
      writeGatewayConfig(slot.home, resolved.name, resolved.endpoint)
    },
  }
  const host = new Host({
    logger: silent,
    accounts,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
  })
  const own = new FakeRuntime({ accountLabel: 'olivia@example.com' })
  host.register(own)
  await host.start()
  return { host, stateDir, primary, slots, accounts, created, own }
}

test('adding an account registers a second runtime and tells every client', async (t) => {
  const { host, stateDir } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const seen: string[] = []
  host.addBroadcaster((notification) => seen.push(notification.method))

  const before = host.syncPayload().params.runtimes
  assert.equal(before.length, 1)
  assert.equal(before[0]?.slot?.removable, false)
  assert.equal(before[0]?.slot?.canAdd, true)

  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  assert.notEqual(added.runtime, FAKE_RUNTIME_ID)
  assert.equal(added.info.slot?.agent, FAKE_RUNTIME_ID)
  assert.equal(added.info.slot?.removable, true)
  assert.ok(seen.includes('runtime/added'))

  // The original account is still there — the bug this whole thing fixes is a
  // second sign-in replacing the first.
  const after = host.syncPayload().params.runtimes.map((info) => info.id)
  assert.deepEqual([...after].sort(), [FAKE_RUNTIME_ID, added.runtime].sort())
})

test('an added account can be signed in the moment the add answers', async (t) => {
  // The bug this pins: the host answered `runtime/account/add` with the new
  // id while that account's agent was still starting. The interface's very
  // next act is to sign the account in — and Codex answers neither
  // `account/read` nor `account/login/start` until its app-server is up, so
  // the sign-in page saw an agent with no way in and the one-click "Add
  // account" started nothing at all, silently. The row was made; that was the
  // whole of what the button did.
  const { host, stateDir } = await hostWithAccounts({ newAccountsNeedStart: true })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })

  const status = await host.call('runtime/account', { runtime: added.runtime })
  assert.deepEqual(
    status.signInMethods.map((method) => method.id),
    ['fake-browser'],
  )
  const login = await host.call('runtime/login', {
    runtime: added.runtime,
    method: 'fake-browser',
  })
  assert.equal(login.type, 'browser')
})

test('an account whose agent will not start still arrives, with the row and the reason', async (t) => {
  // The other half of the bargain the wait makes. Waiting is bounded — the
  // host gives up *waiting* at `startTimeoutMs` while the attempt runs on —
  // so an agent that hangs on boot costs the deadline and not the account:
  // the row was pushed before the wait, it is registered when the call
  // answers, and its health is what says why it is not ready. Without this
  // the promise in `#addAccount`'s comment is only a comment.
  const { host, stateDir } = await hostWithAccounts({
    newAccountsNeedStart: true,
    newAccountStartMs: 600,
    startTimeoutMs: 30,
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const seen: string[] = []
  host.addBroadcaster((notification) => seen.push(notification.method))

  const started = Date.now()
  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })

  // It answered on the deadline rather than on the start. The gap is wide
  // enough that a slow machine cannot make a passing run look like a failing
  // one, and narrow enough that the suite does not sit through the start.
  const waited = Date.now() - started
  assert.ok(waited < 400, `the add waited ${waited}ms — that is the start, not the deadline`)
  assert.ok(seen.includes('runtime/added'))
  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id).sort(),
    [FAKE_RUNTIME_ID, added.runtime].sort(),
  )
})

test('removing an account unregisters it and forgets its home', async (t) => {
  const { host, stateDir, slots } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  const seen: string[] = []
  host.addBroadcaster((notification) => seen.push(notification.method))

  await host.call('runtime/account/remove', { runtime: added.runtime })
  assert.ok(seen.includes('runtime/removed'))
  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(slots.list().length, 0)
})

test('a sign-in that lands on the account you already have is undone, with a reason', async (t) => {
  const { host, stateDir, primary, slots, created } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  const seen: { method: string; params?: unknown }[] = []
  host.addBroadcaster((notification) => seen.push(notification))

  // The browser came back and Codex wrote the credential — and it is the
  // credential the agent's own account is already using.
  const slot = slots.find(added.runtime)
  assert.ok(slot)
  await writeFile(join(slot.home, 'auth.json'), chatgptAuth('user-a', 'workspace-1', 'fresh'))
  created.get(added.runtime)?.emit({
    type: 'account/loginCompleted',
    runtime: added.runtime,
    loginId: 'login-1',
    success: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(slots.list().length, 0)
  assert.ok(seen.some((notification) => notification.method === 'runtime/removed'))

  // Taking the row away silently would read as the sign-in having failed. It
  // did not fail; it just did not add anything, and the message says so.
  const notice = seen.find(
    (notification) =>
      notification.method === 'event' &&
      (notification.params as { event: { type: string } }).event.type === 'notice',
  )
  assert.ok(notice, 'the fold explains itself')
  assert.match(
    (notice.params as { event: { message: string } }).event.message,
    /already signed in .* as olivia@example\.com/,
  )
})

test('a second account of a different person is left exactly where it is', async (t) => {
  const { host, stateDir, primary, slots, created } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  const slot = slots.find(added.runtime)
  assert.ok(slot)
  await writeFile(join(slot.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1'))
  created.get(added.runtime)?.emit({
    type: 'account/loginCompleted',
    runtime: added.runtime,
    loginId: 'login-1',
    success: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(
    [...host.syncPayload().params.runtimes.map((info) => info.id)].sort(),
    [FAKE_RUNTIME_ID, added.runtime].sort(),
  )
  assert.equal(slots.list().length, 1)
})

test("signing the agent's own account back in folds the second account instead", async (t) => {
  const { host, stateDir, primary, slots, created, own } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  const second = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(second.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1'))

  // The user signs out of their own account and back in — as the person the
  // second account already is. The duplicate is now the second account, and
  // the agent's own row cannot be removed, so that is the one that goes.
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'again'))
  own.emit({ type: 'account/loginCompleted', runtime: FAKE_RUNTIME_ID, loginId: 'login-1', success: true })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(slots.list().length, 0)
  // And the account that was folded was not signed out on the way.
  assert.equal(created.get(second.runtime)?.loggedOut, false)
})

test('two duplicates folded together say so once, naming the row that stays', async (t) => {
  const { host, stateDir, primary, slots, created, own } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  const first = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(first.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'one'))
  const secondAccount = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(secondAccount.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'two'))

  const notices: string[] = []
  host.addBroadcaster((notification) => {
    const params = notification.params as { event?: { type: string; message?: string } }
    if (notification.method === 'event' && params.event?.type === 'notice') {
      notices.push(params.event.message ?? '')
    }
  })

  // The user signs their own account back in as `user-b`. Both slots are now
  // copies of it, and both go — but that is one thing that happened.
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'again'))
  own.emit({ type: 'account/loginCompleted', runtime: FAKE_RUNTIME_ID, loginId: 'login-1', success: true })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(slots.list().length, 0)
  assert.equal(notices.length, 1, 'one fold, one sentence')
  assert.match(notices[0] ?? '', /already signed in .* as olivia@example\.com/)
  assert.equal(created.get(first.runtime)?.loggedOut, false)
  assert.equal(created.get(secondAccount.runtime)?.loggedOut, false)
})

test('the notice names the account that survives, not whichever peer was registered first', async (t) => {
  // Built by hand rather than through `hostWithAccounts`, because what this
  // pins is that the choice does not depend on registration order — and that
  // fixture always registers the agent's own account first, which would make
  // `peers[0]` the right answer by accident.
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-accounts-order-'))
  const primary = join(stateDir, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))
  const slots = new AccountSlots(join(stateDir, 'accounts.json'))
  const made = new Map<string, FakeRuntime>()
  const accounts: AccountFactory = {
    canAdd: (info: RuntimeInfo) => info.id === FAKE_RUNTIME_ID || slots.find(info.id) !== null,
    slotOf: (info: RuntimeInfo) => {
      if (info.id !== FAKE_RUNTIME_ID && !slots.find(info.id)) return null
      const slot = slots.find(info.id)
      return slot
        ? { agent: slot.agent, home: slot.home, removable: true }
        : { agent: FAKE_RUNTIME_ID, home: primary, removable: false }
    },
    add: async (info: RuntimeInfo): Promise<AgentRuntime> => {
      const slot = slots.add(slots.find(info.id)?.agent ?? info.id, primary, stateDir)
      const runtime = new FakeRuntime({
        id: slot.id,
        name: 'Fake Runtime',
        accountLabel: `slot-${made.size + 1}@example.com`,
      })
      made.set(slot.id, runtime)
      return runtime
    },
    remove: async (id: RuntimeInfo['id']) => {
      slots.remove(id)
    },
    identityOf: (info: RuntimeInfo) => accountIdentity(slots.find(info.id)?.home ?? primary),
  }
  const host = new Host({
    logger: silent,
    accounts,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  // A slot copied from the agent's own account, registered *before* it, so
  // that it is the first peer anything iterating the runtimes will meet.
  const older = slots.add(FAKE_RUNTIME_ID, primary, stateDir)
  await writeFile(join(older.home, 'auth.json'), chatgptAuth('user-a', 'workspace-1', 'older'))
  const olderRuntime = new FakeRuntime({ id: older.id, name: 'Fake Runtime', accountLabel: 'slot-older@example.com' })
  made.set(older.id, olderRuntime)
  host.register(olderRuntime)
  host.register(new FakeRuntime({ accountLabel: 'olivia@example.com' }))
  await host.start()

  const newer = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(newer.runtime)!.home, 'auth.json'), chatgptAuth('user-a', 'workspace-1', 'newer'))

  const notices: string[] = []
  host.addBroadcaster((notification) => {
    const params = notification.params as { event?: { type: string; message?: string } }
    if (notification.method === 'event' && params.event?.type === 'notice') {
      notices.push(params.event.message ?? '')
    }
  })
  made.get(newer.runtime)?.emit({
    type: 'account/loginCompleted',
    runtime: newer.runtime,
    loginId: 'login-1',
    success: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  // Both peers hold this identity. The row the user is left looking at is the
  // agent's own — it is the one that cannot be removed — so it is the one the
  // sentence has to name, whichever peer the iteration reached first.
  assert.equal(notices.length, 1)
  assert.match(notices[0] ?? '', /as olivia@example\.com/)
  assert.doesNotMatch(notices[0] ?? '', /slot-older@example\.com/)
  assert.deepEqual(
    [...host.syncPayload().params.runtimes.map((info) => info.id)].sort(),
    [FAKE_RUNTIME_ID, older.id].sort(),
  )
})

test('one completion reported twice folds two slots once, not one each', async (t) => {
  const { host, stateDir, primary, slots, own } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  const first = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(first.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'one'))
  const secondAccount = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(secondAccount.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'two'))
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'again'))

  const notices: string[] = []
  host.addBroadcaster((notification) => {
    const params = notification.params as { event?: { type: string; message?: string } }
    if (notification.method === 'event' && params.event?.type === 'notice') {
      notices.push(params.event.message ?? '')
    }
  })

  // Codex can report a completion more than once — a superseded flow finishing
  // beside the real one. With two slots to fold, the second report interleaves
  // *between* the first one's two removals: it finds slot one already gone,
  // takes slot two, and both passes then announce a fold. One sign-in, one
  // sentence, so the second report has to be turned away at the door.
  const completion = {
    type: 'account/loginCompleted' as const,
    runtime: FAKE_RUNTIME_ID,
    loginId: 'login-1',
    success: true,
  }
  own.emit(completion)
  own.emit(completion)
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(slots.list().length, 0)
  assert.equal(notices.length, 1, 'one fold, one sentence')
})

test('two accounts signing in as one person do not each announce the same fold', async (t) => {
  const { host, stateDir, primary, slots, created, own } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(added.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'slot'))
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-b', 'workspace-1', 'own'))

  const notices: string[] = []
  host.addBroadcaster((notification) => {
    const params = notification.params as { event?: { type: string; message?: string } }
    if (notification.method === 'event' && params.event?.type === 'notice') {
      notices.push(params.event.message ?? '')
    }
  })

  // Two different rows completing a sign-in onto one identity. The two folds
  // are keyed to different rows, so the in-flight guard does not turn the
  // second away; what does is that folding a row detaches it, so the
  // completion it reports afterwards reaches nobody. Either way the user is
  // left with one row and told once.
  own.emit({ type: 'account/loginCompleted', runtime: FAKE_RUNTIME_ID, loginId: 'a', success: true })
  created.get(added.runtime)?.emit({
    type: 'account/loginCompleted',
    runtime: added.runtime,
    loginId: 'b',
    success: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.deepEqual(
    host.syncPayload().params.runtimes.map((info) => info.id),
    [FAKE_RUNTIME_ID],
  )
  assert.equal(notices.length, 1, 'one account removed, one sentence')
})

test('an account nothing can name is left out of the sentence, not called "Fake Runtime"', async (t) => {
  const { host, stateDir, primary, slots, created, own } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))
  // The kept account cannot say who it is — `getAccount` answers with none.
  own.loggedOut = true

  const added = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(added.runtime)!.home, 'auth.json'), chatgptAuth('user-a', 'workspace-1', 'copy'))

  const notices: string[] = []
  host.addBroadcaster((notification) => {
    const params = notification.params as { event?: { type: string; message?: string } }
    if (notification.method === 'event' && params.event?.type === 'notice') {
      notices.push(params.event.message ?? '')
    }
  })
  created.get(added.runtime)?.emit({
    type: 'account/loginCompleted',
    runtime: added.runtime,
    loginId: 'login-1',
    success: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(notices.length, 1)
  // "signed in to Fake Runtime as Fake Runtime" reads like a bug, so the
  // clause is dropped rather than filled with the agent's own name.
  assert.doesNotMatch(notices[0] ?? '', /as Fake Runtime/)
  assert.match(notices[0] ?? '', /already signed in to Fake Runtime,/)
})

test('removing a duplicate account never signs the account it copied out', async (t) => {
  const { host, stateDir, primary, slots, created } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await writeFile(join(primary, 'auth.json'), chatgptAuth('user-a', 'workspace-1'))

  // A duplicate that got in before the fold existed: it holds a copy of a
  // credential the agent's own account is still using, so signing it out
  // would revoke the one the user is keeping.
  const twin = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(twin.runtime)!.home, 'auth.json'), chatgptAuth('user-a', 'workspace-1', 'copy'))
  await host.call('runtime/account/remove', { runtime: twin.runtime })
  assert.equal(created.get(twin.runtime)?.loggedOut, false)

  // An account of somebody else is still signed out on the way out, which is
  // what makes removing one mean something.
  const other = await host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID })
  await writeFile(join(slots.find(other.runtime)!.home, 'auth.json'), chatgptAuth('user-b', 'workspace-1'))
  await host.call('runtime/account/remove', { runtime: other.runtime })
  assert.equal(created.get(other.runtime)?.loggedOut, true)
})

test("an agent's own account cannot be removed", async (t) => {
  const { host, stateDir } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await assert.rejects(
    () => host.call('runtime/account/remove', { runtime: FAKE_RUNTIME_ID }),
    /original account/,
  )
})

test('an agent that cannot hold two accounts says so instead of replacing one', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'harnessdesk-accounts-solo-'))
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  host.register(new FakeRuntime())
  await host.start()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  assert.equal(host.syncPayload().params.runtimes[0]?.slot, undefined)
  await assert.rejects(
    () => host.call('runtime/account/add', { runtime: FAKE_RUNTIME_ID }),
    /more than one account/,
  )
})

/* --- gateway accounts ----------------------------------------------------- */

/**
 * An account of the same agent that pays its own way.
 *
 * Everything the plan account gets from the farm it still gets — sessions,
 * skills, state — but `config.toml` is where it is told which endpoint to use,
 * so that one file is private. These hold the two ways that can go wrong: a
 * link left in place would write the gateway into the user's own Codex config,
 * and a slot with no `auth.json` would be swept up as abandoned.
 */

test('a gateway slot keeps its own config and leaves the agent\'s alone', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(join(primary, 'sessions'), { recursive: true })
  await writeFile(join(primary, 'sessions', 'one.jsonl'), 'thread\n')
  await writeFile(join(primary, 'config.toml'), 'model = "mine"\n')

  const slot = join(root, 'slot')
  linkHome(primary, slot, gatewayPrivateEntries)

  // Shared as ever, except the one file that carries the endpoint.
  assert.equal(await readFile(join(slot, 'sessions', 'one.jsonl'), 'utf8'), 'thread\n')
  await assert.rejects(() => stat(join(slot, 'config.toml')))

  writeGatewayConfig(slot, 'Vercel AI Gateway', 'http://127.0.0.1:41234/t/deadbeef')
  const written = await readFile(join(slot, 'config.toml'), 'utf8')
  assert.match(written, /model_provider = "harnessdesk_gateway"/)
  assert.match(written, /base_url = "http:\/\/127\.0\.0\.1:41234\/t\/deadbeef"/)
  // The only value Codex accepts; a provider without it fails at startup.
  assert.match(written, /wire_api = "responses"/)
  // No key, anywhere: the token in the base URL is the whole authorisation.
  assert.doesNotMatch(written, /env_key/)

  // The user's own Codex config is untouched, which is the point.
  assert.equal(await readFile(join(primary, 'config.toml'), 'utf8'), 'model = "mine"\n')

  // And relinking does not put the link back over what was just written.
  linkHome(primary, slot, gatewayPrivateEntries)
  assert.equal(await readFile(join(slot, 'config.toml'), 'utf8'), written)
  assert.equal(await readFile(join(primary, 'config.toml'), 'utf8'), 'model = "mine"\n')
})

test('writing a gateway config replaces a symlink instead of writing through it', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  await writeFile(join(primary, 'config.toml'), 'model = "mine"\n')

  // What a slot promoted from an older roster looks like: linked as an
  // ordinary account, then told it is a gateway one.
  const slot = join(root, 'slot')
  linkHome(primary, slot)
  assert.equal(await readlink(join(slot, 'config.toml')), join(primary, 'config.toml'))

  writeGatewayConfig(slot, 'Gateway', 'http://127.0.0.1:1/t/x')

  // Without the unlink this assertion is the bug: the write follows the link
  // and edits the Codex config the user actually uses.
  assert.equal(await readFile(join(primary, 'config.toml'), 'utf8'), 'model = "mine"\n')
  assert.match(await readFile(join(slot, 'config.toml'), 'utf8'), /harnessdesk_gateway/)
})

test('a gateway slot is complete on arrival and is never swept up as abandoned', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  const slots = new AccountSlots(join(root, 'accounts.json'))

  const abandoned = slots.add(FAKE_RUNTIME_ID, primary, root)
  const gateway = slots.add(FAKE_RUNTIME_ID, primary, root, {
    name: 'Vercel',
    endpoint: 'https://ai-gateway.vercel.sh/codex/v1',
    credentialRef: 'cred_1',
  })

  // It will never have an `auth.json` — its credential is a reference in the
  // broker — so asking after one would delete the account on every start.
  assert.equal(slotHasCredential(gateway.home), false)
  assert.deepEqual([...slots.pruneEmpty(FAKE_RUNTIME_ID)], [abandoned.id])
  assert.deepEqual(
    slots.of(FAKE_RUNTIME_ID).map((slot) => slot.id),
    [gateway.id],
  )
  assert.equal(slots.pruneEmpty(FAKE_RUNTIME_ID).length, 0)
})

test('the roster keeps a gateway across a restart and drops a half-written one', async (t) => {
  const root = await home()
  t.after(() => rm(root, { recursive: true, force: true }))
  const primary = join(root, 'agent')
  await mkdir(primary, { recursive: true })
  const file = join(root, 'accounts.json')

  const slots = new AccountSlots(file)
  const gateway = slots.add(FAKE_RUNTIME_ID, primary, root, {
    name: 'Vercel',
    endpoint: 'https://ai-gateway.vercel.sh/codex/v1',
    credentialRef: 'cred_1',
  })
  assert.deepEqual([...new AccountSlots(file).list()], [gateway])

  // A gateway missing its endpoint would survive `pruneEmpty` as a gateway
  // account and then have nowhere to send a turn. Better an ordinary slot.
  await writeFile(
    file,
    JSON.stringify({
      accounts: [{ id: 'fake-x', agent: FAKE_RUNTIME_ID, home: root, createdAt: 1, gateway: { name: 'x' } }],
    }),
  )
  assert.deepEqual([...new AccountSlots(file).list()], [])
})

test('adding a gateway account brokers the key and never hands it back', async (t) => {
  const { host, stateDir, slots } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })

  const added = await host.call('runtime/account/add', {
    runtime: FAKE_RUNTIME_ID,
    gateway: {
      name: 'Vercel AI Gateway',
      endpoint: 'https://ai-gateway.vercel.sh/codex/v1',
      apiKey: 'vck_secret_value',
    },
  })

  // The row says where it points and what it is called, and stops there.
  assert.equal(added.info.slot?.gateway?.name, 'Vercel AI Gateway')
  assert.equal(added.info.slot?.gateway?.endpoint, 'https://ai-gateway.vercel.sh/codex/v1')

  // The credential reference is the host's business alone: `credentials/delete`
  // takes exactly that value, so it has no place on the wire.
  assert.equal(
    'credentialRef' in (added.info.slot?.gateway ?? {}),
    false,
    'the credential reference must not travel to the renderer',
  )

  // Nor does the key itself appear anywhere in what a client is told.
  assert.doesNotMatch(JSON.stringify(host.syncPayload()), /vck_secret_value/)

  // It is in the broker, under a name that says what it is for, and the slot
  // holds the reference rather than the value.
  const stored = await host.call('credentials/list', {})
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.name, 'Vercel AI Gateway key')
  assert.equal(slots.find(added.runtime)?.gateway?.credentialRef, stored[0]?.ref)
  assert.doesNotMatch(JSON.stringify(stored), /vck_secret_value/)
})

test('removing a gateway account destroys the key it was the only user of', async (t) => {
  const { host, stateDir } = await hostWithAccounts()
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const added = await host.call('runtime/account/add', {
    runtime: FAKE_RUNTIME_ID,
    gateway: { name: 'Vercel', endpoint: 'https://example.test/v1', apiKey: 'k' },
  })
  assert.equal((await host.call('credentials/list', {})).length, 1)

  // Nothing else can reach it once the account is gone, so leaving it behind
  // would be a key on disk that no screen in the app can name or remove.
  await host.call('runtime/account/remove', { runtime: added.runtime })
  assert.deepEqual(await host.call('credentials/list', {}), [])
})

test('a gateway account reaches its upstream with the real key, which it never held', async (t) => {
  const { host, stateDir, slots } = await hostWithAccounts()

  // Stands in for the provider. What it records is the whole point of the
  // gateway: whether the key arrived, and whether the agent ever saw it.
  const seen: { authorization?: string; path?: string; body?: string }[] = []
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.url ? { path: request.url } : {}),
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = (upstream.address() as AddressInfo).port

  t.after(async () => {
    await host.dispose()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(stateDir, { recursive: true, force: true })
  })

  const added = await host.call('runtime/account/add', {
    runtime: FAKE_RUNTIME_ID,
    gateway: {
      name: 'Fake Gateway',
      endpoint: `http://127.0.0.1:${port}/codex/v1`,
      apiKey: 'the-real-key',
    },
  })

  // Codex is told where to go by this file and nothing else, so this is the
  // same address the agent would read out of its own home.
  const written = await readFile(join(slots.find(added.runtime)!.home, 'config.toml'), 'utf8')
  const base = /base_url = "([^"]+)"/.exec(written)?.[1]
  assert.ok(base, 'the gateway account was never pointed anywhere')
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/t\/[0-9a-f]+$/)

  // The key is not in the file the agent reads, which is the property the
  // documented `config.toml` approach gives up.
  assert.doesNotMatch(written, /the-real-key/)

  // Now speak to it exactly as Codex would: `<base>/responses`.
  const answer = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello' }),
  })
  assert.equal(answer.status, 200)
  assert.deepEqual(await answer.json(), { ok: true })

  // It arrived upstream, at the provider's own path, carrying the real key —
  // which was swapped in by the gateway child, not by anything the agent could
  // read. And the model asked for is the model sent: a gateway account does
  // not rewrite what Codex chose.
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.authorization, 'Bearer the-real-key')
  assert.equal(seen[0]?.path, '/codex/v1/responses')
  assert.match(seen[0]?.body ?? '', /"model":"gpt-5\.6-sol"/)
})

test('a gateway account is pointed at a fresh port on every start', async (t) => {
  const { host, stateDir, slots, accounts } = await hostWithAccounts()
  const added = await host.call('runtime/account/add', {
    runtime: FAKE_RUNTIME_ID,
    gateway: { name: 'Gateway', endpoint: 'https://example.test/v1', apiKey: 'k' },
  })
  const home = slots.find(added.runtime)!.home
  const first = /base_url = "([^"]+)"/.exec(await readFile(join(home, 'config.toml'), 'utf8'))?.[1]

  // The loopback port does not survive a restart, so a config written once at
  // creation would send the next run's turns into a closed socket.
  await host.dispose()
  const second = new Host({
    logger: silent,
    accounts,
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
  })
  t.after(async () => {
    await second.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  second.register(new FakeRuntime({ id: added.runtime, name: 'Fake Runtime' }))
  await second.start()

  const after = /base_url = "([^"]+)"/.exec(await readFile(join(home, 'config.toml'), 'utf8'))?.[1]
  assert.ok(after)
  assert.notEqual(after, first, 'the account is still pointed at the last run\'s gateway')
})
