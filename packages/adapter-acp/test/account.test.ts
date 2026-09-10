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
