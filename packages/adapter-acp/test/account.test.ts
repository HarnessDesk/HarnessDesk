import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

import { EventEmitter } from 'node:events'

import { CliAccount } from '../src/account.js'
import { AcpRuntime, parseStatus, type AcpAgentConfig } from '../src/index.js'

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
  /* Each CLI the way it answers, measured (review, round 15): `claude auth status` prints its record and exits 1,
     so the probe's rejection is what answers for it; `cursor-agent status` prints `Not logged in` and exits 0, so
     the words do. */
  for (const style of ['json', 'text']) {
    const runtime = make({ FAKE_CLI_STYLE: style, FAKE_CLI_STATE: 'out' })
    await runtime.start()
    try {
      const status = await runtime.getAccount()
      assert.deepEqual(status.accounts, [], style)
      assert.equal(status.signInMethods.length, 1, 'sign-in is still offered')
    } finally {
      await runtime.dispose()
    }
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
 * Who, not only whether. An agent with no status command may still write
 * down who it signed in as, and the host hands the adapter a reader for
 * that record; the observation still decides whether anything is shown.
 */
const recorded = (resolveIdentity: AcpAgentConfig['resolveIdentity'], env: Record<string, string> = {}): AcpRuntime =>
  new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: [FAKE_AGENT],
    env,
    ...(resolveIdentity ? { resolveIdentity } : {}),
  })

const DEV = { kind: 'agent', label: 'dev@example.com', email: 'dev@example.com' }

test('once a session opens, the agent’s own record names the account', async () => {
  const runtime = recorded(() => DEV)
  await runtime.start()
  try {
    assert.deepEqual(
      await runtime.getAccount(),
      { accounts: [], signInMethods: [] },
      'a record on disk is what the agent will try, not proof that it works',
    )
    assert.equal(runtime.info.capabilities.account, false)
    await runtime.createSession({ cwd: process.cwd() })
    assert.deepEqual((await runtime.getAccount()).accounts, [DEV])
  } finally {
    await runtime.dispose()
  }
})

test('a record that names nobody, or cannot be read, leaves “Signed in” standing', async () => {
  const unreadable = (): never => {
    throw new Error('unreadable')
  }
  for (const resolveIdentity of [() => null, unreadable]) {
    const runtime = recorded(resolveIdentity)
    await runtime.start()
    try {
      await runtime.createSession({ cwd: process.cwd() })
      assert.deepEqual((await runtime.getAccount()).accounts, [{ kind: 'agent', label: 'Signed in', anonymous: true }])
    } finally {
      await runtime.dispose()
    }
  }
})

test('a refusal outranks the record: the agent’s own answer is the newer evidence', async () => {
  const runtime = recorded(() => DEV, { FAKE_ACP_AUTH_REQUIRED: '1' })
  await runtime.start()
  try {
    await assert.rejects(runtime.createSession({ cwd: process.cwd() }), /Authentication required/)
    const status = await runtime.getAccount()
    assert.deepEqual(status.accounts, [])
    assert.equal(status.signInMethods[0]?.id, 'acp:device')
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

test('a sentence that says signed out outranks a record that only names an email', () => {
  // Round five: a log line's email, then "Not logged in", read as signed in.
  assert.equal(parseStatus('{"level":"info","email":"ops@example.com"}\nNot logged in'), null)
  assert.equal(parseStatus('{"level":"info","email":"ops@example.com"}\nYou are logged out.'), null)
})

test('an error after the first from the sign-in child is heard, not thrown', async () => {
  // Round five: `once` left no listener for a second error, and an unheard error throws.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.emit('error', Object.assign(new Error('spawn hd-missing ENOENT'), { code: 'ENOENT' }))
  await assert.rejects(login)
  assert.doesNotThrow(() => child.emit('error', new Error('and again, in teardown')))
})

test('a JSON log line that says "logged in as" is not the CLI saying so', () => {
  // Round 6 of #134: sentences were read from the whole output, JSON included, and this was the account `warmup"}`.
  assert.equal(parseStatus('{"level":"info","msg":"logged in as warmup"}'), null)
  assert.deepEqual(parseStatus('{"level":"info","msg":"logged in as warmup"}\nLogged in as dev@example.com'), {
    kind: 'cli',
    label: 'dev@example.com',
    email: 'dev@example.com',
  })
})

test('a sentence that says nobody is signed in is signed out, whoever it names', () => {
  // Round 6 of #134: "Not logged in as …" matched "logged in as" and read as signed in.
  assert.equal(parseStatus('Not logged in as user@example.com'), null)
  assert.equal(parseStatus('not logged in as anyone'), null)
  assert.deepEqual(parseStatus('Logged in as user@example.com.'), { kind: 'cli', label: 'user@example.com', email: 'user@example.com' })
})

test('a log record whose loggedIn or email holds nothing does not stand in for the status', () => {
  // Round 6 of #134: the key being there was enough, whatever it held.
  const signedIn = { kind: 'cli', label: 'a@b.c', email: 'a@b.c' }
  assert.deepEqual(parseStatus('{"level":"info","loggedIn":null}\n{"loggedIn":true,"email":"a@b.c"}'), signedIn)
  assert.deepEqual(parseStatus('{"level":"info","email":null}\n{"email":"a@b.c"}'), signedIn)
})

test('a stray brace in a line of prose does not hide the status after it', () => {
  // Round 6 of #134: an object that never closed stopped the scan, wherever it was.
  assert.deepEqual(parseStatus('[INFO] {cache-init starting\n{"loggedIn":true,"email":"a@b.c"}'), {
    kind: 'cli',
    label: 'a@b.c',
    email: 'a@b.c',
  })
  // The control: a record cut short still reads as nothing, as round four made it, wherever it starts.
  assert.equal(parseStatus('{"wrap":{"loggedIn":true,"email":"a@b.c"}'), null)
  assert.equal(parseStatus('status: {"wrap":{"loggedIn":true,"email":"a@b.c"}'), null)
})

test('a negation anywhere before the verb, or a past sign-in, is not a signed-in account', () => {
  // Round 7 of #134: the guard looked at the one word before "logged", so each of these read as signed in.
  for (const text of [
    'Not currently logged in as user@example.com',
    'You are not currently logged in as user@example.com.',
    'Not signed in. Last logged in as user@example.com',
    'Previously logged in as user@example.com',
    'No longer signed in as user@example.com',
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
  // "Signed in as" is a sentence too, and one that names nobody is no answer.
  assert.deepEqual(parseStatus('Signed in as user@example.com'), { kind: 'cli', label: 'user@example.com', email: 'user@example.com' })
  assert.equal(parseStatus('Logged in as ""'), null)
})

test('a cancelled sign-in says so at once, and a killed one says it was stopped, not what it printed', async () => {
  // Round 7 of #134: a flow ended by a signal reported its URL prompt as the error, or "code null".
  const child = fakeChild()
  const events: AgentEvent[] = []
  const account = accountWith(child, events)
  const login = account.login()
  child.stdout.emit('data', Buffer.from('Open https://example.com/device to sign in\n'))
  const started = (await login) as { loginId: string }
  await account.cancel(started.loginId)
  const ended = events.filter((event) => event.type === 'account/loginCompleted') as { error?: string; success: boolean }[]
  assert.equal(ended.length, 1, 'said at once, before any exit')
  assert.equal(ended[0]?.error, 'Sign-in was cancelled.')
  child.emit('exit', null, 'SIGTERM')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completions(events), 1, 'the exit after it adds nothing')

  const killed = fakeChild()
  const heard: AgentEvent[] = []
  const second = accountWith(killed, heard).login()
  killed.stdout.emit('data', Buffer.from('Open https://example.com/device to sign in\n'))
  await second
  killed.emit('exit', null, 'SIGKILL')
  await new Promise((resolve) => setImmediate(resolve))
  const stopped = heard.find((event) => event.type === 'account/loginCompleted') as { error?: string } | undefined
  assert.equal(stopped?.error, 'The sign-in command was stopped (SIGKILL).')
})

test('a contracted negation is a signed-out sentence too', () => {
  // Round 8 of #134: "aren't" is no `not`, and it matched the signed-in sentence instead.
  for (const text of [
    "You aren't logged in as user@example.com",
    "This desk isn't signed in as user@example.com.",
    'You weren’t logged in as user@example.com',
    "Haven't logged in as anyone yet",
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
  assert.deepEqual(parseStatus('Logged in as user@example.com'), { kind: 'cli', label: 'user@example.com', email: 'user@example.com' }, 'the control')
})


test('a negation in another clause, or a sign-out in the past, does not sign out the account a sentence names', () => {
  // Round 9 of #134: a negation reached across `!`, `?` and `;`, and "logged out" counted wherever it stood.
  const signedIn = { kind: 'cli', label: 'user@example.com', email: 'user@example.com' }
  for (const text of [
    'Could not check for updates! Logged in as user@example.com',
    'Not sure which account? Logged in as user@example.com',
    'Do not share your token; logged in as user@example.com',
    'Logged in as user@example.com\nLast logged out 2 days ago',
    'Logged in as user@example.com (previously logged out)',
  ]) {
    assert.deepEqual(parseStatus(text), signedIn, text)
  }
  // A sign-out that is the state now still is one.
  for (const text of ['Logged out.', 'You were logged out. Sign in again to continue.', 'Your session was signed out']) {
    assert.equal(parseStatus(text), null, text)
  }
})

test('an object inside a sentence is cut from it, not made a break in it', () => {
  // Round 9 of #134: a braced chunk became a line break, which ended the clause its negation was in.
  assert.equal(parseStatus('Not {cache} logged in as user@example.com'), null)
  assert.equal(parseStatus('Not {"level":"debug"} logged in as user@example.com'), null)
})

test('a status record names its plan as planType, plan or subscriptionType', () => {
  // Round 9 of #134: only planType was read in any test.
  for (const key of ['planType', 'plan', 'subscriptionType']) {
    assert.deepEqual(
      parseStatus(JSON.stringify({ loggedIn: true, email: 'dev@example.com', [key]: 'pro' })),
      { kind: 'cli', label: 'dev@example.com', email: 'dev@example.com', planType: 'pro' },
      key,
    )
  }
})

test('a URL the CLI prints on stderr is handed out like one on stdout', async () => {
  // Round 9 of #134: both streams are scanned, and every test printed its URL on stdout.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events, 1_000).login()
  child.stderr.emit('data', Buffer.from('Open https://auth.example.com/flow/err to sign in\n'))
  const started = (await login) as { url: string }
  assert.equal(started.url, 'https://auth.example.com/flow/err')
})

test('a flow that printed nothing but its URL says how it ended', async () => {
  // Round 9 of #134: the URL is left out of an ending's last words, and with nothing else printed the exit is the ending.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.stdout.emit('data', Buffer.from('https://auth.example.com/flow/only\n'))
  await login
  child.emit('exit', 1, null)
  await tick()
  const ended = events.find((event) => event.type === 'account/loginCompleted') as { error?: string } | undefined
  assert.equal(ended?.error, 'The sign-in command exited with code 1.')
})

test('a status record whose email is empty names nobody', () => {
  // Round 10 of #134: "email": "" was an account called nothing.
  assert.deepEqual(parseStatus('{"loggedIn":true,"email":""}'), { kind: 'cli', label: 'Signed in' })
  assert.equal(parseStatus('{"email":""}'), null)
})

test('a sign-in command that ends before its URL, saying nothing, says how it ended', async () => {
  // Round 10 of #134: an exit with code 1 and no output read "printed no URL to open".
  const failed = fakeChild()
  const first = accountWith(failed, []).login()
  failed.emit('exit', 1, null)
  await assert.rejects(first, { message: 'The sign-in command exited with code 1.' })
  const killed = fakeChild()
  const second = accountWith(killed, []).login()
  killed.emit('exit', null, 'SIGKILL')
  await assert.rejects(second, { message: 'The sign-in command was stopped (SIGKILL).' })
})

test('a comma, a colon or a carriage return ends the clause a negation is in', () => {
  // Round 10 of #134: "Not cached, logged in as …" read as signed out.
  const signedIn = { kind: 'cli', label: 'user@example.com', email: 'user@example.com' }
  for (const text of [
    'Not cached, logged in as user@example.com',
    "Can't check for updates: logged in as user@example.com",
    'Not verified yet…\rLogged in as user@example.com',
  ]) {
    assert.deepEqual(parseStatus(text), signedIn, JSON.stringify(text))
  }
  // Within one clause, a negation still signs out.
  assert.equal(parseStatus('You are not currently logged in as user@example.com'), null)
})

test('cancelling a flow that has already ended does nothing', async () => {
  // Round 10 of #134: "unknown ids are not an error" had no test.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const account = accountWith(child, events)
  const login = account.login()
  child.stdout.emit('data', Buffer.from('Open https://example.com/device to sign in\n'))
  const started = (await login) as { loginId: string }
  child.emit('exit', 0, null)
  await tick()
  await account.cancel(started.loginId)
  await tick()
  assert.equal(completions(events), 1, 'the exit ended it, and the cancel adds nothing')
})

test('two sign-ins at once each end once, and cancelling one leaves the other', async () => {
  // Round 10 of #134: nothing ran two flows on one account.
  const children = [fakeChild(), fakeChild()]
  const queue = [...children]
  const events: AgentEvent[] = []
  const account = new CliAccount(
    { status: { command: 'unused' }, login: { command: 'hd-missing' } },
    'fake-acp' as never,
    (event) => events.push(event),
    undefined,
    { spawn: (() => queue.shift()) as never },
  )
  const a = account.login()
  children[0]!.stdout.emit('data', Buffer.from('Open https://example.com/a to sign in\n'))
  const b = account.login()
  children[1]!.stdout.emit('data', Buffer.from('Open https://example.com/b to sign in\n'))
  const [one, two] = (await Promise.all([a, b])) as { loginId: string; url: string }[]
  assert.notEqual(one!.loginId, two!.loginId)
  assert.deepEqual([one!.url, two!.url], ['https://example.com/a', 'https://example.com/b'])
  await account.cancel(one!.loginId)
  children[1]!.emit('exit', 0, null)
  await tick()
  const ended = events.filter((event) => event.type === 'account/loginCompleted') as { loginId: string; success: boolean }[]
  assert.deepEqual(
    ended.map((event) => [event.loginId, event.success]),
    [
      [one!.loginId, false],
      [two!.loginId, true],
    ],
  )
})

test('a cancelled sign-in with a real child ends once, and the kill it causes adds nothing', async () => {
  // Round 10 of #134: cancel was tested on a child the test drives by hand, never on a process.
  const runtime = make({ FAKE_CLI_LOGIN: 'hang' })
  await runtime.start()
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    const start = await runtime.login('cli-browser')
    await runtime.cancelLogin(start.loginId)
    /* Time for the SIGTERM's exit to arrive and be ignored. A best effort (review, round 15): a kill's exit carries
       no code, so nothing is emitted to wait on instead, and where the exit comes later than this the test passes
       without having seen the second completion it is here to catch. */
    await new Promise((resolve) => setTimeout(resolve, 500))
    const ended = events.filter((event) => event.type === 'account/loginCompleted') as { error?: string }[]
    assert.equal(ended.length, 1)
    assert.equal(ended[0]?.error, 'Sign-in was cancelled.')
  } finally {
    await runtime.dispose()
  }
})

test('a prompt over two lines is not a killed flow’s last words', async () => {
  // Round 11 of #134: only the URL's own line was skipped, so the line above it was the error.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const login = accountWith(child, events).login()
  child.stdout.emit('data', Buffer.from('Open the link to sign in:\n  https://example.com/device\n'))
  await login
  child.emit('exit', null, 'SIGKILL')
  await tick()
  const ended = events.find((event) => event.type === 'account/loginCompleted') as { error?: string } | undefined
  assert.equal(ended?.error, 'The sign-in command was stopped (SIGKILL).')
})

test('a command that prints its URL and exits in the same breath is not reported by its prompt', async () => {
  // Round 11 of #134: the flow ended before the hand-out, and login() rejected with "Open … to sign in".
  const child = fakeChild()
  const login = accountWith(child, []).login()
  child.stdout.emit('data', Buffer.from('Open https://example.com/device to sign in\n'))
  child.emit('exit', 0, null)
  await assert.rejects(login, { message: 'The sign-in command finished before its URL could be opened.' })
})

test('a parenthesis or a dash ends a clause too, and a sign-out that is denied is none', () => {
  // Round 11 of #134: "(not using the cache) logged in as …" read as signed out, and so did "(not logged out)".
  const signedIn = { kind: 'cli', label: 'user@example.com', email: 'user@example.com' }
  for (const text of [
    '(not using the cache) logged in as user@example.com',
    'Warning: do not share your token - logged in as user@example.com',
    'Token not refreshed — logged in as user@example.com',
    'Logged in as user@example.com (not logged out)',
    "Logged in as user@example.com; you haven't logged out",
  ]) {
    assert.deepEqual(parseStatus(text), signedIn, text)
  }
  // A hyphen inside a word is no dash: the negation still reaches the verb.
  assert.equal(parseStatus('Not re-authenticated or logged in as user@example.com'), null)
})

test('a cancelled flow whose command signs in anyway still tells the desk to look again', async () => {
  // Round 11 of #134: the exit after a cancel was ignored whole, the account's change with it.
  const child = fakeChild()
  const events: AgentEvent[] = []
  const account = accountWith(child, events)
  const login = account.login()
  child.stdout.emit('data', Buffer.from('Open https://example.com/device to sign in\n'))
  const started = (await login) as { loginId: string }
  await account.cancel(started.loginId)
  child.emit('exit', 0, null)
  await tick()
  assert.equal(completions(events), 1, 'the cancel is the ending')
  assert.equal(events.filter((event) => event.type === 'account/changed').length, 1)
})

test('a sign-out is denied only right before it, and a negation aimed elsewhere in its clause leaves it standing', () => {
  // Round 12 of #134: only a negation right before the verb counted, so "not yet logged out" read as signed out.
  const signedIn = { kind: 'cli', label: 'user@example.com', email: 'user@example.com' }
  for (const text of [
    'Logged in as user@example.com; you have not yet logged out',
    'Logged in as user@example.com. You are not currently signed out.',
    "Logged in as user@example.com; you haven't ever logged out",
    'Logged in as user@example.com; you have not been logged out',
  ]) {
    assert.deepEqual(parseStatus(text), signedIn, text)
  }
  assert.equal(parseStatus('You were logged out.'), null, 'a sign-out that is the state now')
  // Round 13: a negation anywhere in the clause denied it, and kept the account these sentences sign out.
  for (const text of [
    '{"email":"ops@example.com"}\nThe refresh token was not accepted so you were logged out',
    'Logged in as user@example.com\nThis machine has never been trusted and was logged out',
    "Logged in as user@example.com\nYou haven't used this device in 90 days and were logged out",
    // A word outside the closed set between them doesn't deny it either.
    'Logged in as user@example.com\nYou have not quietly been logged out',
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
  // Round 14: the gap is spaces, not line breaks, so a negation that ends one line doesn't deny the sign-out on the next.
  for (const text of [
    'Logged in as old@example.com\nLast sync: never\nLogged out.',
    'Logged in as old@example.com\nVerified: not yet\nLogged out.',
    '{"email":"ops@example.com"}\nLast sync: never\nLogged out.',
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
  // And `be` is in the set: "will not be logged out" keeps the account.
  assert.deepEqual(parseStatus('Logged in as user@example.com; you will not be logged out'), signedIn)
})

test('a JSON array is data, not a status, and a bracket in prose is only characters', () => {
  // Round 12 of #134: an object inside a top-level array was taken for the status.
  assert.equal(parseStatus('[{"level":"info","loggedIn":true,"email":"ops@example.com"}]\nNot logged in'), null)
  assert.deepEqual(parseStatus('[1/3] Logged in as user@example.com'), { kind: 'cli', label: 'user@example.com', email: 'user@example.com' })
  // A status that is only an array reads as none, on purpose (round 13).
  assert.equal(parseStatus('[{"loggedIn":true,"email":"a@b.c"}]'), null)
  // The record inside a bracket of prose is still read.
  assert.equal(parseStatus('[INFO starting {"loggedIn":true,"email":"a@b.c"} done]')?.email, 'a@b.c')
})

test('an array that opens like data is data when it is cut short or does not parse', () => {
  // Round 13 of #134: only an array that closed and parsed was cut, and the records inside the rest came back.
  for (const text of [
    '[{"level":"info","loggedIn":true,"email":"ops@example.com"}\nNot logged in',
    '[{"level":"info","loggedIn":true,"email":"ops@example.com"},]\nNot logged in',
    '[{"level":"info","loggedIn":true,"email":"ops@example.com"}\n{"level":"info"}]\nNot logged in',
    // Round 14: whatever its first element is, a number, true or null included.
    '[1, 2, {"loggedIn":true,"email":"a@b.c"}',
    '[true, {"loggedIn":true,"email":"a@b.c"}',
    '[null, {"loggedIn":true,"email":"a@b.c"}',
    '[1, {"loggedIn":true,"email":"ops@example.com"},]\nNot logged in',
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
})

test('a bracket in prose that never closes leaves the status after it readable', () => {
  // Round 14 of #134: a quote after a bracket was taken for an array cut short, and the scan stopped there.
  // The bracket half of round 6's stray brace.
  assert.equal(parseStatus('Use ["--json" for machine output\n{"loggedIn":true,"email":"a@b.c"}')?.email, 'a@b.c')
  assert.equal(parseStatus('Reading ["config\nLogged in as a@b.c')?.email, 'a@b.c')
  // A bracketed address is the address without its brackets.
  assert.equal(parseStatus('Logged in as <a@b.c>')?.email, 'a@b.c')
  assert.equal(parseStatus('Logged in as [a@b.c]')?.email, 'a@b.c')
  // Round 15: only the first word is read, so a name before the address is the name. Neither CLI prints one.
  assert.deepEqual(parseStatus('Logged in as Shane <shane@example.com>'), { kind: 'cli', label: 'Shane' })
})

test('the two CLIs this file is wired to, as they print their status signed in and signed out', () => {
  /* Round 14 of #134: captured by a reviewer from claude auth status and cursor-agent status. Round 15: the whole
     records, and the signed-out halves, measured with an empty HOME. Addresses, names, ids and paths replaced. */
  const claudeIn = `${JSON.stringify(
    {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      analyticsDisabled: false,
      projectsDirectory: '/home/dev/.claude/projects',
      email: 'user@example.com',
      orgId: '00000000-0000-0000-0000-000000000000',
      orgName: "user@example.com's Organization",
      subscriptionType: 'max',
    },
    null,
    2,
  )}\n`
  assert.deepEqual(parseStatus(claudeIn), { kind: 'cli', label: 'user@example.com', email: 'user@example.com', planType: 'max' })
  // Printed with exit 1, so the probe's rejection answers first (see the test with the fake CLI); read, it says the same.
  const claudeOut = `${JSON.stringify(
    { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: false, projectsDirectory: '/home/dev/.claude/projects' },
    null,
    2,
  )}\n`
  assert.equal(parseStatus(claudeOut), null)
  // The same line :41 reads, as cursor-agent printed it here.
  assert.deepEqual(parseStatus(`${String.fromCharCode(0x2713)} Logged in as user@example.com\n`), { kind: 'cli', label: 'user@example.com', email: 'user@example.com' })
  // Printed with exit 0, so this is what answers.
  assert.equal(parseStatus('Not logged in\n'), null)
})

test('what the scan reads again is bounded, and past the bound nothing more is read', () => {
  // Round 12 of #134: an unclosed prose brace was scanned to the end each time, the square of the output.
  // Round 13: past a count of them the rest was read as prose, JSON and all, and a log line's words named an account.
  const warmup = '\n{"level":"info","msg":"logged in as warmup"}'
  assert.equal(parseStatus(`${'{cache '.repeat(65)}${warmup}`), null, 'a record the scan still reaches is cut')
  assert.equal(parseStatus(`${'{cache '.repeat(400)}${warmup}`), null, 'and one it never reaches is not read as prose')
  // A few prose braces are only characters, and the record after them is read (round six).
  assert.equal(parseStatus(`${'{cache '.repeat(10)}{"loggedIn":true,"email":"a@b.c"}`)?.email, 'a@b.c')
  // Past the bound nothing is read, a record or a sentence.
  assert.equal(parseStatus(`${'{cache '.repeat(400)}{"loggedIn":true,"email":"a@b.c"}`), null)
  assert.equal(parseStatus(`${'{cache '.repeat(400)}\nLogged in as user@example.com`), null)
  // Round 14: where the output begins, the bound is 122 openings that never close, measured.
  assert.equal(parseStatus(`${'{cache '.repeat(100)}\nLogged in as user@example.com`)?.email, 'user@example.com')
  assert.equal(parseStatus(`${'{cache '.repeat(150)}\nLogged in as user@example.com`), null)
  assert.equal(parseStatus(`${'{cache '.padEnd(200, '.').repeat(100)}\nLogged in as user@example.com`)?.email, 'user@example.com')
  // Round 15: it is a bound on reading, so the same openings further into a long output cost far less, and are read past.
  assert.equal(parseStatus(`${'x '.repeat(25_000)}${'{cache '.repeat(500)}\nLogged in as user@example.com`)?.email, 'user@example.com')
  // Brackets nested in prose count too. Each was read to its end again, which took seconds here; it stops early now.
  const nested = 20_000
  assert.equal(parseStatus(`${'[a '.repeat(nested)}${']'.repeat(nested)} Logged in as user@example.com`), null)
})

test('a denial and a past marker keep to the sign-out’s own line, with only spaces and tabs between', () => {
  // Round 15 of #134: other whitespace joined a denial to the sign-out, and a past marker still reached across a line.
  const vt = String.fromCharCode(11)
  const ff = String.fromCharCode(12)
  for (const text of [
    `Logged in as a@b.c; you are not${ff}been logged out`,
    `Logged in as a@b.c; you are not${vt}been logged out`,
    'Logged in as a@b.c\nUpdated last\nLogged out.',
    'Logged in as a@b.c\nChecked previously\nLogged out.',
    'Logged in as a@b.c\nSession cached formerly\nSigned out.',
    'Logged in as a@b.c\nToken checked previously\rLogged out.',
    `Logged in as a@b.c\nUpdated last${ff}Logged out.`,
  ]) {
    assert.equal(parseStatus(text), null, JSON.stringify(text))
  }
  // The controls: on its own line, with a space or a tab, each still says the sign-out isn't now.
  assert.equal(parseStatus('Logged in as a@b.c; last logged out yesterday')?.email, 'a@b.c')
  assert.equal(parseStatus('Logged in as a@b.c; you are not\tyet logged out')?.email, 'a@b.c')
})

test('a bracket that closes is data by its whole first element', () => {
  // Round 15 of #134: a record or an array was taken for the whole first element from its opening alone.
  assert.equal(parseStatus('[{"loggedIn":true,"email":"a@b.c"} current account]')?.email, 'a@b.c')
  assert.equal(parseStatus('[[1, 2] tags] Logged in as a@b.c')?.email, 'a@b.c')
  // Data: the first element whole, then the next element, with a comma or without one as NDJSON has it, or the end.
  for (const text of [
    '[{"a":1}, {"loggedIn":true,"email":"a@b.c"}]',
    '[{"a":1}\n{"loggedIn":true,"email":"a@b.c"}]',
    '[[1, 2], {"loggedIn":true,"email":"a@b.c"}]',
    '[[1, 2]\n{"loggedIn":true,"email":"a@b.c"}]',
    '["a", {"loggedIn":true,"email":"a@b.c"}]',
    '[1, {"loggedIn":true,"email":"a@b.c"}]',
    '[{"loggedIn":true,"email":"a@b.c"}]',
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
  // Each scalar that closes the array at once is data too, cut, and the sentence after it is read.
  for (const first of ['"a"', '1', '-2.5e3', 'true', 'false', 'null']) {
    assert.equal(parseStatus(`[${first}] Logged in as a@b.c`)?.email, 'a@b.c', first)
  }
})

test('telling an array from its opening is a trade, and this is the side it loses', () => {
  /* Round 15 of #134, recorded rather than fixed: a bracket in prose that never closes and whose first element
     looks whole is taken for data cut short, and holds everything after it. What separates it from an array cut
     short is at the far end of the text, where the scan never gets. */
  for (const text of [
    'Tags: [1, 2\nLogged in as a@b.c',
    'Ports: [8080,\n{"loggedIn":true,"email":"a@b.c"}',
    'Use ["--json", "--text" for machine output\n{"loggedIn":true,"email":"a@b.c"}',
  ]) {
    assert.equal(parseStatus(text), null, text)
  }
})

test('a URL split across two reads is handed out whole (#178)', async () => {
  const child = fakeChild()
  const login = accountWith(child, []).login()
  child.stdout.emit('data', Buffer.from('Open https://example.com/dev'))
  child.stdout.emit('data', Buffer.from('ice?code=42 to sign in\n'))
  assert.equal((await login).url, 'https://example.com/device?code=42')
})

test('a URL with nothing after it is handed out once the command goes quiet (#178)', async (t) => {
  /* The settle timer is unref'd, like the URL timeout, so a stuck sign-in never holds the host open, and this
     fake holds nothing: on Node 22 the loop emptied before the timer fired, and the runner cancelled this test
     and every one after it (CI did, on 7b3461f9). The test holds the loop open, as a real child's pipes would. */
  const hold = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(hold))
  const child = fakeChild()
  const account = new CliAccount(
    { status: { command: 'unused' }, login: { command: 'hd-missing' } },
    'fake-acp' as never,
    () => {},
    undefined,
    // Bounded, so a URL that is never handed out fails in a second rather than at the thirty-second timeout.
    { spawn: (() => child) as never, urlSettleMs: 20, urlTimeoutMs: 1_000 },
  )
  const login = account.login()
  // No line break after it, and the command waits: a URL at the end of what has arrived is still one.
  child.stdout.emit('data', Buffer.from('Open https://example.com/device'))
  assert.equal((await login).url, 'https://example.com/device')
})

test('advice beside a status is not a status: a clause that opens with if says what to do (#178)', () => {
  assert.deepEqual(parseStatus('✓ Logged in as dev@example.com\nIf not logged in, run: agent login'), {
    kind: 'cli',
    label: 'dev@example.com',
    email: 'dev@example.com',
  })
  assert.equal(parseStatus('Logged in as dev@example.com\nIf you are not logged in, run agent login')?.email, 'dev@example.com')
  assert.equal(parseStatus("Logged in as dev@example.com\nIf you aren't signed in, run agent login")?.email, 'dev@example.com')
  assert.equal(parseStatus('Logged in as dev@example.com\nIf you get logged out, run agent login')?.email, 'dev@example.com')
  assert.equal(parseStatus('Logged in as dev@example.com. Run agent logout if you want to be logged out')?.email, 'dev@example.com')
  // The status still decides: advice beside a sign-out leaves it signed out, and advice alone names nobody.
  assert.equal(parseStatus('Not logged in. If not logged in, run agent login'), null)
  assert.equal(parseStatus('If you are not logged in, run agent login'), null)
  assert.equal(parseStatus('You were logged out when the token expired. Logged in as dev@example.com'), null, 'when tells what happened')
})

test('a sign-in command that ignores SIGTERM is killed after a grace, not left running (#178)', async () => {
  const { spawn } = await import('node:child_process')
  let child: import('node:child_process').ChildProcess | undefined
  const script = "process.on('SIGTERM', () => {}); console.log('Open https://example.com/device'); setInterval(() => {}, 1000)"
  const account = new CliAccount(
    { status: { command: 'unused' }, login: { command: process.execPath, args: ['-e', script] } },
    'fake-acp' as never,
    () => {},
    undefined,
    { spawn: ((...args: Parameters<typeof spawn>) => (child = spawn(...args))) as never, killGraceMs: 100 },
  )
  try {
    const start = await account.login()
    const exited = new Promise<string | null>((resolve) => child!.once('exit', (_code, signal) => resolve(signal)))
    await account.cancel(start.loginId)
    const how = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 3_000))])
    assert.equal(how, 'SIGKILL')
  } finally {
    child?.kill('SIGKILL')
  }
})

test('a status probe whose binary is missing is signed out with the reason logged, not a rejection (#178)', async () => {
  const logged: unknown[] = []
  const account = new CliAccount(
    { status: { command: '/nonexistent/hd-no-such-cli' }, login: { command: 'unused' } },
    'fake-acp' as never,
    () => {},
    (message, details) => logged.push([message, details]),
  )
  const status = await account.status()
  assert.deepEqual(status.accounts, [])
  assert.equal(status.signInMethods.length, 1, 'sign-in is still offered')
  assert.match(JSON.stringify(logged), /ENOENT/)
})

test('a brace inside quotes in prose hides neither a record nor a sentence after it (#178)', () => {
  // Found by an early round of #134's review; later rounds' scan passes such a brace over, and this pins it.
  assert.equal(parseStatus('[INFO] running "{task"\n{"loggedIn":true,"email":"dev@example.com"}')?.email, 'dev@example.com')
  assert.equal(parseStatus('[INFO] running "{task"\nLogged in as dev@example.com')?.email, 'dev@example.com')
})
