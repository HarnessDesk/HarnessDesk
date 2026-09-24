import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AttachmentReview, Session } from '@harnessdesk/protocol'

import { attachmentGateway } from '../src/attachments/wiring.js'
import { ToolGateway } from '../src/tool-gateway.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop, type Harness } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * Phase 12's whole journey over the real wire, on a real `Host`: a person
 * reviews what an Agent would load, approves it, and the Agent is seated —
 * then the conversation lives on through the events a Seat outlives. Every
 * step goes through the same wire methods the app calls, never a host
 * internal, so a review that approves something `agent/seat` would never
 * accept (a different ceiling, a different runtime) fails here.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
const SKILL_TEXT = '---\nname: demo\ndescription: demo skill\n---\nDo the thing.\n'

/** A fake that implements the attachment contract and reads the Library the way a Claude Code runtime would. */
export const capableRuntime = (): FakeRuntime =>
  new FakeRuntime({
    brand: 'claudecode',
    attachments: { runtime: 'fake', build: '1.0.0', skills: 'scoped', mcp: 'scoped-gated', suppressUnapproved: true, reason: null },
  })

export interface Desk {
  readonly harness: Harness
  readonly client: Client
  readonly runtime: FakeRuntime
  readonly work: string
  /** Stops the host and leaves its state for another to start on — a restart's first half. */
  halt(): Promise<void>
}

/**
 * A desk with one project that declares a Library server in its own
 * `.mcp.json`, and one personal Agent at `merge` that carries one skill of
 * its own and that server. `libraryHome` keeps the Library scan off the
 * machine this runs on.
 */
export const deskWithMergeAgent = async (t: { after(fn: () => unknown): void }, runtime = capableRuntime()): Promise<Desk> => {
  const home = tempDir('hd-attach-life-home-')
  const harness = await start({ libraryHome: home }, undefined, runtime)
  let halted = false
  t.after(async () => {
    if (!halted) await stop(harness)
  })
  const work = tempDir('hd-attach-life-work-')
  execFileSync('git', ['init', '-q', work])
  await writeFile(
    join(work, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'reviewer-tools': { command: process.execPath, args: [FIXTURE] } } }),
  )
  const agentDir = join(harness.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'demo', 'SKILL.md'), SKILL_TEXT)
  await writeFile(
    join(agentDir, 'AGENT.md'),
    '---\nname: Reviewer\nceiling: merge\nprefer: [fake=fake-1]\nskills: [demo]\nmcp: [reviewer-tools]\n---\nRead the diff.\n',
  )
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: work })
  return {
    harness,
    client,
    runtime,
    work,
    halt: async () => {
      halted = true
      client.close()
      await halt(harness)
    },
  }
}

export const reviewAndApprove = async (desk: Desk): Promise<AttachmentReview> => {
  // No runtime named: the host answers for the one `agent/seat` would choose.
  const review = (await desk.client.call('attachment/review', { id: 'reviewer', origin: 'user', root: desk.work })) as AttachmentReview
  await desk.client.call('attachment/approve', { token: review.token })
  return review
}

export const recordOf = async (desk: Desk, session: Session) => {
  const seat = desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id)
  assert.ok(seat, 'the seated conversation names the Seat its attachments were frozen under')
  const record = await desk.harness.host.attachmentsPlane.read(seat)
  assert.ok(record)
  return record
}

const statuses = (record: { readonly results: readonly { identity: { kind: string; name: string }; status: string }[] }) =>
  record.results.map((one) => `${one.identity.kind}:${one.identity.name}:${one.status}`)

test('review, approve, then agent/seat: a merge-ceiling Agent loads its skill and its server at merge, and its skill at the default ceiling', async (t) => {
  const desk = await deskWithMergeAgent(t)
  const review = await reviewAndApprove(desk)
  assert.equal(review.runtime, 'fake', 'the review is for the runtime the Seat will actually run on')
  assert.equal(review.effectiveCeiling, 'merge')
  assert.deepEqual(review.declarations.map((one) => `${one.kind}:${one.name}`), ['skill:demo', 'mcp:reviewer-tools'])

  const atMerge = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  const merged = await recordOf(desk, atMerge)
  assert.deepEqual(statuses(merged), ['skill:demo:loaded', 'mcp:reviewer-tools:loaded'], JSON.stringify(merged.results))

  // The default seating (no permission) runs at `edit`: the approval, given
  // at the Agent's own `merge`, still covers it — a narrower Seat is less
  // authority, never more — so the skill loads. The server does not: an
  // external server is `merge` by decision 13, and says so.
  const byDefault = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  const plain = await recordOf(desk, byDefault)
  assert.deepEqual(statuses(plain), ['skill:demo:loaded', 'mcp:reviewer-tools:not-loaded'])
  assert.match(plain.results[1]!.reason ?? '', /exceeds the Seat ceiling/)
})

test('a caller past the wire validator still cannot hand a runtime `attachments`: create, resume and fork strip it', async (t) => {
  const runtime = capableRuntime()
  const harness = await start({ libraryHome: tempDir('hd-attach-strip-home-') }, undefined, runtime)
  t.after(() => stop(harness))
  const work = tempDir('hd-attach-strip-work-')
  await harness.host.call('workspace/open', { path: work })
  const forged = { key: 'forged', skills: [{ name: 'x', digest: 'd'.repeat(64), path: '/anything' }], mcp: null }

  const created = await harness.host.call('session/create', { runtime: 'fake' as never, options: { cwd: work, attachments: forged } as never })
  assert.equal(runtime.lastCreateOptions?.attachments, undefined, 'session/create never forwards a client-supplied filter')

  await harness.host.call('session/resume', { runtime: 'fake' as never, sessionId: String(created.id) as never, options: { attachments: forged } as never })
  assert.equal(runtime.lastResumeOptions?.attachments, undefined, 'session/resume never forwards a client-supplied filter')

  await harness.host.call('session/fork', { runtime: 'fake' as never, sessionId: String(created.id) as never, options: { attachments: forged } as never }).catch(() => {})
  assert.equal(runtime.lastForkOptions?.attachments, undefined, 'session/fork never forwards a client-supplied filter')
})

/** What the runtime was actually handed when it (re)opened a conversation. */
const given = (runtime: FakeRuntime, id: string) => runtime.attachmentsGiven.get(id)

test('a restart, then session/resume: the Seat reopens on its frozen filter, revalidated, and appends an epoch — never native defaults', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  const opened = given(desk.runtime, String(session.id))
  assert.ok(opened)

  // The Agent's file changes while the desk is down: a new skill it now wishes for.
  const agentDir = join(desk.harness.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'later'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'later', 'SKILL.md'), '---\nname: later\n---\nNot approved.\n')
  await writeFile(
    join(agentDir, 'AGENT.md'),
    '---\nname: Reviewer\nceiling: merge\nprefer: [fake=fake-1]\nskills: [demo, later]\nmcp: [reviewer-tools]\n---\nRead the diff.\n',
  )
  await desk.halt()

  const runtime = capableRuntime()
  const again = await start({ libraryHome: tempDir('hd-attach-life-home2-') }, desk.harness.stateDir, runtime)
  t.after(() => stop(again))
  const client = await Client.connect(again.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: desk.work })
  await client.call('session/resume', { runtime: 'fake', sessionId: String(session.id) })

  const reopened = given(runtime, String(session.id))
  assert.ok(reopened, 'a reopen hands the runtime the Seat’s filter — without one it would load every ambient skill and server')
  assert.notEqual(reopened.key, opened.key, 'a reopen is its own observation, with its own key')
  assert.deepEqual(reopened.skills?.map((one) => `${one.name}:${one.digest}`), opened.skills?.map((one) => `${one.name}:${one.digest}`), 'the frozen skill, not the Agent’s current list')
  assert.deepEqual(reopened.mcp?.map((one) => one.name), ['reviewer-tools'])

  const seat = again.host.registry.attachmentSeatOf(session.runtime, session.id)
  assert.ok(seat, 'the reopened conversation names its Seat again, so the gateway can serve it')
  const record = await again.host.attachmentsPlane.read(seat)
  assert.equal(record?.epoch, 1)
  assert.deepEqual(statuses(record!), ['skill:demo:loaded', 'mcp:reviewer-tools:loaded'])
  assert.equal(again.host.attachmentsPlane.liveServersFor(seat)?.length, 1)
})

test('a reconnect after the runtime restarts re-applies the frozen filter too', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  const opened = given(desk.runtime, String(session.id))!
  // What an adapter's own restart looks like from the host: health leaves
  // `ready`, the process's sessions are gone, health returns.
  desk.runtime.setHealth({ state: 'starting' })
  desk.runtime.sessions.clear()
  desk.runtime.attachmentsGiven.clear()
  desk.runtime.setHealth({ state: 'ready' })

  await desk.client.call('turn/send', { runtime: 'fake', sessionId: String(session.id), input: [{ type: 'text', text: 'Carry on.' }] })
  const reopened = given(desk.runtime, String(session.id))
  assert.ok(reopened, 'the reconnect reopened the conversation on its filter')
  assert.notEqual(reopened.key, opened.key)
  assert.deepEqual(reopened.skills?.map((one) => one.digest), opened.skills?.map((one) => one.digest))
  const record = await desk.harness.host.attachmentsPlane.read(desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id)!)
  assert.equal(record?.epoch, 1)
})

test('a fork of a Seat that carries attachments is refused: it would run on the runtime’s own defaults', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  await assert.rejects(
    desk.client.call('session/fork', { runtime: 'fake', sessionId: String(session.id) }),
    /a fork of it would run without them/,
  )
  assert.equal(desk.runtime.lastForkOptions, null, 'the runtime was never asked to fork it')
})

test('bytes that change after approval are never loaded under the approved digest — refused before staging, or reported after it', async (t) => {
  const desk = await deskWithMergeAgent(t)
  await reviewAndApprove(desk)
  const skill = join(desk.harness.stateDir, 'agents', 'reviewer', 'skills', 'demo', 'SKILL.md')

  // Changed in the Agent's own folder after the approval: a different identity, so nothing approved it.
  await writeFile(skill, '---\nname: demo\n---\nDo something else.\n')
  const changed = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  assert.deepEqual(given(desk.runtime, String(changed.id))?.skills, [], 'the runtime is never handed bytes nobody approved')
  const refused = await recordOf(desk, changed)
  assert.equal(refused.results[0]!.status, 'not-loaded')
  assert.match(refused.results[0]!.reason ?? '', /Review this content/)

  // Back to the approved bytes; then the host's own staged copy is rewritten
  // after the Seat was prepared, before the runtime reports: the runtime
  // hashes what is there, and the host refuses it as different content.
  await writeFile(skill, '---\nname: demo\ndescription: demo skill\n---\nDo the thing.\n')
  desk.runtime.beforeAttachmentReceipt = async (input) => {
    for (const one of input.skills ?? []) await writeFile(join(one.path, 'SKILL.md'), 'swapped after approval')
  }
  const tampered = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work })) as Session
  const staged = given(desk.runtime, String(tampered.id))?.skills?.[0]
  assert.equal(
    staged?.path,
    join(await realpath(desk.harness.stateDir), 'attachments', 'staged', 'skill', staged?.digest ?? ''),
    'the runtime is handed the host’s own staged copy, under machine state — never the Agent’s folder',
  )
  const record = await recordOf(desk, tampered)
  assert.equal(record.results[0]!.status, 'not-loaded')
  assert.match(record.results[0]!.reason ?? '', /different content/)
})

const BRIDGE = fileURLToPath(new URL('../../../mcp-tools/dist/src/main.js', import.meta.url))

/** The desk's real tool bridge process, spoken to over MCP stdio exactly as an agent would. */
const bridgeFor = (socket: string, caller: string) => {
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, HD_TOOLS_SOCKET: socket, HD_TOOLS_CALLER: caller }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const waiting = new Map<number, (message: { result?: unknown; error?: { message?: string } }) => void>()
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; result?: unknown; error?: { message?: string } }
      buffer = buffer.slice(newline + 1)
      if (typeof message.id === 'number') waiting.get(message.id)?.(message)
    }
  })
  let next = 0
  const ask = (method: string, params: unknown = {}) =>
    new Promise<{ result?: unknown; error?: { message?: string } }>((resolve, reject) => {
      const id = ++next
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`${method} was not answered`)), 10_000).unref()
    })
  return { ask, close: () => child.kill('SIGKILL') }
}

test('an approved server is listed and callable through the desk’s real bridge and gateway — and not once the desk quits', async (t) => {
  const markerDir = tempDir('hd-attach-life-marker-')
  const marker = join(markerDir, 'calls.ndjson')
  const desk = await deskWithMergeAgent(t)
  await writeFile(
    join(desk.work, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'reviewer-tools': { command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_MARKER: marker, FAKE_MCP_CWD_FILE: join(markerDir, 'cwd') } } } }),
  )
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session

  // The socket `bootstrap.ts` serves, with `bootstrap.ts`'s own wiring behind it.
  const socket = join(tempDir('hd-sock-'), 't.sock')
  const callers = new Map([['caller-token', { runtime: 'fake', sessionId: String(session.id) }]])
  const gateway = new ToolGateway(socket, {
    listTools: () => [],
    invokeByName: async () => ({ ok: false, error: 'no plugin tools here' }),
    ...attachmentGateway(() => desk.harness.host, (token) => callers.get(token)),
  })
  gateway.start()
  const bridge = bridgeFor(socket, 'caller-token')
  t.after(async () => {
    bridge.close()
    await gateway.stop()
  })

  await bridge.ask('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  const listed = (await bridge.ask('tools/list')).result as { tools: { name: string }[] }
  assert.deepEqual(listed.tools.map((one) => one.name), ['flag_issue'], 'the approved server’s real tool, fetched from the running server')
  const called = (await bridge.ask('tools/call', { name: 'flag_issue', arguments: { line: 7 } })).result as { content: { text: string }[]; isError?: boolean }
  assert.equal(called.isError, false)
  assert.equal(called.content[0]!.text, 'flagged')
  assert.equal((await readFile(marker, 'utf8')).trim(), JSON.stringify({ line: 7 }), 'the server itself ran the call')
  // It ran in a folder this desk owns, never the repository the Seat works in:
  // a cloned repository's own config (an `.npmrc`, say) cannot steer what an
  // approved command resolves to.
  assert.equal(
    await realpath(await readFile(join(markerDir, 'cwd'), 'utf8')),
    await realpath(join(desk.harness.stateDir, 'attachments', 'run')),
  )

  // The desk quits: every live grant is revoked, so the same bridge reaches nothing.
  await desk.halt()
  const after = (await bridge.ask('tools/list')).result as { tools: { name: string }[] }
  assert.deepEqual(after.tools, [])
  assert.equal(desk.harness.host.attachmentsPlane.liveServersFor(desk.harness.host.registry.attachmentSeatOf(session.runtime, session.id)!), null)
})

test('dispose aborts an exchange in flight and closes what the wiring registered', async (t) => {
  const markerDir = tempDir('hd-attach-life-hang-')
  const pidFile = join(markerDir, 'pid')
  const desk = await deskWithMergeAgent(t)
  await writeFile(
    join(desk.work, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'reviewer-tools': { command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_HANG_CALL: '1', FAKE_MCP_PID_FILE: pidFile } } } }),
  )
  await reviewAndApprove(desk)
  const session = (await desk.client.call('agent/seat', { id: 'reviewer', cwd: desk.work, project: desk.work, permission: 'merge' })) as Session
  let closed = false
  desk.harness.host.onDispose(() => {
    closed = true
  })
  const backend = attachmentGateway(() => desk.harness.host, () => ({ runtime: 'fake', sessionId: String(session.id) }))
  const inFlight = backend.mcpCall('token', 'reviewer-tools', 'flag_issue', {}).then(
    () => 'answered',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  for (let tries = 0; tries < 100 && !(await readFile(pidFile, 'utf8').catch(() => '')); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  const pid = Number(await readFile(pidFile, 'utf8'))
  const quit = Date.now()
  await desk.halt()
  assert.match(await inFlight, /aborted/, 'the hung call ends with the desk, not after its own 45-second deadline')
  assert.ok(Date.now() - quit < 10_000)
  assert.equal(closed, true, 'what the wiring registered (the gateway socket) was closed')
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.throws(() => process.kill(pid, 0), 'no server outlives the desk')
})
