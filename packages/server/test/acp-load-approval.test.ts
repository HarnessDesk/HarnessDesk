import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { Host, Logger, StateStore } from '../src/index.js'
import type { AttachmentReview, Session } from '@harnessdesk/protocol'
import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop } from './fixtures/harness.js'

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, 'synthetic load approval did not settle'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
for (const mode of ['policy', 'human'] as const) test(`a ${mode} permission requested before ACP load reply survives reopen`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-load-approval-')), output = join(dir, 'permission.log'), replyGate = join(dir, 'load-reply')
  const runtime = new AcpRuntime({ id: 'fixture', name: 'Fixture', command: process.execPath, args: [PEER],
    env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_LOAD_APPROVAL_FILE: output, FAKE_ACP_LOAD_REPLY_GATE: replyGate } })
  const options = { logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 25, sessionRestMs: 25 }
  const host = new Host(options)
  t.after(async () => { writeFileSync(replyGate, ''); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  let requested = 0
  runtime.subscribe(event => { if (event.type === 'approval/requested') requested++ })
  host.register(runtime); await host.start()
  if (mode === 'policy') await host.call('app/state/set', { patch: { permissionPolicy: [{ id: 'allow', name: 'Allow', match: { type: 'permission' }, action: 'approve' }] } })
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
  const params = { runtime: runtime.info.id, sessionId: session.id as never }
  await host.call('turn/send', { ...params, input: [{ type: 'text', text: 'Persist this conversation.' }] })
  const record = host.registry.get(runtime.info.id, params.sessionId)!
  await waitFor(() => record.live === null)
  options.sessionRestMs = 0 // Keep the reopened handle alive while checking the pending permission.
  const opening = host.call('session/resume', params)
  await waitFor(() => existsSync(output) && readFileSync(output, 'utf8').includes('requested') && requested === 1)
  assert.equal(record.live, null, 'the real ACP request arrived before load could reply and publish its handle')
  assert.equal(readFileSync(output, 'utf8').includes('answered'), false, 'the pending permission is not answered during load')
  writeFileSync(replyGate, '')
  await opening
  if (mode === 'human') {
    await waitFor(() => record.approvals.size === 1)
    const approval = [...record.approvals.values()][0]!
    await host.call('approval/respond', { ...params, approvalId: approval.id, decision: { type: 'option', optionId: 'yes' } })
  }
  await waitFor(() => readFileSync(output, 'utf8').includes('answered'))
  const lines = readFileSync(output, 'utf8').trim().split('\n')
  assert.equal(lines.filter(line => line.startsWith('answered ')).length, 1)
  assert.match(lines.find(line => line.startsWith('answered '))!, /selected/)
})

for (const mode of ['policy', 'human'] as const) test(`a ${mode} pre-load permission waits for a filtered Seat receipt`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-filtered-load-')), work = join(dir, 'work'), home = join(dir, 'library')
  await mkdir(work); await mkdir(home); execFileSync('git', ['init', '-q', work])
  const store = join(dir, 'sessions.json'), output = join(dir, 'approval.log'), replyGate = join(dir, 'load-reply')
  const peer = (gated: boolean) => new AcpRuntime({ id: 'rig-agent', name: 'Rig Agent', brand: 'claudecode', command: process.execPath, args: [PEER],
    env: { FAKE_ACP_ATTACHMENTS: '1', FAKE_ACP_AGENT_VERSION: '1.0.0', FAKE_ACP_STORE: store,
      ...(gated ? { FAKE_ACP_LOAD_APPROVAL_FILE: output, FAKE_ACP_LOAD_REPLY_GATE: replyGate } : {}) } })
  const first = await start({ libraryHome: home }, undefined, peer(false) as unknown as FakeRuntime)
  const agentDir = join(first.stateDir, 'agents', 'reviewer')
  await mkdir(join(agentDir, 'skills', 'demo'), { recursive: true })
  await writeFile(join(agentDir, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nCheck the diff.\n')
  await writeFile(join(agentDir, 'AGENT.md'), '---\nname: Reviewer\nceiling: merge\nprefer: [rig-agent]\nskills: [demo]\n---\nRead the diff.\n')
  const client = await Client.connect(first.server)
  await client.call('workspace/open', { path: work })
  const review = await client.call('attachment/review', { id: 'reviewer', origin: 'user', root: work }) as AttachmentReview
  await client.call('attachment/approve', { token: review.token })
  const session = await client.call('agent/seat', { id: 'reviewer', cwd: work, project: work, permission: 'merge' }) as Session
  const seat = first.host.registry.attachmentSeatOf(session.runtime, session.id)!
  await waitFor(() => { const r = first.host.registry.get(session.runtime, session.id); return !!r && r.running.size === 0 })
  client.close(); await halt(first)
  const runtime = peer(true), again = await start({ libraryHome: home, sessionRestMs: 0 }, first.stateDir, runtime as unknown as FakeRuntime)
  t.after(async () => { writeFileSync(replyGate, ''); await stop(again); await rm(dir, { recursive: true, force: true }) })
  const params = { runtime: runtime.info.id, sessionId: session.id }
  if (mode === 'policy') await again.host.call('app/state/set', { patch: { permissionPolicy: [{ id: 'allow', name: 'Allow', match: { type: 'permission' }, action: 'approve' }] } })
  let requested = 0; runtime.subscribe(event => { if (event.type === 'approval/requested') requested++ })
  let begin!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { begin = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const original = again.host.attachmentsPlane.record.bind(again.host.attachmentsPlane)
  t.mock.method(again.host.attachmentsPlane, 'record', async (...args: Parameters<typeof original>) => { begin(); await held; return original(...args) })
  const opening = again.host.call('session/resume', params)
  try {
    await waitFor(() => existsSync(output) && requested === 1)
    assert.equal(again.host.registry.get(session.runtime, session.id)?.live ?? null, null)
    assert.equal(readFileSync(output, 'utf8').includes('answered'), false)
    writeFileSync(replyGate, '')
    await entered
    assert.equal(readFileSync(output, 'utf8').includes('answered'), false, 'no permission response before receipt')
    release(); await opening
    assert.equal((await again.host.attachmentsPlane.read(seat))?.epoch, 1)
    const record = again.host.registry.get(session.runtime, session.id)!
    if (mode === 'human') {
      await waitFor(() => record.approvals.size === 1)
      const approval = [...record.approvals.values()][0]!
      await again.host.call('approval/respond', { ...params, approvalId: approval.id, decision: { type: 'option', optionId: 'yes' } })
    }
    await waitFor(() => readFileSync(output, 'utf8').includes('answered'))
    const lines = readFileSync(output, 'utf8').trim().split('\n')
    assert.equal(lines.filter(line => line.startsWith('answered ')).length, 1)
    assert.match(lines.find(line => line.startsWith('answered '))!, /selected/)
  } finally { release(); writeFileSync(replyGate, ''); await opening.catch(() => {}) }
})

test('retiring a pre-load ACP approval does not answer a replacement owner', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-acp-load-retired-')), output = join(dir, 'permission.log'), gate = join(dir, 'load-reply')
  const runtime = new AcpRuntime({ id: 'fixture', name: 'Fixture', command: process.execPath, args: [PEER],
    env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_LOAD_APPROVAL_FILE: output, FAKE_ACP_LOAD_REPLY_GATE: gate } })
  const options = { logger: new Logger('test', { console: false }), state: new StateStore(join(dir, 'state.json')),
    catalogRefreshMs: 0, idleStopMs: 25, sessionRestMs: 25 }
  const host = new Host(options)
  t.after(async () => { writeFileSync(gate, ''); await host.dispose(); await rm(dir, { recursive: true, force: true }) })
  let requests = 0; runtime.subscribe(event => { if (event.type === 'approval/requested') requests++ })
  host.register(runtime); await host.start()
  const session = await host.call('session/create', { runtime: runtime.info.id, options: { cwd: dir } }) as { id: string }
  const params = { runtime: runtime.info.id, sessionId: session.id as never }
  await host.call('turn/send', { ...params, input: [{ type: 'text', text: 'Persist this conversation.' }] })
  const record = host.registry.get(runtime.info.id, params.sessionId)!
  await waitFor(() => record.live === null); options.sessionRestMs = 0
  const opening = host.call('session/resume', params), result = opening.then(() => 'resolved', () => 'rejected')
  await waitFor(() => existsSync(output) && requests === 1)
  assert.equal(readFileSync(output, 'utf8').includes('answered'), false)
  const stopping = runtime.connectionFor(params.sessionId).stop()
  writeFileSync(gate, '')
  await stopping
  assert.equal(await result, 'rejected')
  await host.dispose()
  const runtime2 = new AcpRuntime({ id: 'fixture', name: 'Fixture', command: process.execPath, args: [PEER],
    env: { FAKE_ACP_STORE: join(dir, 'store.json'), FAKE_ACP_LOAD_APPROVAL_FILE: output, FAKE_ACP_LOAD_REPLY_GATE: gate } })
  const host2 = new Host({ ...options, state: new StateStore(join(dir, 'state.json')), sessionRestMs: 0 })
  t.after(() => host2.dispose())
  let replacementRequests = 0; runtime2.subscribe(event => { if (event.type === 'approval/requested') replacementRequests++ })
  host2.register(runtime2); await host2.start()
  const replacement = host2.call('session/resume', params)
  await waitFor(() => replacementRequests === 1)
  await replacement
  const newer = host2.registry.get(runtime2.info.id, params.sessionId)!
  const lines = readFileSync(output, 'utf8').trim().split('\n')
  assert.equal(lines.filter(line => line.includes('"outcome":"selected"')).length, 0, 'old permission never grants a replacement')
  await waitFor(() => newer.approvals.size === 1)
  assert.equal(newer.approvals.size, 1, 'replacement owns its own unanswered permission')
})
