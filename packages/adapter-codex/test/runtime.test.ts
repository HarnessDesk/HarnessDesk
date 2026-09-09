import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  allItems,
  approvalId,
  reduceAll,
  sessionId,
  type AgentEvent,
  type Approval,
  type Session,
} from '@harnessdesk/protocol'

import { CodexRuntime } from '../src/index.js'
import { nameFromMessage } from '../src/mapping/session.js'

/**
 * End-to-end through a real child process: spawn, handshake, thread start, turn
 * streaming, approval round-trip, interrupt, history paging.
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))

const makeRuntime = (env: Readonly<Record<string, string>> = {}): CodexRuntime =>
  new CodexRuntime({ binaryPath: FAKE, clientName: 'harnessdesk-test', env })

/** Collects the event stream so assertions can look at ordering, not just state. */
const recorder = (runtime: CodexRuntime) => {
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return {
    events,
    /** Waits until `predicate` is satisfied by the accumulated stream. */
    async until(predicate: (events: AgentEvent[]) => boolean, timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (!predicate(events)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out; saw ${events.map((event) => event.type).join(', ') || '(nothing)'}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

const baseSession = (id = 'thread-e2e'): Session => ({
  id: sessionId(id),
  runtime: 'codex' as never,
  cwd: '/w',
  status: { type: 'idle' },
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  itemsLoaded: true,
})

test('starting the runtime reports Codex as ready with a version', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  assert.deepEqual(runtime.health(), { state: 'ready' })
  assert.equal(runtime.info.version, 'codex-cli 0.149.0')
  assert.equal(runtime.info.name, 'Codex')
})

test('a missing Codex reports actionable first-run guidance', async () => {
  const runtime = new CodexRuntime({ binaryPath: '/definitely/not/real' })
  await assert.rejects(() => runtime.start())
  const health = runtime.health()
  assert.equal(health.state, 'unavailable')
  assert.equal(health.state === 'unavailable' && health.reason, 'notInstalled')
  assert.match(health.state === 'unavailable' ? (health.remediation ?? '') : '', /brew install/)
  await runtime.dispose()
})

test('models exclude hidden entries and carry reasoning efforts', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const models = await runtime.listModels()
  assert.equal(models.length, 1, 'hidden models are not offered')
  assert.equal(models[0]?.id, 'gpt-5.5')
  assert.deepEqual(
    models[0]?.reasoningLevels.map((level) => level.id),
    ['low', 'high'],
  )
  assert.equal(models[0]?.supportsImages, true)
})

test('account and rate limits are normalised, including no-credits', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()

  const account = await runtime.getAccount()
  assert.deepEqual(account.accounts, [
    { kind: 'chatgpt', label: 'dev@example.com', email: 'dev@example.com', planType: 'team' },
  ])

  const limits = await runtime.getRateLimits()
  assert.equal(limits?.hasCredits, false)
  assert.equal(limits?.balance, 0)
})

// ------------------------------------------------------------------- sign-in

const loginEvents = (events: AgentEvent[]) =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: 'account/loginCompleted' }> =>
      event.type === 'account/loginCompleted',
  )

test('signed out means no accounts, and the methods Codex permits', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut' })
  t.after(() => runtime.dispose())
  await runtime.start()

  const status = await runtime.getAccount()
  assert.deepEqual(status.accounts, [])
  assert.deepEqual(
    status.signInMethods.map((method) => [method.id, method.flow]),
    [
      ['chatgpt', 'browser'],
      ['chatgptDeviceCode', 'deviceCode'],
      ['apiKey', 'external'],
    ],
  )
})

test('a configuration that forces API-key login leaves nothing to drive', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut', FAKE_CODEX_FORCED_LOGIN: 'api' })
  t.after(() => runtime.dispose())
  await runtime.start()

  const status = await runtime.getAccount()
  assert.deepEqual(
    status.signInMethods.map((method) => method.flow),
    ['external'],
    'the interface must not offer a flow the configuration would refuse',
  )
  await assert.rejects(() => runtime.login('apiKey'), /cannot be started from the interface/)
})

test('browser sign-in returns a URL and finishes as an event, never a poll', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut', FAKE_CODEX_LOGIN: 'succeed' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  const started = await runtime.login('chatgpt')
  assert.equal(started.type, 'browser')
  assert.match(started.type === 'browser' ? started.url : '', /^https:\/\//)

  await tape.until((events) => loginEvents(events).length > 0)
  const [completed] = loginEvents(tape.events)
  assert.equal(completed?.loginId, started.loginId)
  assert.equal(completed?.success, true)

  // Codex announces the new identity; the interface re-reads on that signal.
  await tape.until((events) => events.some((event) => event.type === 'account/changed'))
  const status = await runtime.getAccount()
  assert.equal(status.accounts[0]?.email, 'dev@example.com')
})

test('device-code sign-in carries the code and where to enter it', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut' })
  t.after(() => runtime.dispose())
  await runtime.start()

  const started = await runtime.login('chatgptDeviceCode')
  assert.equal(started.type, 'deviceCode')
  if (started.type !== 'deviceCode') return
  assert.match(started.code, /^CODE-\d+$/)
  assert.match(started.url, /device/)
})

test('cancelling a sign-in ends it as a failed completion, not silence', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  const started = await runtime.login('chatgpt')
  await runtime.cancelLogin(started.loginId)

  await tape.until((events) => loginEvents(events).length > 0)
  const [completed] = loginEvents(tape.events)
  assert.equal(completed?.loginId, started.loginId)
  assert.equal(completed?.success, false)
  assert.match(completed?.error ?? '', /not completed/)
  t.diagnostic('a dialog waiting on this login must be told it is over')
})

test('a sign-in that fails midway reports the failure with its reason', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut', FAKE_CODEX_LOGIN: 'fail' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  const started = await runtime.login('chatgpt')
  await tape.until((events) => loginEvents(events).length > 0)
  const [completed] = loginEvents(tape.events)
  assert.equal(completed?.loginId, started.loginId)
  assert.equal(completed?.success, false)
  assert.match(completed?.error ?? '', /token exchange failed/)

  const status = await runtime.getAccount()
  assert.deepEqual(status.accounts, [], 'a failed login must not read as signed in')
})

test('starting a second sign-in supersedes the first, and stale cancels are harmless', async (t) => {
  const runtime = makeRuntime({ FAKE_CODEX_ACCOUNT: 'signedOut' })
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  const first = await runtime.login('chatgpt')
  const second = await runtime.login('chatgptDeviceCode')
  assert.notEqual(first.loginId, second.loginId)

  // The real app-server fails the old login the moment the new one starts.
  await tape.until((events) => loginEvents(events).some((event) => event.loginId === first.loginId))
  assert.equal(loginEvents(tape.events).find((e) => e.loginId === first.loginId)?.success, false)

  // Cancelling the superseded id, or one never issued, resolves quietly: the
  // caller's intent — nothing in flight under that id — is already true.
  await runtime.cancelLogin(first.loginId)
  await runtime.cancelLogin('never-issued')

  // The live one is still cancellable.
  await runtime.cancelLogin(second.loginId)
  await tape.until((events) => loginEvents(events).some((event) => event.loginId === second.loginId))
})

test('signing out announces the change and reads back as no account', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  assert.equal((await runtime.getAccount()).accounts.length, 1)
  await runtime.logout()
  await tape.until((events) => events.some((event) => event.type === 'account/changed'))
  assert.deepEqual((await runtime.getAccount()).accounts, [])
})

test('history lists and searches map onto session summaries', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()

  const listed = await runtime.listSessions({ pageSize: 10 })
  assert.equal(listed.data.length, 3)
  assert.equal(listed.data[0]?.preview, 'List the files here.')
  // A conversation whose first message came from HarnessDesk carries the
  // envelope HarnessDesk prepended for the model. It is plumbing, not what
  // the person said, so it is never what the list calls the conversation.
  const withChip = listed.data.find((summary) => String(summary.id) === 'thread-3')
  assert.equal(withChip?.preview, 'Reply with exactly: ok')
  assert.equal(withChip?.title, null, 'Codex names no thread it did not name itself')
  assert.equal(listed.data[0]?.git?.branch, 'main')
  // Codex records seconds; HarnessDesk uses milliseconds.
  assert.equal(listed.data[0]?.createdAt, 1_700_000_000_000)

  const found = await runtime.searchSessions('files')
  assert.equal(found.data.length, 1)
})

test('a thread working on its first turn is in the list, under its ask', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()

  // Codex stores nothing at thread/start, so this thread is in no listing of
  // its own — and the sidebar used to have no row for it until the turn it
  // was busy with had ended.
  const session = await runtime.createSession({ cwd: '/w' })
  const before = await runtime.listSessions({ pageSize: 10 })
  assert.equal(
    before.data.filter((summary) => String(summary.id) === String(session.id)).length,
    1,
    'a thread open here has a row from the moment it exists',
  )

  await session.send([
    { type: 'text', text: '<context source="Uncommitted changes">\nStatus: ## main\n</context>' },
    { type: 'text', text: 'Count slowly from 1 to 30, one number per line.' },
  ])
  const during = await runtime.listSessions({ pageSize: 10 })
  const row = during.data.find((summary) => String(summary.id) === String(session.id))
  assert.equal(row?.status.type, 'active', 'a working thread says so, so the Working band finds it')
  assert.equal(
    row?.preview,
    'Count slowly from 1 to 30, one number per line.',
    'the row shows the ask, not the envelope HarnessDesk prepended',
  )
  // Every stored thread is still listed, and the one Codex has now stored
  // under this same id is laid over rather than repeated.
  assert.equal(during.data.filter((summary) => String(summary.id) === 'thread-2').length, 1)
  assert.equal(during.data.filter((summary) => String(summary.id) === 'thread-3').length, 1)
  assert.equal(during.data.filter((summary) => String(summary.id) === String(session.id)).length, 1)

  // Later pages are Codex's alone: the live row belongs to the first page, or
  // it would repeat itself down the list.
  const paged = await runtime.listSessions({ pageSize: 10, cursor: 'next' })
  assert.ok(
    !paged.data.some((summary) => summary.status.type === 'active'),
    'no live row is laid over a later page',
  )

  // Archiving is the one thing that takes the row away again — the overlay
  // must not put back what Codex has stopped listing.
  await runtime.archiveSession(session.id, true)
  const after = await runtime.listSessions({ pageSize: 10 })
  assert.ok(
    !after.data.some((summary) => summary.status.type === 'active'),
    'a thread archived while open here leaves the list',
  )
})

test('reading a session pages through every turn item', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()

  const session = await runtime.readSession(sessionId('thread-e2e'))
  assert.equal(session.itemsLoaded, true)
  const items = allItems(session)
  assert.equal(items.length, 2, 'both pages were fetched')
  assert.deepEqual(
    items.map((item) => item.type),
    ['userMessage', 'assistantMessage'],
  )
})

test('a full turn streams through as an ordered event sequence', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  const session = await runtime.createSession({ cwd: '/w', model: 'gpt-5.5' })
  assert.equal(session.settings().model, 'gpt-5.5')
  const permissions = session.options().find((option) => option.id === 'permissions')
  assert.equal(permissions?.currentValue, ':workspace')

  await session.send([{ type: 'text', text: 'List the files here.' }])

  // The command asks for approval before it runs.
  await tape.until((events) => events.some((event) => event.type === 'approval/requested'))
  const requested = tape.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval/requested' }> =>
      event.type === 'approval/requested',
  )
  const approval = requested?.approval as Approval
  assert.equal(approval.type, 'command')
  assert.equal(approval.type === 'command' && approval.command, 'ls -la')
  assert.equal(approval.reason, 'Needs to read the working directory')
  assert.deepEqual(
    approval.type === 'command' ? approval.options.map((option) => option.intent) : [],
    ['approve', 'approveAlways', 'deny'],
  )

  const allow = approval.type === 'command' ? approval.options[0] : undefined
  await session.respondToApproval(approval.id, { type: 'option', optionId: allow?.id ?? 'opt-0' })

  await tape.until((events) => events.some((event) => event.type === 'turn/completed'))

  const folded = reduceAll(baseSession(), tape.events)
  const items = allItems(folded)
  assert.deepEqual(
    items.map((item) => item.type),
    ['userMessage', 'assistantMessage', 'command'],
  )
  const assistant = items[1]
  assert.equal(assistant?.type === 'assistantMessage' && assistant.text, 'Running ls.')
  const command = items[2]
  assert.equal(command?.type === 'command' && command.status, 'completed')
  assert.equal(command?.type === 'command' && command.output, 'README.md\n')
  assert.equal(folded.turns[0]?.status, 'completed')
})

test('the tokens Codex reported survive re-reading the session', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  // A thread this process has never opened has no tokens to report, and
  // `thread/read` carries none of its own — the honest answer is nothing.
  const cold = await runtime.readSession(sessionId('thread-e2e'))
  assert.equal(cold.usage, null)

  const session = await runtime.createSession({ cwd: '/w', model: 'gpt-5.5' })
  await session.send([{ type: 'text', text: 'List the files here.' }])
  await tape.until((events) => events.some((event) => event.type === 'approval/requested'))
  const requested = tape.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval/requested' }> =>
      event.type === 'approval/requested',
  )
  const approval = requested?.approval as Approval
  const allow = approval.type === 'command' ? approval.options[0] : undefined
  await session.respondToApproval(approval.id, { type: 'option', optionId: allow?.id ?? 'opt-0' })
  await tape.until((events) => events.some((event) => event.type === 'usage/updated'))

  const reported = tape.events.find(
    (event): event is Extract<AgentEvent, { type: 'usage/updated' }> =>
      event.type === 'usage/updated',
  )?.usage
  // Codex's own `tokens_in_context_window`: the last response's tokens less the
  // reasoning it drops from the next request.
  assert.equal(reported?.contextUsed, 55_200)
  assert.equal(reported?.contextWindow, 272_000)

  // Re-opening a conversation reads it again, and the ring must not go out.
  const reread = await runtime.readSession(session.id)
  assert.deepEqual(reread.usage, reported)
})

test('declining an approval is carried through to the runtime', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'go' }])
  await tape.until((events) => events.some((event) => event.type === 'approval/requested'))

  const requested = tape.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval/requested' }> =>
      event.type === 'approval/requested',
  )
  const approval = requested!.approval
  const deny = approval.type === 'command' ? approval.options.find((o) => o.intent === 'deny') : undefined
  await session.respondToApproval(approval.id, { type: 'option', optionId: deny!.id })

  await tape.until((events) => events.some((event) => event.type === 'approval/resolved'))
  await tape.until((events) => events.some((event) => event.type === 'turn/completed'))

  /* Waiting for those two proves nothing on its own: an *approval* produces
     both. What "carried through to the runtime" means is that the command did
     not run — the fake answers an approval by streaming `ls -la` output and
     completing the item, and a decline by completing the turn with nothing in
     it. So the decision is checked where it landed, and the absence of the
     work is checked beside it. */
  const resolved = tape.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval/resolved' }> =>
      event.type === 'approval/resolved',
  )
  assert.deepEqual(resolved?.resolution, { outcome: 'decided', decision: { type: 'option', optionId: deny!.id } })

  const ranTheCommand = tape.events.some(
    (event) => event.type === 'item/completed' && event.item.type === 'command',
  )
  assert.equal(ranTheCommand, false, 'declining must not run the command it asked about')
})

test('answering an unknown approval fails loudly rather than silently', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/w' })
  await assert.rejects(
    () => session.respondToApproval(approvalId('nope'), { type: 'option', optionId: 'opt-0' }),
    /No approval is pending/,
  )
})

test('steer and interrupt refuse when no turn is running', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/w' })

  await assert.rejects(() => session.interrupt(), /no turn is currently running/)
  await assert.rejects(
    () => session.steer([{ type: 'text', text: 'also check tests' }]),
    /no turn is currently running/,
  )
})

test('steer sends the active turn id as a precondition', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'go' }])
  // The fake rejects any expectedTurnId that is not the live turn.
  await session.steer([{ type: 'text', text: 'also check tests' }])
})

test('interrupt ends the turn as interrupted', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)
  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'go' }])
  await session.interrupt()
  await tape.until((events) =>
    events.some((event) => event.type === 'turn/completed' && event.turn.status === 'interrupted'),
  )
})

test('setting a title round-trips through the runtime', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)
  const session = await runtime.createSession({ cwd: '/w' })
  await session.setTitle('Directory audit')
  await tape.until((events) =>
    events.some((event) => event.type === 'session/title' && event.title === 'Directory audit'),
  )
})

test('a thread name is the person\'s words, cut on a word', () => {
  assert.equal(
    nameFromMessage('<context source="Git">on branch x</context>\n\nAdd a New game button'),
    'Add a New game button',
  )
  // Only the first line: the rest is the request, not its name.
  assert.equal(nameFromMessage('Fix the grouping\nand then commit it'), 'Fix the grouping')
  assert.equal(
    nameFromMessage(`Rewrite ${'the sidebar grouping logic '.repeat(4)}today`),
    'Rewrite the sidebar grouping logic the sidebar grouping…',
  )
  // Nothing but envelope is nothing to call it.
  assert.equal(nameFromMessage('<context source="Git">on branch x</context>'), null)
})

test('a first message with HarnessDesk\'s own envelope names the thread; a plain one does not', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)

  // The composer sends a chip as a context block ahead of the ask. Codex
  // would show that block as the thread's name, so the thread is named
  // through Codex's own call and both windows read the same.
  const enveloped = await runtime.createSession({ cwd: '/w' })
  await enveloped.send([
    { type: 'text', text: '<context source="Uncommitted changes">\nStatus: ## main\n</context>' },
    { type: 'text', text: 'Reply with exactly: ok' },
  ])
  await tape.until((events) =>
    events.some((event) => event.type === 'session/title' && event.title === 'Reply with exactly: ok'),
  )

  // A plain first message already reads the same in both windows; nothing is
  // written, and the thread stays free for Codex to name.
  const plain = await runtime.createSession({ cwd: '/w' })
  const before = tape.events.length
  await plain.send([{ type: 'text', text: 'List the files here.' }])
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(
    !tape.events.slice(before).some((event) => event.type === 'session/title'),
    'no name is invented for a message that needed no cleaning',
  )
})

test('resuming twice returns the same live handle', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const first = await runtime.resumeSession(sessionId('thread-e2e'))
  const second = await runtime.resumeSession(sessionId('thread-e2e'))
  assert.equal(first, second)
})

test('disposal abandons any approval still waiting', async (t) => {
  const runtime = makeRuntime()
  await runtime.start()
  const tape = recorder(runtime)
  const session = await runtime.createSession({ cwd: '/w' })
  await session.send([{ type: 'text', text: 'go' }])
  await tape.until((events) => events.some((event) => event.type === 'approval/requested'))

  await runtime.dispose()

  const resolved = tape.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval/resolved' }> =>
      event.type === 'approval/resolved',
  )
  assert.equal(resolved?.resolution.outcome, 'abandoned')
  t.diagnostic('an open dialog must be told its request is dead')
})

// ------------------------------------------------------------------- options

const optionsEvents = (events: AgentEvent[]) =>
  events.filter(
    (event): event is Extract<AgentEvent, { type: 'session/options' }> =>
      event.type === 'session/options',
  )

test('a settings change is applied through thread/settings/update and folded back from Codex', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)
  const session = await runtime.createSession({ cwd: '/w' })

  await session.setOption('permissions', ':read-only')
  assert.equal(session.options().find((o) => o.id === 'permissions')?.currentValue, ':read-only')

  // Codex answers with the whole settings record; the fold must agree with it.
  await tape.until((events) => optionsEvents(events).length >= 2)
  const latest = optionsEvents(tape.events).at(-1)
  assert.equal(latest?.options.find((o) => o.id === 'permissions')?.currentValue, ':read-only')

  // Switching to plan mode makes Codex set the mode's preset effort too, and
  // the notification is what tells us so — one change, two options moved.
  await session.setOption('mode', 'plan')
  await tape.until((events) =>
    optionsEvents(events).some((event) =>
      event.options.some((o) => o.id === 'mode' && o.currentValue === 'plan'),
    ),
  )
  const options = session.options()
  assert.equal(options.find((o) => o.id === 'mode')?.currentValue, 'plan')
  assert.equal(options.find((o) => o.id === 'effort')?.currentValue, 'medium')
})

test('changing the model is reported as a settings change as well as an options change', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const tape = recorder(runtime)
  const session = await runtime.createSession({ cwd: '/w' })
  await session.updateSettings({ model: 'gpt-5.5' })
  // Same model: nothing to announce as a settings change.
  assert.ok(!tape.events.some((e) => e.type === 'session/settings'))
  await assert.rejects(() => session.setOption('model', 'gpt-99'), /not one of the values/)
  t.diagnostic('Codex would have accepted gpt-99 silently; the adapter refuses it first')
})

test('a profile Codex refuses is surfaced, and the session is unchanged', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({ cwd: '/w' })
  // `ci` is declared by the fake's profile list but the fake refuses it on
  // update, the way the real server refuses a profile its config cannot load.
  const before = session.options()
  await assert.rejects(() => runtime.createSession({ cwd: '/w', options: { permissions: 'nope' } }))
  assert.deepEqual(session.options(), before)
})

test('initial options that need a follow-up update are applied, or the session is closed', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const session = await runtime.createSession({
    cwd: '/w',
    options: { permissions: ':read-only', effort: 'high', approvals: 'never' },
  })
  const options = session.options()
  assert.equal(options.find((o) => o.id === 'permissions')?.currentValue, ':read-only')
  assert.equal(options.find((o) => o.id === 'effort')?.currentValue, 'high')
  assert.equal(options.find((o) => o.id === 'approvals')?.currentValue, 'never')
})

test('a feature Codex cannot flip at runtime fails with Codex\'s own explanation', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  const options = await runtime.listOptions()
  assert.deepEqual(
    options.map((o) => o.id),
    ['feature.memories', 'feature.prevent_idle_sleep', 'feature.silent_flag'],
    'beta features only, across both pages',
  )
  await assert.rejects(
    () => runtime.setOption('feature.prevent_idle_sleep', true),
    /currently supported features are memories/,
  )
  await runtime.setOption('feature.memories', true)
  assert.equal((await runtime.listOptions()).find((o) => o.id === 'feature.memories')?.currentValue, true)
})

test('a feature Codex 0.153.0 silently declines to flip is refused out loud, naming config.toml', async (t) => {
  const runtime = makeRuntime()
  t.after(() => runtime.dispose())
  await runtime.start()
  // The server answers `{ enablement: {} }` with no error; before this read
  // the answer, the toggle reported success and snapped back on the next list.
  await assert.rejects(() => runtime.setOption('feature.silent_flag', true), /config\.toml/)
  assert.equal((await runtime.listOptions()).find((o) => o.id === 'feature.silent_flag')?.currentValue, false)
})

test('defaultSessionOptions declares the next session before one exists', async () => {
  const runtime = makeRuntime()
  await runtime.start()
  try {
    const options = await runtime.defaultSessionOptions('/tmp/repo')
    const model = options.find((option) => option.id === 'model')
    assert.ok(model, 'a model option is declared with no thread started')
    assert.equal(model.type, 'select')
    assert.equal(model.currentValue, 'gpt-5.5')

    // A pick rides along and the list re-declares around it, the same
    // constraint model live sessions use.
    const picked = await runtime.defaultSessionOptions('/tmp/repo', { effort: 'high' })
    assert.equal(picked.find((option) => option.id === 'effort')?.currentValue, 'high')

    // A value the runtime would refuse at start is refused here too.
    await assert.rejects(
      runtime.defaultSessionOptions('/tmp/repo', { model: 'no-such-model' }),
      /not one of the values/,
    )
  } finally {
    await runtime.dispose()
  }
})

test('the install command names the package manager that put this Codex here', async () => {
  const { installCommandFor } = await import('../src/runtime.js')
  assert.equal(installCommandFor('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js'), 'npm i -g @openai/codex')
  assert.equal(installCommandFor('/nowhere/Cellar/codex/0.1.0/bin/codex'), 'brew install codex')
  assert.equal(installCommandFor(null), 'brew install codex')
})

test('a Codex that could not read its catalogue says so on the model option', async () => {
  const runtime = makeRuntime({ FAKE_CODEX_CATALOG_WARNING: '1' })
  await runtime.start()
  try {
    // The warning arrives on stderr during startup; give the pipe a moment.
    let description: string | undefined
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const options = await runtime.defaultSessionOptions('/tmp/repo')
      description = options.find((option) => option.id === 'model')?.description
      if (description) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.match(description ?? '', /could not read its current model catalogue/)
    assert.match(description ?? '', /unknown variant `max`/)
    assert.doesNotMatch(description ?? '', /body:|column/)
    // It survives a catalogue re-read — the binary is the same binary.
    await runtime.refreshCatalog()
    const again = await runtime.defaultSessionOptions('/tmp/repo')
    assert.match(again.find((option) => option.id === 'model')?.description ?? '', /unknown variant/)
  } finally {
    await runtime.dispose()
  }
})

test('a clean Codex draws no catalogue note', async () => {
  const runtime = makeRuntime()
  await runtime.start()
  try {
    const options = await runtime.defaultSessionOptions('/tmp/repo')
    assert.equal(options.find((option) => option.id === 'model')?.description, undefined)
  } finally {
    await runtime.dispose()
  }
})

test('refreshCatalog re-reads and announces; live sessions re-declare', async () => {
  const runtime = makeRuntime()
  const { events, until } = recorder(runtime)
  await runtime.start()
  try {
    const session = await runtime.createSession({ cwd: '/tmp/repo' })
    await until((seen) => seen.some((event) => event.type === 'session/started'))
    const before = events.length
    await runtime.refreshCatalog()
    const after = events.slice(before)
    assert.ok(after.some((event) => event.type === 'catalog/changed'), 'the runtime announces the re-read')
    assert.ok(
      after.some((event) => event.type === 'session/options' && event.sessionId === session.id),
      'the live session re-declares its options',
    )
  } finally {
    await runtime.dispose()
  }
})

test('checkInstallation moves an idle runtime onto an upgraded binary, and waits while busy', async () => {
  const runtime = makeRuntime()
  const { until } = recorder(runtime)
  await runtime.start()
  const saved = process.env['FAKE_CODEX_VERSION']
  try {
    assert.equal(runtime.info.version, 'codex-cli 0.149.0')
    assert.deepEqual(await runtime.checkInstallation(), { changed: false })

    // "Upgrade" the binary: discovery probes `--version` in this process's
    // environment, so the fixture reports the new number from here on.
    process.env['FAKE_CODEX_VERSION'] = '0.200.0'

    // Busy: a turn in flight means the change is reported but not acted on.
    const session = await runtime.createSession({ cwd: '/tmp/repo' })
    await session.send([{ type: 'text', text: 'hello' }])
    await until((seen) => seen.some((event) => event.type === 'turn/started'))
    const deferred = await runtime.checkInstallation()
    assert.deepEqual(deferred, { changed: true, from: 'codex-cli 0.149.0', to: 'codex-cli 0.200.0', restarted: false })
    assert.equal(runtime.info.version, 'codex-cli 0.149.0')
    await session.interrupt().catch(() => undefined)
    await until((seen) => seen.some((event) => event.type === 'turn/completed'))

    // Idle: the runtime restarts onto the new build and is ready again.
    const moved = await runtime.checkInstallation()
    assert.deepEqual(moved, { changed: true, from: 'codex-cli 0.149.0', to: 'codex-cli 0.200.0', restarted: true })
    assert.equal(runtime.info.version, 'codex-cli 0.200.0')
    assert.equal(runtime.health().state, 'ready')
    await until((seen) => seen.some((event) => event.type === 'catalog/changed'))
    const options = await runtime.defaultSessionOptions('/tmp/repo')
    assert.ok(options.find((option) => option.id === 'model'), 'the new process answers')
    assert.deepEqual(await runtime.checkInstallation(), { changed: false })
  } finally {
    if (saved === undefined) delete process.env['FAKE_CODEX_VERSION']
    else process.env['FAKE_CODEX_VERSION'] = saved
    await runtime.dispose()
  }
})
