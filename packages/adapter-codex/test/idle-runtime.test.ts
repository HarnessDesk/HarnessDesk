import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AgentEvent, AgentRuntime } from '@harnessdesk/protocol'
import { CodexRuntime } from '../src/index.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
const running = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const until = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'the expected resource lifecycle settled')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const rig = async (t: TestContext, mode = 'hold') => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-codex-idle-'))
  const ledger = join(dir, 'children.ndjson')
  await writeFile(ledger, '')
  const runtime = new CodexRuntime({ binaryPath: FAKE, codexHome: dir,
    env: { FAKE_CODEX_MCP_CHILDREN: ledger, FAKE_CODEX_MODE: mode } })
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const events: AgentEvent[] = []
  runtime.subscribe((event) => events.push(event))
  await runtime.start()
  const children = async () => (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { threadId: string; pid: number; parent: number })
  const managed: AgentRuntime = runtime
  const stop = () => {
    assert.equal(typeof managed.stopForIdle, 'function', 'the adapter participates in the host idle reaper')
    return managed.stopForIdle!()
  }
  return { runtime, events, children, stop, dir }
}

test('closing finished threads retains their children until idle stop, then all children exit', async (t) => {
  const d = await rig(t)
  for (let n = 0; n < 3; n++) {
    const session = await d.runtime.createSession({ cwd: d.dir })
    await session.close()
  }
  const children = await d.children()
  assert.equal(children.length, 3)
  assert.ok(children.every((child) => running(child.pid)), 'unsubscribe alone keeps the measured children')
  assert.equal(await d.stop(), true)
  await until(() => children.every((child) => !running(child.pid)))
  assert.deepEqual(d.runtime.health(), { state: 'idle' })
  assert.equal(await d.stop(), false, 'a second idle stop does nothing')
})

test('an open conversation and a working turn keep their children alive', async (t) => {
  const d = await rig(t)
  const finished = await d.runtime.createSession({ cwd: d.dir })
  await finished.close()
  const active = await d.runtime.createSession({ cwd: d.dir })
  assert.equal(await d.stop(), false, 'an open handle still belongs to the host')
  await active.send([{ type: 'text', text: 'Keep working' }])
  await until(() => d.events.some((event) => event.type === 'turn/started'))
  assert.equal(await d.stop(), false)
  assert.ok((await d.children()).every((child) => running(child.pid)))
  await active.interrupt()
  await until(() => d.events.some((event) => event.type === 'turn/completed'))
  await active.close()
  const children = await d.children()
  assert.equal(await d.stop(), true)
  await until(() => children.every((child) => !running(child.pid)))
})

test('idle stop keeps learned models, options, account and history readable and resumes the same conversation', async (t) => {
  const d = await rig(t)
  const session = await d.runtime.createSession({ cwd: d.dir })
  const info = d.runtime.info
  const models = await d.runtime.listModels()
  const options = await d.runtime.listOptions()
  const defaults = await d.runtime.defaultSessionOptions(d.dir)
  const account = await d.runtime.getAccount()
  await session.close()
  const history = await d.runtime.listSessions()
  const children = await d.children()
  assert.equal(await d.stop(), true)
  await until(() => children.every((child) => !running(child.pid)))
  assert.deepEqual(d.runtime.info, info)
  assert.deepEqual(await d.runtime.listModels(), models)
  assert.deepEqual(await d.runtime.listOptions(), options)
  assert.deepEqual(await d.runtime.defaultSessionOptions(d.dir), defaults)
  assert.deepEqual(await d.runtime.getAccount(), account)
  assert.deepEqual(await d.runtime.listSessions(), history)
  assert.deepEqual(await d.runtime.listSessions({ archived: 'exclude' }), history, 'equivalent history queries keep their cached rows')
  assert.deepEqual(d.runtime.health(), { state: 'idle' }, 'reads do not restart or sign out the runtime')
  await d.runtime.start()
  const resumed = await d.runtime.resumeSession(session.id, { cwd: d.dir })
  assert.equal(resumed.id, session.id)
  assert.deepEqual(d.runtime.health(), { state: 'ready' })
  assert.ok((await d.children()).some((child) => child.parent !== children[0]!.parent && running(child.pid)))
})

test('a standalone terminal keeps an otherwise unused runtime running', async (t) => {
  const d = await rig(t)
  const terminal = await d.runtime.processes.spawn({ cwd: d.dir,
    command: [process.execPath, '-e', 'process.stdin.resume()'], tty: false })
  assert.equal(await d.stop(), false, 'idle stop must preserve a terminal outside a conversation')
  const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()))
  await terminal.kill()
  await exited
  assert.equal(await d.stop(), true)
})
