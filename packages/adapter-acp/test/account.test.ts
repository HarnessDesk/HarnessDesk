import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

import { EventEmitter } from 'node:events'

import { CliAccount } from '../src/account.js'
import { AcpRuntime, parseStatus } from '../src/index.js'

/**
 * The registry-declared account contract: identity from the agent's own CLI,
 * sign-in as a browser flow whose URL the CLI prints, sign-out as a command.
 * The fake CLI answers in both dialects observed live — `claude auth status`
 * JSON and `cursor-agent status` prose.
 */

const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))
const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agent-cli.mjs', import.meta.url))

const make = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE_AGENT],
    account: {
      status: { command: FAKE_CLI, args: ['status'], env },
      login: { command: FAKE_CLI, args: ['login'], env },
      logout: { command: FAKE_CLI, args: ['logout'], env },
    },
  })

test('parseStatus reads both observed dialects, and refuses to invent identity', () => {
  assert.deepEqual(
    parseStatus('{"loggedIn":true,"email":"a@b.c","planType":"max","orgId":"x"}'),
    { kind: 'cli', label: 'a@b.c', email: 'a@b.c', planType: 'max' },
  )
  assert.equal(parseStatus('{"loggedIn":false}'), null)
  assert.deepEqual(parseStatus('✓ Logged in as olivia@example.com\n'), {
    kind: 'cli',
    label: 'olivia@example.com',
    email: 'olivia@example.com',
  })
  assert.equal(parseStatus('Not logged in'), null)
  assert.equal(parseStatus('gibberish'), null)
})

test('the registry account commands become the account surface', async () => {
  const runtime = make()
  await runtime.start()
  try {
    assert.equal(runtime.info.capabilities.account, true)
    const status = await runtime.getAccount()
    assert.equal(status.accounts[0]?.email, 'tester@example.com')
    assert.equal(status.accounts[0]?.planType, 'max')
    assert.equal(status.signInMethods[0]?.flow, 'browser')
  } finally {
    await runtime.dispose()
  }
})

test('signed out is an empty list, not an error — even when status exits 1', async () => {
  const runtime = make({ FAKE_CLI_STYLE: 'text', FAKE_CLI_STATE: 'out' })
  await runtime.start()
  try {
    const status = await runtime.getAccount()
    assert.deepEqual(status.accounts, [])
    assert.equal(status.signInMethods.length, 1, 'sign-in is still offered')
  } finally {
    await runtime.dispose()
  }
})

test('login returns the URL the CLI printed and completion arrives as an event', async () => {
  const runtime = make()
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    const start = await runtime.login('cli-browser')
    assert.equal(start.type, 'browser')
    assert.equal(start.url, 'https://auth.example.com/flow/abc123')
    const deadline = Date.now() + 5_000
    for (;;) {
      const done = events.find((event) => event.type === 'account/loginCompleted')
      if (done) {
        assert.equal((done as Extract<AgentEvent, { type: 'account/loginCompleted' }>).success, true)
        assert.equal((done as Extract<AgentEvent, { type: 'account/loginCompleted' }>).loginId, start.loginId)
        break
      }
      if (Date.now() > deadline) throw new Error('no completion event')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(events.some((event) => event.type === 'account/changed'))
  } finally {
    await runtime.dispose()
  }
})

test('a failed browser flow completes as a failure, in the CLI’s words', async () => {
  const runtime = make({ FAKE_CLI_LOGIN: 'fail' })
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    await runtime.login('cli-browser')
    const deadline = Date.now() + 5_000
    for (;;) {
      const done = events.find((event) => event.type === 'account/loginCompleted')
      if (done) {
        const completed = done as Extract<AgentEvent, { type: 'account/loginCompleted' }>
        assert.equal(completed.success, false)
        assert.match(completed.error ?? '', /refused/)
        break
      }
      if (Date.now() > deadline) throw new Error('no completion event')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  } finally {
    await runtime.dispose()
  }
})

test('a login command that prints no URL rejects with its own explanation', async () => {
  const runtime = make({ FAKE_CLI_LOGIN: 'silent' })
  await runtime.start()
  try {
    await assert.rejects(runtime.login('cli-browser'), /needs a terminal/)
  } finally {
    await runtime.dispose()
  }
})

test('logout runs the command and announces the change', async () => {
  const runtime = make()
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    await runtime.logout()
    assert.ok(events.some((event) => event.type === 'account/changed'))
  } finally {
    await runtime.dispose()
  }
})

/**
 * The other kind of agent: no status command, no stored key — nothing the
 * desk can ask. Its sign-in is observed from its own answers, and until one
 * has been given the desk claims nothing, which is what keeps "Needs sign-in"
 * off an agent that is in the middle of opening pull requests.
 */
const bare = (env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE_AGENT],
    env,
  })

test('an agent the desk cannot ask claims nothing until a session opens, then reads as signed in', async () => {
  const runtime = bare()
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    assert.equal(runtime.info.capabilities.account, false, 'no CLI, no key, nothing seen: no claim')
    assert.deepEqual(await runtime.getAccount(), { accounts: [], signInMethods: [] })
    await runtime.createSession({ cwd: process.cwd() })
    assert.equal(runtime.info.capabilities.account, true, 'a session opened, so there is something to say')
    const status = await runtime.getAccount()
    assert.deepEqual(status.accounts, [{ kind: 'agent', label: 'Signed in', anonymous: true }])
    assert.deepEqual(status.signInMethods, [])
    assert.ok(events.some((event) => event.type === 'account/changed'), 'the surface was told to look again')
  } finally {
    await runtime.dispose()
  }
})

test('an agent that refuses a session for want of a sign-in says so, in its declared methods', async () => {
  const runtime = bare({ FAKE_ACP_AUTH_REQUIRED: '1' })
  await runtime.start()
  try {
    await assert.rejects(runtime.createSession({ cwd: process.cwd() }), /Authentication required/)
    assert.equal(runtime.info.capabilities.account, true)
    const status = await runtime.getAccount()
    assert.deepEqual(status.accounts, [])
    assert.equal(status.signInMethods.length, 1)
    assert.equal(status.signInMethods[0]?.id, 'acp:device')
    assert.equal(status.signInMethods[0]?.label, 'Sign in on the agent side')
    assert.equal(status.signInMethods[0]?.flow, 'external', 'the desk does not drive ACP authenticate')
    assert.match(status.signInMethods[0]?.description ?? '', /Run the agent login\./)
    assert.match(status.signInMethods[0]?.description ?? '', /Authentication required/)
  } finally {
    await runtime.dispose()
  }
})

test('a sign-in that lapses turns an observed agent back into one that needs signing in', async () => {
  const runtime = bare({ FAKE_ACP_AUTH_REQUIRED_AFTER: '1' })
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    await runtime.createSession({ cwd: process.cwd() })
    assert.deepEqual((await runtime.getAccount()).accounts, [{ kind: 'agent', label: 'Signed in', anonymous: true }])
    await assert.rejects(runtime.createSession({ cwd: process.cwd() }), /Authentication required/)
    const status = await runtime.getAccount()
    assert.deepEqual(status.accounts, [], 'the observation followed the agent’s latest answer')
    assert.equal(status.signInMethods[0]?.id, 'acp:device')
    assert.equal(events.filter((event) => event.type === 'account/changed').length, 2, 'each change was announced once')
  } finally {
    await runtime.dispose()
  }
})

test('a -32000 that is not about signing in is not read as a sign-in refusal', async () => {
  const runtime = bare({ FAKE_ACP_SERVER_ERROR: '1' })
  await runtime.start()
  try {
    await assert.rejects(runtime.createSession({ cwd: process.cwd() }), /Internal server error/)
    assert.equal(runtime.info.capabilities.account, false, 'a server error says nothing about the sign-in')
    assert.deepEqual(await runtime.getAccount(), { accounts: [], signInMethods: [] })
  } finally {
    await runtime.dispose()
  }
})

/**
 * #17 — a sign-in binary that does not exist.
 *
 * With no `'error'` listener, `spawn` of a missing command threw an unhandled
 * `'error'` event and took the whole process down. Reproduced on the unfixed
 * build before this was written: `Unhandled 'error' event … ENOENT`, and the
 * process gone. Here the process is the test runner, so this test finishing
 * at all is half the proof; the rejection is the other half.
 */
test('a sign-in command that does not exist is a refusal in words, not a crashed host', async () => {
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE_AGENT],
    account: {
      status: { command: FAKE_CLI, args: ['status'] },
      login: { command: 'hd-no-such-sign-in-binary' },
      logout: { command: FAKE_CLI, args: ['logout'] },
    },
  })
  await runtime.start()
  try {
    const started = Date.now()
    await assert.rejects(runtime.login('cli-browser'), /could not start \(hd-no-such-sign-in-binary\).*ENOENT/)
    /* At once, not after the URL timeout. Node may never emit `'exit'` after
       a spawn error, so a listener that only kept the process alive would
       leave the flow waiting out the whole timeout before saying anything. */
    assert.ok(Date.now() - started < 2_000, 'rejected without waiting out the URL timeout')
  } finally {
    await runtime.dispose()
  }
})

/**
 * #39 — a status object with text after it.
 *
 * The parse took everything from the first brace to the end of the output, so
 * any line a CLI printed after its JSON made it throw; the catch fell through
 * to the sentence form, that found nothing, and a signed-in account was
 * reported as signed out.
 */
test('a status object with text after it is read, and the account is signed in', () => {
  const signedIn = { kind: 'cli', label: 'user@example.com', email: 'user@example.com' }
  assert.deepEqual(parseStatus('{"loggedIn": true, "email": "user@example.com"}\nSession active.'), signedIn)
  // Pretty-printed, as some CLIs print it, and then a log line.
  assert.deepEqual(parseStatus('{\n  "loggedIn": true,\n  "email": "user@example.com"\n}\nReady.'), signedIn)
  // A banner before it and a remark after it on the same line.
  assert.deepEqual(parseStatus('Checking…\n{"loggedIn":true,"email":"user@example.com"} (cached)'), signedIn)
})

test('a brace or an escaped quote inside a string does not end the object early', () => {
  // A plan or an org name can hold a brace; counting it would cut the object short.
  assert.deepEqual(parseStatus('{"loggedIn":true,"email":"a@b.c","planType":"team {eu}"}\ndone'), {
    kind: 'cli',
    label: 'a@b.c',
    email: 'a@b.c',
    planType: 'team {eu}',
  })
  assert.deepEqual(parseStatus('{"loggedIn":true,"email":"a@b.c","planType":"say \\"}\\" plan"}\nok'), {
    kind: 'cli',
    label: 'a@b.c',
    email: 'a@b.c',
    planType: 'say "}" plan',
  })
})

test('an object that never closes is not a signed-in account', () => {
  // The control: it read as nothing before, and it still does.
  assert.equal(parseStatus('{"loggedIn": true, "email": "a@b.c"'), null)
})

test('a status after a braced preface, or after an NDJSON log line, is still found', () => {
  // Round one anchored on the first brace, so the preface was the object tried.
  const signedIn = { kind: 'cli', label: 'a@b.c', email: 'a@b.c' }
  assert.deepEqual(parseStatus('info {cache}\n{"loggedIn":true,"email":"a@b.c"}'), signedIn)
  // This one parses — it is JSON, just not a status — and has to be passed over.
  assert.deepEqual(parseStatus('{"level":"info","msg":"checking"}\n{"loggedIn":true,"email":"a@b.c"}'), signedIn)
})

test('a " in a value is a character to the scanner, as it is to JSON', () => {
  /* Review asked whether the scanner, which does not decode `\u` escapes,
     could end an object somewhere JSON.parse would not. It cannot: an escape
     never ends a string in either. The scanner takes the backslash and the
     `u` as one escape and the four digits as characters, which is where
     JSON.parse leaves them too — the brace after it is still inside the
     string for both. */
  const text = '{"loggedIn":true,"email":"a@b.c","plan":"x\\u0022}{\\u0022"}'
  // The plan comes back whole — quote, braces, quote — so the object ended
  // where JSON.parse ends it, not at the brace inside the value.
  assert.deepEqual(parseStatus(text), { kind: 'cli', label: 'a@b.c', email: 'a@b.c', planType: 'x"}{"' })
})

/** A child process the test drives by hand, for endings a real CLI cannot stage. */
const fakeChild = () =>
  Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true })

const accountWith = (child: ReturnType<typeof fakeChild>, events: AgentEvent[], urlTimeoutMs?: number) =>
  new CliAccount(
    { status: { command: 'unused' }, login: { command: 'hd-missing' } },
    'fake-acp' as never,
    (event) => events.push(event),
    undefined,
    { spawn: (() => child) as never, ...(urlTimeoutMs === undefined ? {} : { urlTimeoutMs }) },
  )

const completions = (events: readonly AgentEvent[]) =>
  events.filter((event) => event.type === 'account/loginCompleted').length

test('an error and an exit in the same tick, before the URL, report no completion', async () => {
  /* Some Node versions emit 'exit' after a spawn error; the one this runs on
     does not, so both are emitted here by hand — in one tick, which is the
     order that defeated round one's fix. Nobody was handed this login's id,
     so nothing may be announced for it. */
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.emit('error', Object.assign(new Error('spawn hd-missing ENOENT'), { code: 'ENOENT' }))
  child.emit('exit', null)
  await assert.rejects(login, /could not start \(hd-missing\)/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completions(events), 0)
})

test('an error after the URL was handed out ends the flow once, even with an exit behind it', async () => {
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.stdout.emit('data', Buffer.from('Open https://auth.example.com/flow/xyz to sign in\n'))
  const start = await login
  assert.equal(start.type, 'browser')

  child.emit('error', new Error('the pipe went away'))
  child.emit('exit', 1)
  await new Promise((resolve) => setImmediate(resolve))
  const ended = events.filter((event) => event.type === 'account/loginCompleted') as Extract<
    AgentEvent,
    { type: 'account/loginCompleted' }
  >[]
  assert.equal(ended.length, 1, 'one ending, not one per event')
  assert.equal(ended[0]?.success, false)
  assert.match(ended[0]?.error ?? '', /stopped: the pipe went away/)
})

test('an object nested in another is not a status, alone or ahead of the real one', () => {
  // Round two scanned every brace, so a field of some other object read as a status.
  assert.equal(parseStatus('{"payload":{"email":"ops@example.com"}}'), null)
  assert.equal(parseStatus('{"level":"info","payload":{"email":"ops@example.com"}}\n{"loggedIn":false}'), null)
  assert.deepEqual(parseStatus('{"level":"info","payload":{"email":"ops@example.com"}}\n{"loggedIn":true,"email":"a@b.c"}'), {
    kind: 'cli',
    label: 'a@b.c',
    email: 'a@b.c',
  })
})

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('a URL and an error in the same tick hand out nothing', async () => {
  // The flow ended before login() could return its id, so login() reports it.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.stdout.emit('data', Buffer.from('Open https://auth.example.com/flow/xyz to sign in\n'))
  child.emit('error', new Error('the pipe went away'))
  await assert.rejects(login, /stopped: the pipe went away/)
  await tick()
  assert.equal(completions(events), 0)
})

test("an exit before any URL is login()'s to report, once", async () => {
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.stdout.emit('data', Buffer.from('You are already signed in.\n'))
  child.emit('exit', 0)
  await assert.rejects(login, /already signed in/i)
  await tick()
  assert.equal(completions(events), 0, 'no completion for an id nobody was given')
  assert.equal(events.filter((event) => event.type === 'account/changed').length, 1, 'but the account is looked at again')
})

test('no URL in time is login()\'s to report, and the exit its kill causes adds nothing', async (t) => {
  /* The timeout is unref'd on purpose, so that a stuck sign-in never holds
     the host open. A real child's pipes keep the loop alive while it waits;
     this fake holds nothing, so on Node 22 the loop emptied before the timer
     fired and the test was cancelled (CI did exactly that). The test holds
     the loop open itself, as a real child would. */
  const hold = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(hold))
  const child = fakeChild()
  let killed: string | undefined
  child.kill = ((signal?: string) => {
    killed = signal
    setImmediate(() => child.emit('exit', null))
    return true
  }) as typeof child.kill
  const events: AgentEvent[] = []
  await assert.rejects(accountWith(child, events, 20).login(), /printed no URL/)
  await tick()
  await tick()
  assert.equal(killed, 'SIGTERM')
  assert.equal(completions(events), 0)
})

test('a record that says signed in or out outranks one that only names an email', () => {
  // Round three: a log line with a top-level email, ahead of the status, read as signed in.
  assert.equal(parseStatus('{"level":"info","email":"ops@example.com"}\n{"loggedIn":false}'), null)
  assert.deepEqual(parseStatus('{"type":"log","email":"ops@example.com"}\n{"loggedIn":true,"email":"a@b.c"}'), {
    kind: 'cli',
    label: 'a@b.c',
    email: 'a@b.c',
  })
  // A CLI whose whole status is an email is still read.
  assert.deepEqual(parseStatus('{"email":"a@b.c"}'), { kind: 'cli', label: 'a@b.c', email: 'a@b.c' })
})

test('logged_in, in snake case, reads like loggedIn', () => {
  assert.deepEqual(parseStatus('{"logged_in":true,"email":"a@b.c"}'), { kind: 'cli', label: 'a@b.c', email: 'a@b.c' })
  // Signed out says so, even beside an email.
  assert.equal(parseStatus('{"logged_in":false,"email":"a@b.c"}'), null)
})

test('a cancelled flow ends once, as a failure, and its child is stopped', async () => {
  const child = fakeChild()
  let killed: string | undefined
  child.kill = ((signal?: string) => {
    killed = signal
    setImmediate(() => child.emit('exit', null))
    return true
  }) as typeof child.kill
  const events: AgentEvent[] = []
  const account = accountWith(child, events)
  const login = account.login()
  child.stdout.emit('data', Buffer.from('Open https://auth.example.com/flow/xyz to sign in\n'))
  const start = (await login) as { loginId: string }
  await account.cancel(start.loginId)
  await tick()
  await tick()
  assert.equal(killed, 'SIGTERM')
  const ended = events.filter((event) => event.type === 'account/loginCompleted') as Extract<
    AgentEvent,
    { type: 'account/loginCompleted' }
  >[]
  assert.equal(ended.length, 1)
  assert.equal(ended[0]?.success, false)
})

test('an object that never closes hides nothing that could be read as a status', () => {
  // Round four: resuming at the next brace walked into a truncated object.
  assert.equal(parseStatus('{"wrap":{"loggedIn":true,"email":"a@b.c"}'), null)
})

test('a sentence that says who is signed in outranks a record that only names an email', () => {
  // Round four: a log line's email was taken over the CLI's own sentence.
  assert.deepEqual(parseStatus('{"level":"info","email":"ops@example.com"}\nLogged in as a@b.c'), {
    kind: 'cli',
    label: 'a@b.c',
    email: 'a@b.c',
  })
})

