import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createLeadJournal, parseLeadJournalRecord, summarizeLeadArguments } from '@harnessdesk/lead'
import * as server from '../src/index.js'

const open = async (home: string): Promise<any> => {
  const factory = (server as Record<string, unknown>).openLeadFileJournal
  assert.equal(typeof factory, 'function', 'host supplies a crash-safe Lead journal under its state directory')
  return (factory as (home: string, thread: string) => Promise<unknown>)(home, 'thread-1')
}
const scratch = async (t: { after(fn: () => Promise<void>): void }) => {
  const home = await fs.mkdtemp(join(tmpdir(), 'hd-lead-home-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  return home
}
const policy = { version: 1 as const, revision: 1, mode: 'manage' as const, rules: [] }

test('disk journal serializes appends and recovery quarantines a truncated final record', async t => {
  const home = await scratch(t), disk = await open(home)
  const journal = await createLeadJournal(disk)
  await journal.setPolicy(policy)
  await disk.close()
  const file = join(home, 'lead', 'thread-1.ndjson')
  await fs.appendFile(file, '{"version":1,"seq":2')
  const recovered = await open(home)
  t.after(() => recovered.close())
  assert.equal((await recovered.read()).length, 2)
  assert.equal(recovered.report.truncatedTail, true)
  assert.ok(recovered.report.quarantine)
  assert.equal(await fs.readFile(recovered.report.quarantine, 'utf8'), '{"version":1,"seq":2')
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n'))
  await recovered.append(parseLeadJournalRecord({ version: 1, seq: 3, type: 'stop' }))
})

test('credentials and auth headers in arguments or provider failures never reach disk', async t => {
  const home = await scratch(t), disk = await open(home)
  t.after(() => disk.close())
  const journal = await createLeadJournal(disk)
  await journal.setPolicy(policy)
  const secret = 'sk-' + 'synthetic-secret-value-123456'
  const params = { headers: { Authorization: 'Bearer ' + secret }, secret, source: secret }
  await journal.execute({ id: 'attempt-1', request: { method: 'library/usage', params, project: null, runId: null, start: null },
    context: { desk: policy, projectPolicy: null, project: null, approved: null, budget: null, now: 0, policyInterpretation: 'idle' } },
  async () => { throw new Error('Authorization: Bearer ' + secret) })
  const body = await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')
  assert.ok(!body.includes(secret)); assert.ok(!/authorization|bearer/i.test(body))
  assert.equal((await disk.read()).length, 5)
  assert.equal(summarizeLeadArguments(params).fields[0]?.name, 'source')
})

test('one writer owns a thread, queued writes are durable and snapshots are isolated', async t => {
  const home = await scratch(t), disk = await open(home)
  await assert.rejects(open(home))
  await disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'policy', policy }))
  const pending = Array.from({ length: 12 }, (_, i) => disk.append(parseLeadJournalRecord({ version: 1, seq: i + 2, type: 'stop' })))
  const reading = disk.read()
  await Promise.all(pending)
  const records = await reading
  assert.equal(records.length, 13)
  records[0].policy.mode = 'plan'
  assert.equal((await disk.read())[0].policy.mode, 'manage')
  const file = join(home, 'lead', 'thread-1.ndjson')
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(join(home, 'lead'))).mode & 0o777, 0o700)
  await disk.close()
  const reopened = await open(home)
  t.after(() => reopened.close())
  assert.equal((await reopened.read()).length, 13)
})

test('complete-line corruption anywhere fails closed without changing the journal', async t => {
  for (const damage of ['middle', 'complete-tail', 'utf8']) {
    const home = await scratch(t), disk = await open(home)
    await disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'policy', policy }))
    await disk.append(parseLeadJournalRecord({ version: 1, seq: 2, type: 'stop' }))
    await disk.close()
    const file = join(home, 'lead', 'thread-1.ndjson')
    if (damage === 'middle') {
      const lines = (await fs.readFile(file, 'utf8')).split('\n'), frame = JSON.parse(lines[0]!)
      frame.record.policy.mode = 'plan'; lines[0] = JSON.stringify(frame)
      await fs.writeFile(file, lines.join('\n'))
    } else if (damage === 'complete-tail') await fs.appendFile(file, 'invalid complete record\n')
    else await fs.appendFile(file, Buffer.from([0xff, 0x0a]))
    const before = await fs.readFile(file)
    await assert.rejects(open(home))
    assert.deepEqual(await fs.readFile(file), before)
    assert.ok(!(await fs.readdir(join(home, 'lead'))).some(name => name.includes('truncated-')))
  }
})

test('record bounds, unknown fields and secret-bearing domain data are refused before writing', async t => {
  const home = await scratch(t), disk = await open(home)
  t.after(() => disk.close())
  await assert.rejects(disk.append({ version: 1, seq: 1, type: 'policy', policy, headers: { Authorization: 'Bearer synthetic' } }))
  await assert.rejects(disk.append({ version: 1, seq: 1, type: 'decision', id: 'attempt-1', effect: 'deny', reason: 'sk-' + 'synthetic-secret-value', rule: null }))
  await assert.rejects(disk.append({ version: 1, seq: 1, type: 'attempt', id: 'attempt-1', correlationId: 'attempt-1',
    method: 'library/usage', action: null, kind: 'read', stepId: null, policyRevision: null, projectPolicyRevision: null, contractRevision: null,
    arguments: { type: 'object', size: 2_000_000, fields: [] } }))
  assert.equal(await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8'), '')
  await assert.rejects((server as any).openLeadFileJournal(home, '../escape'))
})

test('fsync failure prevents dispatch even when the attempted line was written', async t => {
  const home = await scratch(t)
  const original = fs.open
  let handle: any
  const mock = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const result = await original(...args)
    if (String(args[0]).endsWith('.ndjson')) handle = result
    return result
  })
  const disk = await open(home), journal = await createLeadJournal(disk)
  await journal.setPolicy(policy)
  const sync = t.mock.method(handle, 'sync', async () => { throw new Error('simulated fsync failure') })
  let calls = 0
  await assert.rejects(journal.execute({ id: 'attempt-1', request: { method: 'library/usage', params: {}, project: null, runId: null, start: null },
    context: { desk: policy, projectPolicy: null, project: null, approved: null, budget: null, now: 0, policyInterpretation: 'idle' } },
    async () => { calls++; return { value: null, identity: null } }))
  assert.equal(calls, 0)
  sync.mock.restore(); mock.mock.restore()
  await disk.close()
  const recovered = await open(home)
  t.after(() => recovered.close())
  const owner = await createLeadJournal(recovered)
  assert.equal((await owner.recover(async () => []))[0]?.type, 'not-dispatched')
})

test('an OS-released writer lease permits recovery after process death', { timeout: 10_000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const home = await scratch(t)
  const module = new URL('../src/lead/journal.js', import.meta.url).href
  const program = `import(${JSON.stringify(module)}).then(async m => { const j = await m.openLeadFileJournal(${JSON.stringify(home)}, 'thread-1'); console.log('ready'); setInterval(() => {}, 1000) })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { child.kill('SIGKILL') })
  const exited = once(child, 'exit')
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', bytes => { if (bytes.toString().includes('ready')) resolve() })
    child.once('error', reject)
    child.once('exit', () => reject(new Error('writer exited before ready')))
  })
  await ready
  await assert.rejects(open(home))
  child.kill('SIGKILL'); await exited
  const recovered = await open(home)
  t.after(() => recovered.close())
  assert.deepEqual(await recovered.read(), [])
})

test('a transition refusal does not poison the disk writer', async t => {
  const home = await scratch(t), disk = await open(home)
  t.after(() => disk.close())
  await assert.rejects(disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'result', id: 'unknown', outcome: 'succeeded', identity: null })))
  await disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'stop' }))
  assert.equal((await disk.read())[0].type, 'stop')
})

test('a hash-valid final frame without newline preserves its Stop', async t => {
  const home = await scratch(t), disk = await open(home)
  await disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'stop' }))
  await disk.close()
  const file = join(home, 'lead', 'thread-1.ndjson'), body = await fs.readFile(file)
  await fs.truncate(file, body.length - 1)
  const recovered = await open(home)
  t.after(() => recovered.close())
  assert.equal((await createLeadJournal(recovered)).state.phase, 'stopped')
  assert.equal(recovered.report.truncatedTail, false)
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n'))
})

test('torn tails block management durably and reports separate historical quarantines', async t => {
  const home = await scratch(t), disk = await open(home)
  await disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'policy', policy }))
  await disk.close()
  const file = join(home, 'lead', 'thread-1.ndjson')
  await fs.appendFile(file, '{"record":')
  const recovered = await open(home), journal = await createLeadJournal(recovered)
  t.after(() => recovered.close())
  assert.equal(journal.state.recoveryBlocked, true)
  assert.equal(recovered.report.truncatedTail, true)
  await journal.stop()
  await recovered.close()
  const again = await open(home)
  t.after(() => again.close())
  const owner = await createLeadJournal(again)
  assert.equal(owner.state.recoveryBlocked, true)
  assert.equal(again.report.truncatedTail, false)
  assert.equal(again.report.quarantine, null)
  assert.equal(again.report.historicalQuarantines.length, 1)
  await owner.resolveRecovery()
  assert.equal(owner.state.recoveryBlocked, false)
})

test('removing durable whole frames is detected by the lease head anchor', async t => {
  const home = await scratch(t), disk = await open(home)
  await disk.append(parseLeadJournalRecord({ version: 1, seq: 1, type: 'policy', policy }))
  await disk.append(parseLeadJournalRecord({ version: 1, seq: 2, type: 'stop' }))
  await disk.close()
  const file = join(home, 'lead', 'thread-1.ndjson'), body = await fs.readFile(file, 'utf8')
  await fs.writeFile(file, body.slice(0, body.indexOf('\n') + 1))
  let unexpectedlyOpened: any
  await assert.rejects(async () => { unexpectedlyOpened = await open(home); await unexpectedlyOpened.close() })
})

test('host canaries are refused before append without poisoning Stop', async t => {
  const home = await scratch(t), canary = 'synthetic-window-token-91b0c2d3'
  const disk = await (server as any).openLeadFileJournal(home, 'thread-1', { canaries: [canary] })
  t.after(() => disk.close())
  const journal = await createLeadJournal(disk)
  await assert.rejects(journal.setPolicy({ ...policy, rules: [{ id: canary, method: 'client/hello', action: null, project: null, effect: 'deny' }] }))
  await journal.stop()
  assert.ok(!(await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')).includes(canary))
})

test('checkpoints compact finished attempts and continue the chain after reopen', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  const request = { method: 'library/usage', params: {}, project: null, runId: null, start: null }
  const context = { desk: policy, projectPolicy: null, project: null, approved: null, budget: null, now: 0, policyInterpretation: 'idle' as const }
  for (let i = 0; i < 300; i++) await journal.execute({ id: `read-${i}`, request, context }, async () => ({ value: null, identity: null }))
  await disk.close()
  const file = join(home, 'lead', 'thread-1.ndjson')
  assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).split('\n')[0]!).record.type, 'checkpoint')
  const reopened = await open(home)
  t.after(() => reopened.close())
  const recovered = await createLeadJournal(reopened)
  assert.equal(recovered.state.seq, 1200)
  assert.ok(recovered.state.attempts.size <= 64)
  await recovered.stop()
  assert.equal(recovered.state.phase, 'stopped')
})

const seedReads = async (home: string, count: number) => {
  const { createHash } = await import('node:crypto')
  let previous = '0'.repeat(64), seq = 0
  const frames: string[] = []
  for (let n = 0; n < count; n++) for (const event of [
    { type: 'attempt', id: `read-${n}`, correlationId: `read-${n}`, method: 'library/usage', action: null,
      kind: 'read', stepId: null, policyRevision: null, projectPolicyRevision: null, contractRevision: null, arguments: { type: 'object', size: 0, fields: [] } },
    { type: 'decision', id: `read-${n}`, effect: 'allow', reason: 'policy', rule: null },
    { type: 'dispatch-start', id: `read-${n}`, dispatched: true },
    { type: 'result', id: `read-${n}`, outcome: 'succeeded', identity: null },
  ]) {
    const record = parseLeadJournalRecord({ version: 1, seq: ++seq, ...event })
    const checksum = createHash('sha256').update(JSON.stringify({ record, previous })).digest('hex')
    frames.push(JSON.stringify({ record, previous, checksum }) + '\n'); previous = checksum
  }
  await fs.mkdir(join(home, 'lead'), { recursive: true })
  await fs.writeFile(join(home, 'lead', 'thread-1.ndjson'), frames.join(''))
}

test('checkpoint replacement recovers crashes before and after atomic rename', async t => {
  for (const boundary of ['before', 'after']) {
    const home = await scratch(t)
    await seedReads(home, 256)
    const rename = fs.rename
    const fault = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (boundary === 'after') await rename(...args)
      throw new Error('simulated rotation death')
    })
    await assert.rejects(open(home))
    fault.mock.restore()
    const disk = await open(home)
    t.after(() => disk.close())
    const journal = await createLeadJournal(disk)
    assert.equal(journal.state.seq, 1024, boundary)
    await journal.stop()
    assert.equal(journal.state.phase, 'stopped')
  }
})

test('sealed audit corruption fails closed after compaction', async t => {
  const home = await scratch(t)
  await seedReads(home, 256)
  const disk = await open(home)
  await disk.close()
  const segment = (await fs.readdir(join(home, 'lead'))).find(name => name.includes('.sealed-'))!
  await fs.appendFile(join(home, 'lead', segment), 'corruption')
  await assert.rejects(open(home))
})

test('normal state admission reserves space for plan approval Stop and status records', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  await journal.setPolicy(policy)
  const contract = { version: 1 as const, revision: 1, digest: 'a'.repeat(64), goal: 'Synthetic capacity probe',
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'implement', title: 'Implement', flow: 'lead-reviewed-result', sourceRevision: 'source-1',
      variables: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`input-${i}`, 'v'.repeat(16_384)])),
      attendance: 'attended' as const, assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' as const }, ceiling: 'edit' as const }] }],
    assertions: [{ id: 'check', kind: 'check' as const, description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
  let last = ''
  for (let i = 0; i < 12; i++) {
    last = `plan-${i}`
    await journal.offerCard({ version: 1, id: last, revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  }
  await assert.rejects(journal.offerCard({ version: 1, id: 'over-capacity', revision: 1, type: 'plan', contractDigest: contract.digest, contract }))
  // Approval duplicates the active contract into reduced state. That reserved growth
  // must not make terminal writes or the final status report fail validation.
  await journal.decideCard({ version: 1, cardId: last, cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 200)
  await journal.stop()
  assert.equal((await journal.execute({ id: 'status-1', request: { method: 'library/usage', params: {}, project: null, runId: null, start: null },
    context: { desk: policy, projectPolicy: null, project: null, approved: null, budget: null, now: 0, policyInterpretation: 'idle' } },
    async () => ({ value: null, identity: null }))).outcome, 'succeeded')
  await disk.close()
  const reopened = await open(home)
  t.after(() => reopened.close())
  assert.equal((await createLeadJournal(reopened)).state.phase, 'stopped')
})

test('masked card prose and broker variable references reach disk before their new digest is approved', async t => {
  const home = await scratch(t), canary = 'synthetic-provider-canary-91b0c2d3', token = 'gho_' + 'A'.repeat(36)
  const disk = await (server as any).openLeadFileJournal(home, 'thread-1', { canaries: [canary], brokerReference: () => 'broker:input-1' })
  t.after(() => disk.close())
  const journal = await createLeadJournal(disk)
  await journal.setPolicy(policy)
  const contract = { version: 1 as const, revision: 1, digest: 'a'.repeat(64), goal: `Fix authorization middleware ${token}; Cookie: session=synthetic-cookie-91b0c2d3`,
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'implement', title: 'Implement', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: { api_key: canary },
      attendance: 'attended' as const, assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' as const }, ceiling: 'edit' as const }] }],
    assertions: [{ id: 'check', kind: 'check' as const, description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
  const offered = await journal.offerCard({ version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  assert.equal(offered.type, 'plan')
  if (offered.type !== 'plan') throw new Error('wrong fixture card')
  assert.equal(offered.contract.steps[0]!.variables.api_key, 'broker:input-1')
  assert.notEqual(offered.contractDigest, contract.digest)
  const click = { version: 1 as const, cardId: 'plan-1', cardType: 'plan' as const, expectedRevision: 1, choice: 'approve' as const, contractDigest: contract.digest }
  await assert.rejects(journal.decideCard(click, 200))
  await journal.decideCard({ ...click, contractDigest: offered.contractDigest }, 200)
  await journal.stop()
  const body = await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')
  for (const secret of [canary, token, 'session=synthetic-cookie-91b0c2d3']) assert.ok(!body.includes(secret))
  assert.ok(body.includes('Fix authorization middleware'))
  assert.ok(body.includes('broker:input-1'))
})
