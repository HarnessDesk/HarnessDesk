import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent } from '@harnessdesk/protocol'

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
