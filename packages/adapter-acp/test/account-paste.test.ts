import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, LoginStart } from '@harnessdesk/protocol'

import { CliAccount, type AcpLoginSpec } from '../src/account.js'
import { AcpRuntime } from '../src/index.js'

/**
 * A sign-in command that falls back to a pasted code.
 *
 * `claude auth login` prints its link, then `Paste code here if prompted > `,
 * and reads its input line by line: a browser that cannot reach the command's
 * own callback shows the code instead. Run in the background with its input
 * closed, the command waited for a line that could never come, and sign-in
 * hung. A login spec that declares the prompt gets a pipe for its input, and
 * the code the person pastes into the desk is written to it.
 *
 * The code is a secret throughout: every test here checks that it appears in
 * no event, no log line and no error the flow produces.
 */

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-agent-cli.mjs', import.meta.url))
const PROMPT = 'Paste code here if prompted'
const REJECTED = 'Invalid code. Please make sure the full code was copied.'
const CODE = 'right-code-7f3a#state-91c2'
const WRONG = 'wrong-code-0b1d#state-91c2'

interface Rig {
  readonly account: CliAccount
  readonly events: AgentEvent[]
  readonly logs: string[]
  readonly children: ChildProcess[]
}

const rig = (mode: string, login: Partial<AcpLoginSpec> = { pasteCode: PROMPT, pasteCodeRejected: REJECTED }): Rig => {
  const events: AgentEvent[] = []
  const logs: string[] = []
  const children: ChildProcess[] = []
  const account = new CliAccount(
    {
      login: {
        command: process.execPath,
        args: [FAKE_CLI, 'login'],
        env: { FAKE_CLI_LOGIN: mode, FAKE_CLI_CODE: CODE },
        ...login,
      },
    },
    'fake-acp' as never,
    (event) => events.push(event),
    (message, details) => logs.push(`${message} ${JSON.stringify(details ?? null)}`),
    {
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args)
        children.push(child)
        return child
      }) as typeof spawn,
    },
  )
  return { account, events, logs, children }
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const completion = async (events: AgentEvent[]): Promise<Extract<AgentEvent, { type: 'account/loginCompleted' }>> => {
  await until(() => events.some((event) => event.type === 'account/loginCompleted'), 'the completion')
  return events.find((event) => event.type === 'account/loginCompleted') as Extract<AgentEvent, { type: 'account/loginCompleted' }>
}

const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()))

/** Everything the flow said, anywhere, as one string to search. */
const everything = (r: Rig, ...more: unknown[]): string => JSON.stringify([r.events, r.logs, ...more])

const asksNow = async (r: Rig, start: LoginStart): Promise<void> => {
  // The prompt is either on the start, or arrives as an event for the flow.
  if (start.type === 'browser' && start.pasteCode) return
  await until(
    () => r.events.some((event) => event.type === 'account/loginAwaitsCode' && event.loginId === start.loginId),
    'the ask for a code',
  )
}

test('a pasted code reaches the command, and the command signs in', async () => {
  const r = rig('paste')
  const start = await r.account.login()
  assert.equal(start.type, 'browser')
  assert.equal(start.type === 'browser' ? start.url : null, 'https://auth.example.com/flow/abc123')
  await asksNow(r, start)

  // Pasted with the whitespace a copy picks up around it.
  await r.account.submitCode(start.loginId, `  ${CODE}\n`)
  const done = await completion(r.events)
  assert.equal(done.success, true)
  assert.equal(done.loginId, start.loginId)
  assert.ok(r.events.some((event) => event.type === 'account/changed'), 'the desk is told to look again')
  assert.ok(!everything(r, start).includes(CODE), 'the code appears in no event, log or start')
})

test('a wrong code fails the flow in the command\'s words, with the code struck out and the prompt left out', async () => {
  const r = rig('paste')
  const start = await r.account.login()
  await asksNow(r, start)
  await r.account.submitCode(start.loginId, WRONG)
  const done = await completion(r.events)
  assert.equal(done.success, false)
  // The fake repeats each half of the code it refused, as a careless command might.
  assert.equal(done.error, 'Login failed: the code [code] was refused (state [code]).')
  const [half, state] = WRONG.split('#')
  for (const part of [WRONG, half!, state!]) assert.ok(!everything(r).includes(part), 'no part of the rejected code appears')
  assert.ok(!String(done.error).includes(PROMPT), 'the prompt is what the command asked, not what went wrong')
})

test('a paste the command refuses and reads on from is asked for again, and the next paste signs in', async () => {
  const r = rig('paste')
  const start = await r.account.login()
  await asksNow(r, start)
  // Cut short, as a password field hides: the half before the `#`.
  const [cut] = CODE.split('#')
  await r.account.submitCode(start.loginId, cut!)
  await until(
    () => r.events.some((event) => event.type === 'account/loginAwaitsCode' && event.refused === true),
    'the second ask',
  )
  assert.deepEqual(
    r.events.filter((event) => event.type === 'account/loginAwaitsCode' && event.refused),
    [{ type: 'account/loginAwaitsCode', runtime: 'fake-acp', loginId: start.loginId, refused: true }],
  )
  assert.ok(!r.events.some((event) => event.type === 'account/loginCompleted'), 'still pending: a refusal is not an ending')
  await r.account.submitCode(start.loginId, CODE)
  assert.equal((await completion(r.events)).success, true)
  assert.ok(!everything(r).includes(cut!), 'the cut-short paste appears nowhere either')
})

test('without its refusal declared, a refused paste is not reported as one', async () => {
  const r = rig('paste', { pasteCode: PROMPT })
  const start = await r.account.login()
  await asksNow(r, start)
  await r.account.submitCode(start.loginId, 'no-state-here')
  await r.account.submitCode(start.loginId, CODE)
  assert.equal((await completion(r.events)).success, true)
  assert.ok(!r.events.some((event) => event.type === 'account/loginAwaitsCode' && event.refused))
})

test('cancel ends a flow waiting for a code, kills its command, and takes no code after', async () => {
  const r = rig('paste')
  const start = await r.account.login()
  await asksNow(r, start)
  const child = r.children[0]!
  await r.account.cancel(start.loginId)
  const done = await completion(r.events)
  assert.equal(done.success, false)
  assert.equal(done.error, 'Sign-in was cancelled.')
  await exited(child)
  assert.equal(child.signalCode, 'SIGTERM', 'the command was stopped, not left waiting on its input')
  await assert.rejects(() => r.account.submitCode(start.loginId, CODE), (error: Error) => {
    assert.equal(error.message, 'This sign-in is not waiting for a code.')
    return true
  })
})

test('the automatic callback path is unaffected: a command that finishes by itself needs no code', async () => {
  const r = rig('paste-callback')
  const start = await r.account.login()
  const done = await completion(r.events)
  assert.equal(done.success, true)
  assert.equal(done.loginId, start.loginId)
})

test('a login spec that declares no prompt keeps its command\'s input closed, as it always was', async () => {
  const r = rig('ok', {})
  const start = await r.account.login()
  assert.equal(r.children[0]!.stdin, null, 'no pipe to write to')
  assert.equal(start.type === 'browser' ? start.pasteCode : undefined, undefined)
  await assert.rejects(() => r.account.submitCode(start.loginId, CODE), /not waiting for a code/)
  assert.equal((await completion(r.events)).success, true)
})

test('a prompt printed after the link is announced for the flow already handed out', async () => {
  const r = rig('paste-late')
  const start = await r.account.login()
  assert.equal(start.type === 'browser' ? start.pasteCode : undefined, undefined, 'not asked yet at the hand-out')
  // Before the ask, a code is refused rather than written into a command not reading for one.
  await assert.rejects(() => r.account.submitCode(start.loginId, CODE), /has not asked for a code/)
  await until(() => r.events.some((event) => event.type === 'account/loginAwaitsCode'), 'the late ask')
  const asked = r.events.filter((event) => event.type === 'account/loginAwaitsCode')
  assert.deepEqual(asked, [{ type: 'account/loginAwaitsCode', runtime: 'fake-acp', loginId: start.loginId }])
  await r.account.submitCode(start.loginId, CODE)
  assert.equal((await completion(r.events)).success, true)
})

test('what is not one line of code is refused in words that never repeat it', async () => {
  const r = rig('paste')
  const start = await r.account.login()
  await asksNow(r, start)
  const refusals: [string, RegExp][] = [
    ['   ', /Paste the code the browser page shows/],
    [`${CODE}\n${WRONG}`, /single line/],
    [`${CODE}\u0003`, /single line/],
    ['x'.repeat(5_000), /too long/],
  ]
  for (const [code, said] of refusals) {
    await assert.rejects(() => r.account.submitCode(start.loginId, code), (error: Error) => {
      assert.match(error.message, said)
      assert.ok(!error.message.includes(CODE) && !error.message.includes(WRONG), 'the refusal never repeats it')
      return true
    })
  }
  await assert.rejects(() => r.account.submitCode('no-such-flow', CODE), /not waiting for a code/)
  // None of that reached the command, which is still waiting and still signs in.
  await r.account.submitCode(start.loginId, CODE)
  assert.equal((await completion(r.events)).success, true)
})

test('the runtime relays a pasted code to its sign-in command, and refuses one for a flow that takes none', async () => {
  const runtime = new AcpRuntime({
    id: 'fake-acp',
    name: 'Fake ACP Agent',
    command: process.execPath,
    args: ['-e', ''],
    account: {
      login: {
        command: process.execPath,
        args: [FAKE_CLI, 'login'],
        env: { FAKE_CLI_LOGIN: 'paste', FAKE_CLI_CODE: CODE },
        pasteCode: PROMPT,
      },
    },
  })
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  try {
    const start = await runtime.login('cli-browser')
    await until(
      () => (start.type === 'browser' && start.pasteCode === true)
        || events.some((event) => event.type === 'account/loginAwaitsCode'),
      'the ask for a code',
    )
    await runtime.submitLoginCode(start.loginId, CODE)
    assert.equal((await completion(events)).success, true)
    await assert.rejects(() => runtime.submitLoginCode('another-flow', CODE), /not waiting for a code/)
    assert.ok(!JSON.stringify(events).includes(CODE))
  } finally {
    await runtime.dispose()
  }
})
