import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { AgentEvent, LoginStart } from '@harnessdesk/protocol'

import { Logger, serve } from '../src/index.js'
import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * A pasted sign-in code, the whole way: from the socket, through the wire
 * validator and `runtime/login/code`, into a real `AcpRuntime`'s sign-in
 * command's input — a child process that reads it the way the real command
 * does. The code must come out of none of it: no event, no answer, and no
 * line of the host's log, the socket's included, at debug level.
 */

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const CLI = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-agent-cli.mjs', import.meta.url))
const CODE = 'right-code-7f3a#state-91c2'
const WRONG = 'wrong-code-0b1d#state-44e0'

test('a pasted code goes from the socket to the sign-in command and is repeated nowhere', async (t) => {
  const file = join(tempDir('hd-login-code-'), 'host.log')
  const logger = new Logger('test', { level: 'debug', console: false, file })
  const runtime = new AcpRuntime({
    id: 'rig-agent',
    name: 'Rig Agent',
    command: process.execPath,
    args: [PEER],
    logger,
    account: {
      login: {
        command: process.execPath,
        args: [CLI, 'login'],
        env: { FAKE_CLI_LOGIN: 'paste', FAKE_CLI_CODE: CODE },
        pasteCode: 'Paste code here if prompted',
        pasteCodeRejected: 'Invalid code. Please make sure the full code was copied.',
      },
    },
  })
  const harness = await start({ logger }, undefined, runtime as unknown as FakeRuntime)
  t.after(() => stop(harness))
  // The socket's own logger too: a method that fails is logged there.
  const server = await serve({ host: harness.host, logger, port: 0 })
  t.after(() => server.close())
  const client = await Client.connect(server)
  t.after(() => client.close())

  const asked = (loginId: string, refused: boolean): boolean =>
    client.events.some((event) => event.type === 'account/loginAwaitsCode' && event.loginId === loginId && (event.refused ?? false) === refused)
  const ended = (loginId: string): Extract<AgentEvent, { type: 'account/loginCompleted' }> | undefined =>
    client.events.find((event): event is Extract<AgentEvent, { type: 'account/loginCompleted' }> =>
      event.type === 'account/loginCompleted' && event.loginId === loginId)
  const login = async (): Promise<LoginStart & { type: 'browser' }> => {
    const start = (await client.call('runtime/login', { runtime: 'rig-agent', method: 'cli-browser' })) as LoginStart & { type: 'browser' }
    await client.until(() => start.pasteCode === true || asked(start.loginId, false), 5_000, 'the ask for a code')
    return start
  }
  const paste = (loginId: string, code: string): Promise<unknown> =>
    client.call('runtime/login/code', { runtime: 'rig-agent', loginId, code })

  // A paste cut short is refused, and the flow asks again rather than ending.
  const first = await login()
  const [cut] = WRONG.split('#')
  assert.equal(await paste(first.loginId, cut!), null)
  await client.until(() => asked(first.loginId, true), 5_000, 'the second ask')
  assert.equal(ended(first.loginId), undefined)
  // A wrong whole code ends it, in the command's words with every part struck out.
  await paste(first.loginId, WRONG)
  await client.until(() => ended(first.loginId) !== undefined, 5_000, 'the failure')
  assert.equal(ended(first.loginId)?.success, false)
  assert.equal(ended(first.loginId)?.error, 'Login failed: the code [code] was refused (state [code]).')
  // And a code for a flow that has ended is refused in words that do not repeat it.
  await assert.rejects(() => paste(first.loginId, CODE), (error: Error) => {
    assert.match(error.message, /not waiting for a code/)
    assert.ok(!error.message.includes(CODE))
    return true
  })

  // The right code signs in.
  const second = await login()
  await paste(second.loginId, CODE)
  await client.until(() => ended(second.loginId) !== undefined, 5_000, 'the sign-in')
  assert.equal(ended(second.loginId)?.success, true)

  await logger.flush()
  const logged = await readFile(file, 'utf8')
  assert.match(logged, /method failed/, 'the refusal was logged')
  const said = `${JSON.stringify(client.events)}\n${logged}`
  for (const part of [CODE, WRONG, ...CODE.split('#'), ...WRONG.split('#')]) {
    assert.ok(!said.includes(part), 'no part of a pasted code reached an event or the log')
  }
})
