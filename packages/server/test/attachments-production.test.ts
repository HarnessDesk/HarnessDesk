import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AttachmentSubject } from '../src/attachments/plane.js'
import type { Session } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { builtinAgentRoot } from '../src/host.js'
import { resolveAttachmentDeclarations } from '../src/attachments/catalog.js'
import { incarnationOf } from '../src/evidence/seen.js'
import { attachmentGateway } from '../src/attachments/wiring.js'
import { ToolGateway } from '../src/tool-gateway.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The production path this phase leaves stubbed no longer: a real `Host`,
 * over its real socket, in front of a fake runtime that actually implements
 * phase 12's attachment contract — proving the receipt a kept Seat records
 * is read back from the runtime, never assumed, and that the real MCP
 * gateway (built the same way `bootstrap.ts` builds it, not a stand-in for
 * it) refuses a call it never approved.
 */

const SKILL_TEXT = '---\nname: demo\ndescription: demo skill\n---\nDo the thing.\n'
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

test('a Seat seated with an approved attachment gets a receipt with a true loaded set', async (t) => {
  const runtime = new FakeRuntime({
    id: 'fake' as never,
    attachments: {
      runtime: 'fake',
      build: '1.0.0',
      skills: 'scoped',
      mcp: 'unsupported',
      suppressUnapproved: true,
      reason: null,
    },
  })
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const work = tempDir('hd-attach-e2e-work-')

  // A user-scoped Agent declaring one skill, with a real bundle on disk — the
  // exact shape `resolveAttachmentDeclarations` reads, never a command. User
  // scope, like the rest of this suite's fixtures, needs no open project.
  const agentDir = join(harness.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'demo', 'SKILL.md'), SKILL_TEXT, 'utf8')
  await writeFile(
    join(agentDir, 'AGENT.md'),
    '---\nname: Reviewer\npermission: read\nprefer: [fake=fake-1]\nskills: [demo]\n---\nRead the diff.\n',
    'utf8',
  )

  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: work })

  // The same read the host itself does — a fresh `Agents` pointed at the
  // same paths, not a second implementation of it — so the digest and
  // resolved identity below are exactly what `seatAgent` will compute.
  const agents = new Agents({ user: join(harness.stateDir, 'agents'), builtin: builtinAgentRoot() })
  const entry = await agents.read('reviewer')
  assert.ok(entry?.definition && entry.digest, 'the Agent file must parse before this test can approve anything for it')
  const { resolved } = await resolveAttachmentDeclarations(entry, work)
  assert.equal(resolved.length, 1, 'exactly the one declared skill must resolve')

  // `seatAgent` computes `incarnation` from `project ?? params.cwd`; a plain
  // `agent/seat` call with no `project` names none, so it falls to `cwd`.
  const incarnation = await incarnationOf(work)
  const subject: AttachmentSubject = {
    project: work,
    incarnation,
    agent: 'reviewer',
    origin: 'user',
    agentDigest: entry.digest!,
    runtime: 'fake',
    build: '1.0.0',
    // Legacy `permission: read` maps to ceiling **`edit`**, not `read` —
    // `ceilingOfPermission` in `@harnessdesk/protocol/ceiling.ts` is explicit
    // that the old "read" word is the new model's `edit` floor. A plain
    // `agent/seat` call with no explicit grant also defaults to `edit`
    // (`grantOf(undefined)`), so `narrower('edit', 'edit')` is `edit` either way.
    ceiling: 'edit',
  }
  const review = await harness.host.attachmentTrust.preview(subject, resolved)
  await harness.host.attachmentTrust.approve(review.token)

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal(session.settings?.agent, 'reviewer')

  // The receipt: read from the runtime's own `attachmentReceipt`, which the
  // fake answers from what `createSession` actually handed it — never from
  // what was merely requested. If the wiring skipped this call, or fed the
  // runtime nothing to scope against, this comes back empty (the exact bug
  // `prepareAndRecordAttachments` used to have, on purpose, until now).
  const record = await harness.host.attachmentsPlane.read(await seatIdFor(harness, session))
  assert.ok(record, 'a declared attachment must leave a durable record')
  assert.equal(record.results.length, 1)
  assert.equal(record.results[0]!.status, 'loaded', `the fake runtime actually reported this skill as loaded (reason: ${record.results[0]!.reason})`)
  assert.equal(record.results[0]!.identity.name, 'demo')
  assert.equal(record.results[0]!.identity.digest, resolved[0]!.identity.digest, 'the exact bytes approved, not merely a name match')

  // And the runtime really was scoped, not merely asked afterwards: what it
  // was actually handed at `createSession` names this one skill and nothing else.
  const given = runtime.lastCreateOptions?.attachments
  assert.deepEqual(given?.skills?.map((one) => one.name), ['demo'])
})

/** The Seat id a just-kept conversation was opened as — read off the durable evidence, the way a real caller would. */
const seatIdFor = async (harness: Awaited<ReturnType<typeof start>>, session: Session) => {
  const seats = harness.host.attachmentsPlane
  // The registry is the desk's own record of which Seat this live
  // conversation's attachments were frozen under (`recordAttachmentSeat`),
  // which is exactly what the tool gateway itself relies on.
  const seat = harness.host.registry.attachmentSeatOf(session.runtime, session.id)
  assert.ok(seat, 'seatAgent must have recorded which Seat this conversation’s attachments were frozen under')
  void seats
  return seat
}

test('an unapproved MCP tool call is refused at the real gateway, over its own socket', async (t) => {
  const runtime = new FakeRuntime({
    attachments: {
      runtime: 'fake',
      build: '1.0.0',
      skills: 'unsupported',
      mcp: 'scoped-gated',
      suppressUnapproved: true,
      reason: null,
    },
  })
  const harness = await start({}, undefined, runtime)
  t.after(() => stop(harness))
  const work = tempDir('hd-attach-e2e-mcp-work-')
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await client.call('workspace/open', { path: work })

  await mkdir(join(harness.stateDir, 'agents', 'reviewer'), { recursive: true })
  await writeFile(
    join(harness.stateDir, 'agents', 'reviewer', 'AGENT.md'),
    '---\nname: Reviewer\npermission: merge\nprefer: [fake=fake-1]\n---\nRead the diff.\n',
    'utf8',
  )
  // No `mcp:` declared at all: this Seat approves nothing and loads nothing.
  // The point of this test is that a call naming a server anyway — the way a
  // compromised or merely confused bridge process might — is refused by the
  // real gateway before it ever reaches a process, not merely absent from a listing.
  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session

  // Built exactly the way `bootstrap.ts` builds its own gateway — the real
  // `AttachmentsPlane`/`CeilingGate` this same Host just seated the Agent
  // through, plus a `callers` map standing in for the one an adapter mints
  // into a spawned bridge's environment (`HD_TOOLS_CALLER`), which this test
  // has no bridge process to actually spawn.
  const callers = new Map<string, { runtime: string; sessionId: string }>()
  const token = 'test-caller-token'
  callers.set(token, { runtime: String(session.runtime), sessionId: String(session.id) })
  const socketDir = tempDir('hd-attach-e2e-sock-')
  const socketPath = join(socketDir, 'tools.sock')
  // `bootstrap.ts`'s own wiring, not a copy of it.
  const gateway = new ToolGateway(socketPath, {
    listTools: () => [],
    invokeByName: async () => ({ ok: false, error: 'not used by this test' }),
    ...attachmentGateway(() => harness.host, (one) => callers.get(one)),
  })
  gateway.start()
  t.after(() => gateway.stop())

  const { connect } = await import('node:net')
  const send = async (payload: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = connect(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const line = buffer.indexOf('\n')
        if (line === -1) return
        socket.end()
        resolve(JSON.parse(buffer.slice(0, line)))
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('gateway did not answer')), 5000).unref()
    })

  // Discovery first: the server this Seat never approved is not even listed.
  const listing = (await send({ id: 1, method: 'mcp/list', params: { caller: token } })) as { result: { tools: unknown[] } }
  assert.deepEqual(listing.result.tools, [], 'a Seat with nothing approved lists no external server at all')

  // And a direct call by name — never discovered, only guessed — is refused
  // by the real gateway over the real socket, before anything is dialed. This
  // Seat never loaded any server at all, so its frozen list is `null`
  // (`AttachmentsPlane#live` has no entry for it), which `McpToolGateway`
  // answers the same way it answers a revoked or closed Seat — a real,
  // deliberate refusal, not the "hidden tool" wording a Seat with some
  // *other* approved server would get for guessing this one's name instead.
  const called = (await send({
    id: 2,
    method: 'mcp/call',
    params: { caller: token, server: 'reviewer-tools', tool: 'flag_issue', args: {} },
  })) as { result: { ok: boolean; reason?: string } }
  assert.equal(called.result.ok, false)
  assert.equal(called.result.reason, 'This connection is no longer live. Start a new Seat to reach this server.')

  // And the plainest case of all: a token this desk never minted for any
  // conversation, over the very same socket. No `callers` entry exists for
  // it, so the gateway cannot even find a Seat to ask about.
  const unknownCaller = (await send({
    id: 3,
    method: 'mcp/call',
    params: { caller: 'never-issued-token', server: 'reviewer-tools', tool: 'flag_issue', args: {} },
  })) as { result: { ok: boolean; reason?: string } }
  assert.equal(unknownCaller.result.ok, false)
  assert.equal(unknownCaller.result.reason, 'This connection is no longer live. Start a new Seat to reach this server.')
})
