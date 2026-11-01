import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createLeadJournal, parseLeadJournalRecord, reduceLeadRecord, replayLeadJournal, leadCheckpoint, parseLeadCheckpoint, summarizeLeadArguments } from '@harnessdesk/lead'
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
const runEvidence = (identity: { correlationId: string; runId: string; teamId: string }, terminal = false) => ({ ...identity, firstRoundId: '1', terminal })

const policy = { version: 1 as const, revision: 1, mode: 'manage' as const, rules: [] }

test('file journal preflights a combined policy and caps update against successive states', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const previous = { ...policy, mode: 'default' as const }, caps = { usdMicros: 500, rounds: 3 }
  await journal.setPolicy(previous)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps, freshnessMs: 1000 })
  const before = journal.state.seq
  await journal.changePolicyAndBudgetCaps({ ...previous, revision: 2, mode: 'manage' }, { usdMicros: 1000, rounds: 4 }, before,
    { policy: 'policy-card', caps: 'caps-card' }, 100)
  assert.equal(journal.state.seq, before + 2)
  assert.deepEqual(journal.state.cards.map(card => card.type), ['permission-change', 'budget-change'])
  assert.deepEqual(journal.state.policy, previous)
  assert.deepEqual(journal.state.budget!.caps, caps)
  await disk.close()
  const reopened = await open(home)
  t.after(() => reopened.close())
  assert.deepEqual((await createLeadJournal(reopened)).state, journal.state)
})

test('file journal refuses the second combined event at its size bound before either card is appended', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const previous = { ...policy, mode: 'default' as const }, proposed = { ...policy, revision: 2 }, caps = { usdMicros: 500, rounds: 3 }
  await journal.setPolicy(previous)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps, freshnessMs: 1000 })
  const card = (id: string, length: number) => ({ version: 1 as const, id, revision: 1, type: 'plan' as const, contractDigest: 'a'.repeat(64),
    contract: { version: 1 as const, revision: 1, digest: 'a'.repeat(64), goal: 'Synthetic capacity probe', project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
      steps: [{ id: 'work', title: 'Review', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', attendance: 'attended' as const,
        variables: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`input-${i}`, 'v'.repeat(Math.max(0, Math.min(16384, length - i * 16384)))])),
        assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' as const }] }],
      assertions: [{ id: 'check', kind: 'check' as const, description: 'Checks pass' }], caps } })
  for (let i = 0; i < 12; i++) await journal.offerCard(card(`fill-${i}`, 40 * 16384))
  const permission = { version: 1 as const, id: 'policy-card', revision: 1, type: 'permission-change' as const, contractDigest: null, previous, proposed }
  const budget = { version: 1 as const, id: 'caps-card', revision: 1, type: 'budget-change' as const, logicalGoalId: 'logical', contractDigest: null,
    previous: { revision: journal.state.budget!.capsRevision, caps }, proposed: { usdMicros: 1000, rounds: 4 } }
  // Find the real disk bound with enough room for the policy card only.
  const afterPolicy = (length: number) => {
    const state = journal.state
    const filler = disk.prepare({ version: 1, seq: state.seq + 1, type: 'card', card: card('last-fill', length) }, state)
    const filled = reduceLeadRecord(state, filler)
    const event = disk.prepare({ version: 1, seq: filled.seq + 1, type: 'card', card: permission }, filled)
    return reduceLeadRecord(filled, event)
  }
  let lo = 0, hi = 40 * 16384
  afterPolicy(lo)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    try { afterPolicy(mid); lo = mid } catch (error) { assert.match(String(error), /lead-journal-state-limit/); hi = mid - 1 }
  }
  const staged = afterPolicy(lo)
  assert.throws(() => disk.prepare({ version: 1, seq: staged.seq + 1, type: 'card', card: budget }, staged), /lead-journal-state-limit/)
  await journal.offerCard(card('last-fill', lo))
  const before = journal.state, records = await disk.read(), file = join(home, 'lead', 'thread-1.ndjson'), bytes = await fs.readFile(file)
  await assert.rejects(journal.changePolicyAndBudgetCaps(proposed, budget.proposed, before.seq, { policy: permission.id, caps: budget.id }, 100), /lead-journal-state-limit/)
  assert.deepEqual(journal.state, before)
  assert.deepEqual(await disk.read(), records)
  assert.deepEqual(await fs.readFile(file), bytes)
  assert.equal(journal.state.cards.some(card => card.type === 'permission-change' || card.type === 'budget-change'), false)
})

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

const seedReads = async (home: string, count: number, compact = false) => {
  const { createHash } = await import('node:crypto')
  const { DatabaseSync } = await import('node:sqlite')
  const { initialLeadState, reduceLeadRecord, leadCheckpoint } = await import('@harnessdesk/lead')
  const zero = '0'.repeat(64), directory = join(home, 'lead')
  await fs.mkdir(directory, { recursive: true })
  let previous = zero, seq = 0, state = initialLeadState(), batch = 0, segmentHead = zero
  let frames: string[] = []
  const segments: { name: string; hash: string; previous: string; checksum: string }[] = []
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const frame = (record: unknown) => {
    const checksum = hash(JSON.stringify({ record, previous }))
    frames.push(JSON.stringify({ record, previous, checksum }) + '\n'); previous = checksum
  }
  for (let n = 0; n < count; n++) for (const event of [
    { type: 'attempt', id: `read-${n}`, correlationId: `read-${n}`, method: 'library/usage', action: null,
      kind: 'read', stepId: null, policyRevision: null, projectPolicyRevision: null, contractRevision: null, arguments: { type: 'object', size: 0, fields: [] } },
    { type: 'decision', id: `read-${n}`, effect: 'allow', reason: 'policy', rule: null },
    { type: 'dispatch-start', id: `read-${n}`, dispatched: true },
    { type: 'result', id: `read-${n}`, outcome: 'succeeded', identity: null },
  ]) {
    if (compact && batch >= 1024) {
      const segment = { name: `thread-1.ndjson.sealed-fixture-${segments.length}`, hash: hash(frames.join('')), previous: segmentHead }
      segmentHead = hash(JSON.stringify(segment)); segments.push({ ...segment, checksum: segmentHead })
      await fs.writeFile(join(directory, segment.name), frames.join(''))
      frames = []; frame(leadCheckpoint(state, previous)); batch = 0
    }
    const record = parseLeadJournalRecord({ version: 1, seq: ++seq, ...event })
    state = reduceLeadRecord(state, record); frame(record); batch++
  }
  await fs.writeFile(join(directory, 'thread-1.ndjson'), frames.join(''))
  const db = new DatabaseSync(join(directory, 'thread-1.writer.sqlite'))
  db.exec('CREATE TABLE journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const put = db.prepare('INSERT INTO journal VALUES (?, ?)')
  put.run('head', JSON.stringify({ seq, hash: previous, segments: segmentHead })); put.run('segments', JSON.stringify(segments)); db.close()
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
  const reserveChecks = ['management', 'invalidate-results'].map(type => {
    try { disk.prepare({ version: 1, seq: journal.state.seq + 1, type, ...(type === 'management' ? { phase: 'waiting-for-user' } : {}) }); return null }
    catch (error) { return String(error) }
  })
  assert.deepEqual(reserveChecks, [null, null])
  await (journal as any).setManagementPhase('waiting-for-user', 'lead-request-failed')
  await journal.invalidateResults()
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
    steps: [{ id: 'implement', title: 'Implement', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: { api_key: 'SYNTHETIC_INPUT' },
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

test('pending plan remains fenced across reconciliation checkpoint and reopen then approves remaining steps', async t => {
  const home = await scratch(t), disk = await open(home)
  t.after(() => disk.close())
  const journal = await createLeadJournal(disk)
  const contract = { version: 1 as const, revision: 1, digest: 'a'.repeat(64), goal: 'Synthetic plan revision',
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: ['first', 'second'].map(id => ({ id, title: id, flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {},
      attendance: 'attended' as const, assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' as const }, ceiling: 'edit' as const }] })),
    assertions: [{ id: 'check', kind: 'check' as const, description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
  const plan = { version: 1 as const, id: 'plan-1', revision: 1, type: 'plan' as const, contractDigest: contract.digest, contract }
  const click = { version: 1 as const, cardId: plan.id, cardType: 'plan' as const, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' as const }
  const context = { desk: policy, projectPolicy: null, project: contract.project, approved: null, now: 100, policyInterpretation: 'idle' as const,
    budget: { version: 1 as const, revision: 1, caps: contract.caps, leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 0, spend: 'known' as const, stop: null } }
  const request = { method: 'flow/start-goal', params: { root: contract.project.path, source: 'synthetic recipe', token: 'preview-1', sentence: contract.goal,
    vars: {}, attended: true, seats: { implement: [{ runtime: 'fixture' }] } }, project: contract.project, runId: null, start: contract.steps[0]! }
  await journal.setPolicy(policy); await journal.offerCard(plan)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: contract.caps, freshnessMs: 50 })
  await journal.decideCard(click, 200)
  await journal.execute({ id: 'first', request, context, stepId: 'first' }, async () => { throw new Error('lost response') })
  const revised = { ...contract, revision: 2, digest: 'b'.repeat(64), steps: [contract.steps[0]!, { ...contract.steps[1]!, title: 'Revised second step' }] }
  await journal.offerCard({ ...plan, revision: 2, contractDigest: revised.digest, contract: revised })
  await journal.recover(async () => ([{ correlationId: 'first', runId: 'run-1', teamId: 'team-1' }]).map(identity => runEvidence(identity)))
  for (let i = 0; i < 260; i++) await journal.execute({ id: `status-${i}`, request: { ...request, method: 'library/usage', params: {}, start: null }, context }, async () => ({ value: null, identity: null }))
  await disk.close()
  assert.equal(JSON.parse((await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')).split('\n')[0]!).record.type, 'checkpoint')
  const reopened = await open(home)
  t.after(() => reopened.close())
  const recovered = await createLeadJournal(reopened)
  await recovered.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-1', startId: 'first', firstRoundId: '1' })
  await recovered.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: ['run-1'], quality: 'known', usdMicros: 0 })
  const next = { ...request, start: contract.steps[1]! }
  const blocked = await recovered.execute({ id: 'blocked', request: next, context, stepId: 'second', predecessor: { runId: 'run-1', ready: true } }, async () => ({ value: null,
    identity: { correlationId: 'blocked', runId: 'must-not-exist', teamId: 'team-1' } }))
  assert.equal(blocked.outcome, 'denied')
  await recovered.decideCard({ ...click, expectedRevision: 2, contractDigest: revised.digest }, 300)
  assert.equal((await recovered.execute({ id: 'second', request: { ...next, start: revised.steps[1]! }, context, stepId: 'second', predecessor: { runId: 'run-1', ready: true } }, async () => ({ value: null,
    identity: { correlationId: 'second', runId: 'run-2', teamId: 'team-1' } }))).outcome, 'succeeded')
  assert.equal(recovered.state.runs.length, 2)
})

test('core canaries cannot be bypassed by disk preparation and dual configurations merge or refuse', async t => {
  const { parseLeadAcceptanceContract } = await import('@harnessdesk/protocol')
  const coreCanary = 'synthetic-core-key-91b0c2d3', hostCanary = 'synthetic-host-key-91b0c2d3'
  for (const hostConfigured of [false, true]) {
    const home = await scratch(t)
    const disk = await (server as any).openLeadFileJournal(home, 'thread-1', hostConfigured ? { canaries: [hostCanary] } : {})
    t.after(() => disk.close())
    // Exact reviewer wiring: storage opened with no security, core configured later.
    const journal = await createLeadJournal(disk, { canaries: [coreCanary] })
    const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Fixture',
      project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
      steps: [{ id: 'first', title: 'First', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended',
        assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
      assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } })
    await journal.setPolicy(policy)
    for (const canary of hostConfigured ? [coreCanary, hostCanary] : [coreCanary]) await assert.rejects(journal.offerCard({ version: 1, id: 'plan-1', revision: 1,
      type: 'plan', contractDigest: contract.digest, contract: { ...contract, goal: canary } }), /canary/)
    await journal.stop()
    const body = await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')
    assert.ok(!body.includes(coreCanary) && !body.includes(hostCanary))
    await assert.rejects(createLeadJournal(disk, { digestContract: () => 'b'.repeat(64) }), /security-conflict/)
  }
})

test('a missing or unreadable head cannot authenticate a forged checkpoint', async t => {
  const { createHash } = await import('node:crypto')
  const { DatabaseSync } = await import('node:sqlite')
  for (const damage of ['missing', 'unreadable', 'genesis', 'genesis-empty']) {
    const home = await scratch(t)
    await seedReads(home, 256)
    const disk = await open(home)
    await (await createLeadJournal(disk)).stop()
    await disk.close()
    const file = join(home, 'lead', 'thread-1.ndjson'), frames = (await fs.readFile(file, 'utf8')).trimEnd().split('\n')
    const frame = JSON.parse(frames[0]!)
    frame.record.state.phase = 'running'
    frame.checksum = createHash('sha256').update(JSON.stringify({ record: frame.record, previous: frame.previous })).digest('hex')
    await fs.writeFile(file, damage === 'genesis-empty' ? '' : JSON.stringify(frame) + '\n')
    const db = new DatabaseSync(join(home, 'lead', 'thread-1.writer.sqlite'))
    if (damage === 'missing') db.exec("DELETE FROM journal WHERE key = 'head'")
    else if (damage === 'unreadable') db.prepare("UPDATE journal SET value = ? WHERE key = 'head'").run('{"unreadable":')
    else {
      const head = JSON.parse((db.prepare("SELECT value FROM journal WHERE key = 'head'").get() as { value: string }).value)
      db.prepare("UPDATE journal SET value = ? WHERE key = 'head'").run(JSON.stringify({ ...head, seq: 0, hash: '0'.repeat(64) }))
    }
    db.close()
    await assert.rejects(async () => { const unexpected = await open(home); await unexpected.close() }, /open-refused/, damage)
  }
})

test('open removes only this journal unlisted checkpoint and sealed temp files', async t => {
  const home = await scratch(t), disk = await open(home)
  await disk.close()
  const directory = join(home, 'lead')
  const own = ['thread-1.ndjson.checkpoint-orphan', 'thread-1.ndjson.sealed-orphan']
  for (const name of [...own, 'other.ndjson.checkpoint-keep', 'unrelated-file']) await fs.writeFile(join(directory, name), 'synthetic orphan')
  const reopened = await open(home)
  t.after(() => reopened.close())
  const names = await fs.readdir(directory)
  assert.ok(own.every(name => !names.includes(name)))
  assert.ok(names.includes('other.ndjson.checkpoint-keep') && names.includes('unrelated-file'))
})

test('open verifies newest sealed content and the anchored chain of older segment hashes', async t => {
  const { DatabaseSync } = await import('node:sqlite')
  for (const damage of ['older-content', 'newest-content', 'metadata-chain']) {
    const home = await scratch(t)
    await seedReads(home, 512, true)
    const disk = await open(home)
    await disk.append(parseLeadJournalRecord({ version: 1, seq: 2049, type: 'stop' }))
    await disk.close()
    const db = new DatabaseSync(join(home, 'lead', 'thread-1.writer.sqlite'))
    const segments = JSON.parse((db.prepare("SELECT value FROM journal WHERE key = 'segments'").get() as { value: string }).value)
    assert.ok(segments.length >= 2)
    if (damage === 'metadata-chain') {
      segments[0].hash = 'f'.repeat(64)
      db.prepare("UPDATE journal SET value = ? WHERE key = 'segments'").run(JSON.stringify(segments))
    } else await fs.appendFile(join(home, 'lead', segments[damage === 'older-content' ? 0 : segments.length - 1].name), 'synthetic corruption')
    db.close()
    if (damage === 'older-content') {
      const recovered = await open(home)
      t.after(() => recovered.close())
      assert.equal((await createLeadJournal(recovered)).state.phase, 'stopped')
    } else await assert.rejects(open(home))
  }
})

test('ordinary appends never stringify the complete checkpoint', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const stringify = JSON.stringify
  let checkpoints = 0
  t.mock.method(JSON, 'stringify', (value: any, replacer?: any, space?: any) => {
    if (value?.type === 'checkpoint') checkpoints++
    return stringify(value, replacer, space)
  })
  await journal.setPolicy(policy)
  for (let i = 0; i < 5; i++) await journal.execute({ id: `invalid-${i}`, request: { method: 'unknown/method', params: {}, project: null, runId: null, start: null },
    context: { desk: policy, projectPolicy: null, project: null, approved: null, budget: null, now: 0, policyInterpretation: 'idle' } }, async () => { throw new Error('unreachable') })
  await journal.stop()
  assert.equal(checkpoints, 0)
})

test('existing anchored journals upgrade segment metadata without replay-time masking', async t => {
  const { DatabaseSync } = await import('node:sqlite')
  for (const damage of ['clean', 'older-corrupt']) {
    const home = await scratch(t)
    await seedReads(home, 512, true)
    const disk = await open(home)
    await disk.append(parseLeadJournalRecord({ version: 1, seq: 2049, type: 'stop' }))
    await disk.close()
    const db = new DatabaseSync(join(home, 'lead', 'thread-1.writer.sqlite'))
    const get = (key: string) => JSON.parse((db.prepare('SELECT value FROM journal WHERE key = ?').get(key) as { value: string }).value)
    const head = get('head'), segments = get('segments').map((segment: any) => ({ name: segment.name, hash: segment.hash }))
    db.prepare("UPDATE journal SET value = ? WHERE key = 'head'").run(JSON.stringify({ seq: head.seq, hash: head.hash }))
    db.prepare("UPDATE journal SET value = ? WHERE key = 'segments'").run(JSON.stringify(segments))
    db.exec("DELETE FROM journal WHERE key = 'format'"); db.close()
    if (damage === 'older-corrupt') {
      await fs.appendFile(join(home, 'lead', segments[0].name), 'synthetic corruption')
      await assert.rejects(open(home))
    } else {
      const recovered = await open(home)
      t.after(() => recovered.close())
      assert.equal((await createLeadJournal(recovered)).state.phase, 'stopped')
      const upgraded = new DatabaseSync(join(home, 'lead', 'thread-1.writer.sqlite'))
      try { assert.equal((upgraded.prepare("SELECT value FROM journal WHERE key = 'format'").get() as { value: string }).value, '2') }
      finally { upgraded.close() }
    }
  }
})

for (const probe of ['switching-getter', 'inherited-array']) test(`core-only canaries reject ${probe} before any caller graph can be rescanned`, async t => {
  const home = await scratch(t), disk = await open(home), canary = 'synthetic-core-canary-91b0c2d3'
  t.after(() => disk.close())
  const journal = await createLeadJournal(disk, { canaries: [canary] })
  await journal.setPolicy(policy)
  const contract = { version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Ordinary snapshot goal',
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'first', title: 'First', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended',
      assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
    assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
  let reads = 0
  if (probe === 'switching-getter') Object.defineProperty(contract, 'goal', { enumerable: true, get() { return ++reads === 1 ? 'Ordinary snapshot goal' : canary } })
  else {
    const assertions = new Array(1)
    Object.setPrototypeOf(assertions, Object.create(Array.prototype, { 0: { enumerable: true,
      value: { id: 'check', kind: 'check', description: canary } } }))
    contract.assertions = assertions
  }
  await assert.rejects(journal.offerCard({ version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract } as any))
  assert.equal(reads, 0, 'accessors are not plain-data properties')
  await journal.stop()
  assert.ok(!(await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')).includes(canary))
})

test('format two metadata refuses a legacy-head downgrade after opening successfully', async t => {
  const { DatabaseSync } = await import('node:sqlite')
  const home = await scratch(t)
  await seedReads(home, 256)
  const disk = await open(home)
  await disk.close()
  const db = new DatabaseSync(join(home, 'lead', 'thread-1.writer.sqlite'))
  const head = JSON.parse((db.prepare("SELECT value FROM journal WHERE key = 'head'").get() as { value: string }).value)
  const segments = JSON.parse((db.prepare("SELECT value FROM journal WHERE key = 'segments'").get() as { value: string }).value)
  db.prepare("UPDATE journal SET value = ? WHERE key = 'head'").run(JSON.stringify({ seq: head.seq, hash: head.hash }))
  db.prepare("UPDATE journal SET value = ? WHERE key = 'segments'").run(JSON.stringify(segments.map((segment: any) => ({ name: segment.name, hash: segment.hash })))); db.close()
  await assert.rejects(async () => { const unexpected = await open(home); await unexpected.close() })
})

test('fresh journals persist the metadata format two marker', async t => {
  const { DatabaseSync } = await import('node:sqlite')
  const home = await scratch(t), disk = await open(home)
  await disk.close()
  const db = new DatabaseSync(join(home, 'lead', 'thread-1.writer.sqlite'))
  try { assert.equal((db.prepare("SELECT value FROM journal WHERE key = 'format'").get() as { value: string } | undefined)?.value, '2') }
  finally { db.close() }
})

test('budget reservations rounds observations and stop survive disk checkpoint and reopen', async t => {
  const home = await scratch(t), disk = await open(home), journal: any = await createLeadJournal(disk)
  assert.equal(typeof journal.updateBudget, 'function')
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1',
    caps: { usdMicros: 100, rounds: 3 }, freshnessMs: 50 })
  await journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'planning-1', inputTokens: 10, maxOutputTokens: 20,
    inputUsdMicrosPerMillion: 1_000_000, outputUsdMicrosPerMillion: 1_000_000, cacheReadUsdMicrosPerMillion: 1_000_000, cacheWriteUsdMicrosPerMillion: 1_000_000 })
  await journal.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId: 'run-1' })
  await journal.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal',
    sourceIds: ['corpus-1'], goalId: 'goal-1', executionIds: ['run-1'], quality: 'known', usdMicros: 0 })
  await journal.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-1', roundId: 'round-1' })
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 20, rounds: 3 } }, async () => {
    assert.equal(journal.state.phase, 'stopped')
    throw new Error('synthetic crash after durable stop')
  })
  assert.equal(journal.stopEffectFailure.reason, 'stop-effects-failed')
  for (let i = 0; i < 1024; i++) await disk.append(parseLeadJournalRecord({ version: 1, seq: journal.state.seq + i + 1, type: 'recovery-resolved' }))
  await disk.close()
  const recovered = await open(home)
  t.after(() => recovered.close())
  const reopened: any = await createLeadJournal(recovered)
  assert.equal(reopened.state.phase, 'stopped')
  assert.equal(reopened.state.budget.stop.reason, 'budget')
  assert.ok(reopened.state.stopEffectsPending)
  let stops = 0
  await reopened.runStopEffects(async () => { stops++ })
  assert.equal(stops, 1)
  assert.equal(reopened.state.stopEffectsPending, null)
  assert.equal((await recovered.read()).at(-1).type, 'stop-effects-done')
  assert.equal(reopened.state.budget.requests.length, 1)
  assert.equal(reopened.state.budget.rounds.length, 1)
  await assert.rejects(reopened.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'planning-2', inputTokens: 0, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }))
})


test('newly bound work re-arms an acknowledged budget stop across disk checkpoint and reopen', async t => {
  const home = await scratch(t), disk = await open(home), journal: any = await createLeadJournal(disk)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: { usdMicros: 100, rounds: 3 }, freshnessMs: 50 })
  await journal.updateBudget({ version: 1, type: 'tighten', now: 100, caps: { usdMicros: 0, rounds: 3 } })
  const original = journal.state.stopEffectsPending
  await journal.runStopEffects(async () => {})
  for (let i = 0; i < 1024; i++) await journal.resolveRecovery()
  await disk.close()
  const disk2 = await open(home), restored: any = await createLeadJournal(disk2)
  assert.equal(restored.state.stopEffectsPending, null)
  await restored.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId: 'live-1' })
  const generation = restored.state.stopEffectsPending
  assert.ok(generation > original)
  await restored.runStopEffects(async () => {
    await restored.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'goal-1', executionId: 'live-2' })
  })
  assert.ok(restored.state.stopEffectsPending > generation)
  await disk2.close()
  const disk3 = await open(home)
  t.after(() => disk3.close())
  const reopened: any = await createLeadJournal(disk3)
  assert.ok(reopened.state.stopEffectsPending > generation)
  assert.deepEqual(reopened.state.budget.executionIds, ['live-1', 'live-2'])
  await reopened.runStopEffects(async () => {})
  assert.equal(reopened.state.stopEffectsPending, null)
})

test('unrepresentable charges remain unknown and stopped through a disk checkpoint', async t => {
  const home = await scratch(t), disk = await open(home), journal: any = await createLeadJournal(disk)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: { usdMicros: 1_000_000_000_000, rounds: 3 }, freshnessMs: 50 })
  await journal.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 999_999, maxOutputTokens: 0,
    inputUsdMicrosPerMillion: 1_000_000_000_000, outputUsdMicrosPerMillion: 0, cacheReadUsdMicrosPerMillion: 0, cacheWriteUsdMicrosPerMillion: 0 })
  await journal.updateBudget({ version: 1, type: 'settle', now: 100, requestId: 'paid', inputTokens: 1_000_001, outputTokens: 0 })
  for (let i = 0; i < 1024; i++) await journal.resolveRecovery()
  await disk.close()
  const disk2 = await open(home)
  t.after(() => disk2.close())
  const restored: any = await createLeadJournal(disk2)
  assert.equal(restored.state.budget.leadUsdMicros, 1_000_000_000_000)
  assert.equal(restored.state.budget.spend, 'unknown')
  assert.equal(restored.state.budget.stop.reason, 'budget')
  await restored.stop()
})


test('resolution evidence and first-round proof remain bound through disk checkpoint and reopen', async t => {
  const { parseLeadAcceptanceContract } = await import('@harnessdesk/protocol')
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Synthetic recovery',
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'first', title: 'First', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended',
      assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
    assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 2 } })
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: contract.caps, freshnessMs: 50 })
  await journal.offerCard({ version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan-1', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 200)
  await journal.execute({ id: 'lost', stepId: 'first', request: { method: 'flow/start-goal', params: { root: contract.project.path,
    source: 'synthetic recipe', token: 'preview-1', sentence: contract.goal, vars: {}, attended: true, seats: { implement: [{ runtime: 'fixture' }] } },
    project: contract.project, runId: null, start: contract.steps[0]! }, context: { desk: policy, projectPolicy: null, project: contract.project,
    approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }, async () => { throw new Error('lost response') })
  const matches = ['run-a', 'run-b'].map(runId => ({ correlationId: 'lost', runId, teamId: 'team-1' }))
  await journal.recover(async () => (matches).map(identity => runEvidence(identity)))
  const ambiguousSeq = journal.state.attempts.get('lost')!.evidenceSeq!
  for (let i = 0; i < 1024; i++) await journal.resolveRecovery()
  await disk.close()
  const disk2 = await open(home), restored = await createLeadJournal(disk2)
  await assert.rejects(restored.resolveStart('lost', null, ambiguousSeq))
  await assert.rejects(restored.resolveStart('lost', { goalId: 'team-1', identity: matches[0]! }, ambiguousSeq))
  assert.equal(restored.state.budget!.spend, 'unknown')
  assert.deepEqual(restored.state.runs, matches)
  await restored.recover(async () => [runEvidence(matches[0]!), runEvidence(matches[1]!, true)])
  const evidenceSeq = restored.state.attempts.get('lost')!.evidenceSeq!
  for (let i = 0; i < 70; i++) await restored.execute({ id: `resolution-status-${i}`, request: { method: 'library/usage', params: {},
    project: null, runId: null, start: null }, context: { desk: policy, projectPolicy: null, project: contract.project, approved: null,
    budget: null, now: 100, policyInterpretation: 'idle' } }, async () => ({ value: null, identity: null }))
  assert.equal(restored.state.attempts.get('lost')!.evidenceSeq, evidenceSeq)
  await restored.resolveStart('lost', { goalId: 'team-1', identity: matches[0]! }, evidenceSeq)
  const resolution = (await disk2.read()).at(-1)
  assert.equal(resolution.type, 'start-resolution')
  assert.equal(resolution.evidenceSeq, evidenceSeq)
  await restored.updateBudget({ version: 1, type: 'bind', now: 100, goalId: 'team-1', executionId: 'run-a', startId: 'lost', firstRoundId: '1' })
  await restored.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: ['run-a', 'run-b'], quality: 'known', usdMicros: 0 })
  await disk2.close()
  const disk3 = await open(home)
  t.after(() => disk3.close())
  const reopened = await createLeadJournal(disk3)
  await assert.rejects(reopened.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-a', roundId: '2' }))
  await reopened.updateBudget({ version: 1, type: 'round', now: 100, executionId: 'run-a', roundId: '1' })
  assert.equal(reopened.state.budget!.roundsAdmitted, 2)
  assert.equal(reopened.state.attempts.get('lost')!.evidenceSeq, evidenceSeq)
})


test('terminal duplicate runs and no-run resolution never erase disk accounting history', async t => {
  const { parseLeadAcceptanceContract } = await import('@harnessdesk/protocol')
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Synthetic recovery',
    project: { id: 'project-demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'first', title: 'First', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended',
      assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
    assertions: [{ id: 'check', kind: 'check', description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 2 } })
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical-1', caps: contract.caps, freshnessMs: 50 })
  await journal.offerCard({ version: 1, id: 'plan-1', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan-1', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 200)
  await journal.execute({ id: 'lost', stepId: 'first', request: { method: 'flow/start-goal', params: { root: contract.project.path,
    source: 'synthetic recipe', token: 'preview-1', sentence: contract.goal, vars: {}, attended: true, seats: { implement: [{ runtime: 'fixture' }] } },
    project: contract.project, runId: null, start: contract.steps[0]! }, context: { desk: policy, projectPolicy: null, project: contract.project,
    approved: null, budget: null, now: 100, policyInterpretation: 'idle' } }, async () => { throw new Error('lost response') })
  const matches = ['run-a', 'run-b'].map(runId => ({ correlationId: 'lost', runId, teamId: 'team-1' }))
  await journal.recover(async () => (matches).map(identity => runEvidence(identity)))
  await journal.recover(async () => matches.map(identity => runEvidence(identity, true)))
  await journal.recover(async () => [])
  await journal.resolveStart('lost', null)
  for (let i = 0; i < 1024; i++) await journal.resolveRecovery()
  await disk.close()
  const disk2 = await open(home)
  t.after(() => disk2.close())
  const restored = await createLeadJournal(disk2)
  assert.deepEqual(restored.state.runs, [])
  assert.deepEqual(restored.state.budget!.executionIds, ['run-a', 'run-b'])
  assert.equal(restored.state.budget!.roundsAdmitted, 2)
  assert.equal(restored.state.budget!.spend, 'unknown')
  await assert.rejects(restored.updateBudget({ version: 1, type: 'reserve', now: 100, requestId: 'paid', inputTokens: 0, maxOutputTokens: 1,
    inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1, cacheReadUsdMicrosPerMillion: 1, cacheWriteUsdMicrosPerMillion: 1 }))
  await restored.updateBudget({ version: 1, type: 'observe', now: 100, at: 100, revision: 1, source: 'insight/goal', sourceIds: ['corpus-1'],
    goalId: 'team-1', executionIds: ['run-a', 'run-b'], quality: 'known', usdMicros: 50 })
  assert.equal(restored.state.budget!.spend, 'known')
  assert.equal(restored.state.budget!.roundsAdmitted, 2)
})

for (const cycles of [1, 2100]) test(`pruned settings cards survive file rotation and reopen after ${cycles} cycles`, async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: { usdMicros: 1000, rounds: 4 }, freshnessMs: 1000 })
  for (let i = 0; i < cycles; i++) {
    const card = await journal.changeBudgetCaps({ usdMicros: 2000, rounds: 4 }, { id: `caps-${i}`, revision: 1 }, 100)
    assert.ok(card)
    await journal.decideCard({ version: 1, cardId: card.id, cardType: 'budget-change', expectedRevision: card.revision, contractDigest: null, choice: 'decline' })
  }
  for (let i = 0; i < 1100; i++) await journal.appendMessage(`rotate-${i}`, 'Rotate the journal')
  const live = journal.state
  await disk.close()
  const reopenedDisk = await open(home)
  t.after(() => reopenedDisk.close())
  const reopened = await createLeadJournal(reopenedDisk)
  assert.deepEqual(reopened.state, live)
  assert.equal(Object.keys(live.cardRevisions).length, 0)
  assert.ok(live.decidedCards.length <= 256)
  assert.equal(live.decidedCards.length, Math.min(cycles, 256))
  if (cycles >= 256) await assert.rejects(reopened.decideCard({ version: 1, cardId: `caps-${cycles - 256}`, cardType: 'budget-change', expectedRevision: 1, contractDigest: null, choice: 'decline' }),
    (error: any) => error.wireCode === 'lead-card-decided')
  await assert.rejects(reopened.decideCard({ version: 1, cardId: 'caps-0', cardType: 'budget-change', expectedRevision: 1, contractDigest: null, choice: 'decline' }),
    (error: any) => error.wireCode === (cycles > 256 ? 'lead-card-stale' : 'lead-card-decided'))
})

test('expired consent renewal keeps its card identity and journal position through disk reopen', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const contract = { version: 1 as const, revision: 1, digest: 'a'.repeat(64), goal: 'Review the synthetic keyboard path',
    project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'work', title: 'Review', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended' as const,
      assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' as const }] }],
    assertions: [{ id: 'check', kind: 'check' as const, description: 'Keyboard checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  const position = journal.state.cardPositions.plan
  const click = { version: 1 as const, cardId: 'plan', cardType: 'plan' as const, expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' as const }
  await journal.decideCard(click, 200); await journal.renewPlan(200)
  const offered = journal.state
  await disk.close()
  const reopenedDisk = await open(home); t.after(() => reopenedDisk.close())
  const reopened = await createLeadJournal(reopenedDisk)
  assert.deepEqual(reopened.state, offered)
  await assert.rejects(reopened.decideCard(click, 400))
  await reopened.decideCard({ ...click, expectedRevision: 2 }, 400)
  assert.deepEqual(reopened.state.contract, contract)
  assert.equal(reopened.state.cardPositions.plan, position)
  assert.equal(reopened.state.consent!.expiresAt, 400)
})


test('replacing a pending renewal survives file checkpoint rotation and reopen', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const contract = { version: 1 as const, revision: 1, digest: 'a'.repeat(64), goal: 'Synthetic goal', project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'work', title: 'Review', flow: 'lead-reviewed-result', sourceRevision: 'recipe-1', variables: {}, attendance: 'attended' as const, assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' as const }] }],
    assertions: [{ id: 'check', kind: 'check' as const, description: 'Checks pass' }], caps: { usdMicros: 500, rounds: 3 } }
  await journal.setPolicy(policy)
  await journal.updateBudget({ version: 1, type: 'initialize', now: 100, logicalGoalId: 'logical', caps: contract.caps, freshnessMs: 1000 })
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 200)
  await journal.renewPlan(250)
  const replacement = { ...contract, revision: 2, digest: 'b'.repeat(64) }
  await journal.offerCard({ version: 1, id: 'plan', revision: 3, type: 'plan', contractDigest: replacement.digest, contract: replacement })
  for (let i = 0; i < 1100; i++) await journal.appendReply('Synthetic rotation message')
  const live = journal.state; await disk.close()
  const reopened = await open(home); t.after(() => reopened.close())
  assert.deepEqual((await createLeadJournal(reopened)).state, live)
  const frame = JSON.parse((await fs.readFile(join(home, 'lead', 'thread-1.ndjson'), 'utf8')).split('\n')[0]!)
  assert.equal(frame.record.type, 'checkpoint')
})

test('obsolete rule migration authenticates the original journal bytes before dropping authority', async t => {
  const { createHash } = await import('node:crypto')
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  await journal.setPolicy(policy); await disk.close()
  const file = join(home, 'lead', 'thread-1.ndjson'), frame = JSON.parse((await fs.readFile(file, 'utf8')).trim())
  let previous = frame.checksum
  for (const record of [
    { version: 1, seq: 2, type: 'worker-rule-saved', rule: { id: 'old-rule', contractDigest: 'a'.repeat(64), goalStartedSeq: 0, key: { kind: 'command', command: 'git status', cwd: '/workspace/demo' }, target: 'git status in /workspace/demo', count: 0 } },
    { version: 1, seq: 3, type: 'worker-rule-used', id: 'old-rule' },
  ]) {
    const checksum = createHash('sha256').update(JSON.stringify({ record, previous })).digest('hex')
    await fs.appendFile(file, JSON.stringify({ record, previous, checksum }) + '\n'); previous = checksum
  }
  const recovered = await open(home); t.after(() => recovered.close())
  assert.equal(recovered.report.quarantine, null)
  const restored = await createLeadJournal(recovered)
  assert.equal(restored.state.seq, 3)
  assert.deepEqual(restored.state.workerApprovals, [])
  assert.equal(restored.state.messages.filter(message => message.role === 'notice').length, 1)
})

test('a durable worker dispatch without acknowledgement reopens fenced until person revocation', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  const contract: any = { version: 1, revision: 1, digest: 'a'.repeat(64), goal: 'Inspect demo', project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'work', title: 'Inspect', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'read' }] }], assertions: [{ id: 'diff', kind: 'diff', description: 'Reviewed' }], caps: { usdMicros: 1000, rounds: 2 } }
  await journal.setPolicy(policy)
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 1000)
  await journal.saveWorkerApproval({ id: 'rule', contractDigest: contract.digest, goalStartedSeq: journal.state.goalStartedSeq, key: { kind: 'tool', tool: 'get_team_status' }, target: 'get_team_status', count: 0 })
  await assert.rejects(journal.useWorkerApproval('rule', () => true, async () => { throw Error('fixture crash') }))
  await disk.close()
  const restoredDisk = await open(home); t.after(() => restoredDisk.close())
  const restored = await createLeadJournal(restoredDisk)
  assert.equal(restored.state.phase, 'waiting-for-user')
  assert.equal(restored.state.managementReason, 'lead-worker-audit-failed')
  assert.equal(await restored.useWorkerApproval('rule', () => true, async () => { assert.fail('must not dispatch after restart') }), false)
  await assert.rejects(restored.resume())
  await restored.revokeWorkerApproval('rule', contract.digest)
  await restored.resume()
  assert.equal(restored.state.workerApprovals[0]!.revoked, true)
})

const seedApproval = async (journal: Awaited<ReturnType<typeof createLeadJournal>>) => {
  const { parseLeadAcceptanceContract } = await import('@harnessdesk/protocol')
  const digest = 'a'.repeat(64)
  const contract = parseLeadAcceptanceContract({ version: 1, revision: 1, digest, goal: 'Inspect demo', project: { id: 'demo', path: '/workspace/demo' }, policyRevision: 1,
    steps: [{ id: 'work', title: 'Inspect', flow: 'lead-reviewed-result', sourceRevision: 'source-1', variables: {}, attendance: 'attended', assignments: [{ role: 'implement', agent: 'builder', seat: { runtime: 'fixture' }, ceiling: 'edit' }] }],
    assertions: [{ id: 'diff', kind: 'diff', description: 'Reviewed' }], caps: { usdMicros: 500, rounds: 3 } })
  await journal.setPolicy(policy)
  await journal.offerCard({ version: 1, id: 'plan', revision: 1, type: 'plan', contractDigest: digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: digest, choice: 'approve' }, 1000)
  await journal.saveWorkerApproval({ id: 'rule', contractDigest: digest, goalStartedSeq: journal.state.goalStartedSeq, key: { kind: 'fileChange', path: '/workspace/demo/panel.tsx' }, target: '/workspace/demo/panel.tsx', count: 0 }, () => true, async () => {})
  return digest
}

for (const resume of [false, true]) test(`file journal retains uncertain revoke and resume through reopen (resume: ${resume})`, async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const digest = await seedApproval(journal)
  await assert.rejects(journal.useWorkerApproval('rule', () => true, async () => { throw Error('uncertain') }, '+inspect'))
  await journal.revokeWorkerApproval('rule', digest)
  if (resume) await journal.resume()
  await disk.close()
  const next = await open(home); t.after(() => next.close())
  const reopened = await createLeadJournal(next)
  assert.equal(reopened.state.phase, resume ? 'running' : 'waiting-for-user')
  assert.equal(reopened.state.managementReason, resume ? null : 'lead-worker-audit-failed')
  assert.equal(reopened.state.workerApprovals[0]!.entries![0]!.uncertain, true)
})

test('file journal recovers a dispatch-only crash then permits revoke resume and reopen', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const digest = await seedApproval(journal)
  await disk.append({ version: 1, seq: journal.state.seq + 1, type: 'worker-rule-dispatch', id: 'rule', diff: '+crashed' })
  await disk.close()
  const next = await open(home); t.after(() => next.close())
  const recovered = await createLeadJournal(next)
  assert.equal(recovered.state.phase, 'waiting-for-user')
  await recovered.revokeWorkerApproval('rule', digest)
  await recovered.resume()
  await next.close()
  const final = await open(home); t.after(() => final.close())
  assert.equal((await createLeadJournal(final)).state.phase, 'running')
})

test('file journal loads the 1951 dispatch revoke resume bytes', async t => {
  const { createHash } = await import('node:crypto')
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  await seedApproval(journal)
  const file = join(home, 'lead/thread-1.ndjson')
  await disk.close()
  let previous = JSON.parse((await fs.readFile(file, 'utf8')).trim().split('\n').at(-1)!).checksum
  let seq = journal.state.seq
  for (const event of [{ type: 'worker-rule-dispatch', id: 'rule', diff: '+legacy' }, { type: 'worker-rule-revoked', id: 'rule' }, { type: 'resume' }]) {
    const record = { version: 1, seq: ++seq, ...event }
    const checksum = createHash('sha256').update(JSON.stringify({ record, previous })).digest('hex')
    await fs.appendFile(file, JSON.stringify({ record, previous, checksum }) + '\n')
    previous = checksum
  }
  const next = await open(home); t.after(() => next.close())
  assert.equal((await createLeadJournal(next)).state.phase, 'running')
})

// The repair probe must use the disk writer, whose prepare/replay state is
// independent of the live LeadJournal instance.
for (const crash of [false, true]) test(`file journal keeps a repair handback behind an unresolved worker dispatch (crash: ${crash})`, async t => {
  const { leadRig } = await import('./fixtures/lead.js')
  const { LeadHandbacks } = await import('../src/lead/handback.js')
  const s = await leadRig(t), run = await s.start(); await s.observe(0)
  const head = 'a'.repeat(40), card: any = { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: s.contract.digest,
    outcome: 'reviewed', summary: 'Reviewed fixture', assertions: [], budget: { version: 1, revision: 1, caps: s.contract.caps,
      leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 1, spend: 'known', stop: null } }
  await s.journal.offerCard(card)
  const source: any = { repository: 'acme/widgets', branch: 'worker', head, cwd: '/workspace/worker', remote: 'origin', remoteUrl: 'https://github.com/acme/widgets.git',
    defaultBranch: 'main', runId: run.id, teamId: run.goal, runtime: 'alpha', sessionId: 'worker' }
  const decision: any = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: s.contract.digest, choice: 'accept-open-pr' }
  const publication: any = { id: 'publication', source, decision, at: 100, stage: 'push-prepared', effectStarted: false }
  await s.journal.publication(publication)
  await s.journal.publication({ ...publication, stage: 'pushed' })
  await s.journal.publication({ ...publication, stage: 'completed' }, { repository: source.repository, number: 7, branch: source.branch, head, branchOwner: 'lead', state: 'open', at: 100, check: null })
  await s.journal.decideCard(decision, null)
  const owner = new LeadHandbacks({ journal: s.journal, now: () => 100, gate: async () => null, round: () => 4,
    open: async op => op.round, release: async () => {}, reviewed: async () => null, push: async () => {} })
  await owner.observe([{ source: 'pull-request', project: s.project.path, repository: 'acme/widgets', subject: '7', event: 'failure-1', action: 'checks-failed', at: 101,
    head, fork: false, title: '', body: '', url: 'https://github.com/acme/widgets/pull/7', trigger: null, check: { head, state: 'failed', total: 1 } }])
  const operation = s.journal.state.handbacks.at(-1)!
  assert.equal(operation.stage, 'running')
  const home = await scratch(t), disk = await open(home); t.after(() => disk.close())
  for (const record of s.records) await disk.append(record)
  const journal = await createLeadJournal(disk), path = s.project.path + '/panel.tsx'
  await journal.saveWorkerApproval({ id: 'rule', contractDigest: s.contract.digest, goalStartedSeq: journal.state.goalStartedSeq,
    key: { kind: 'fileChange', path }, target: path, count: 0 })
  const awaiting = { ...operation, stage: 'awaiting-ci' as const, publishedHead: 'b'.repeat(40) }
  if (crash) {
    await disk.append({ version: 1, seq: journal.state.seq + 1, type: 'worker-rule-dispatch', id: 'rule', diff: '+repair' })
    await disk.append({ version: 1, seq: journal.state.seq + 2, type: 'handback', operation: awaiting })
  } else {
    await assert.rejects(journal.useWorkerApproval('rule', () => true, async () => { throw Error('uncertain') }, '+repair'))
    await journal.handback(awaiting)
  }
  await disk.close()
  const restoredDisk = await open(home); t.after(() => restoredDisk.close())
  const restored = await createLeadJournal(restoredDisk)
  assert.equal(restored.state.phase, 'waiting-for-user')
  assert.equal(restored.state.managementReason, 'lead-worker-audit-failed')
  assert.equal(restored.state.workerApprovals[0]!.dispatch!.diff, '+repair')
  assert.deepEqual(replayLeadJournal(await restoredDisk.read()), restored.state)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(restored.state, 'b'.repeat(64))).state, restored.state)
  if (!crash) assert.deepEqual(restored.state, journal.state)
  await restored.revokeWorkerApproval('rule', s.contract.digest)
  await restored.resume()
  assert.equal(restored.state.phase, 'following')
  assert.equal(restored.state.workerApprovals[0]!.entries![0]!.diff, '+repair')
})

test('file journal repair timer is idempotent after revoke and preserves Resume revision', async t => {
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const digest = await seedApproval(journal)
  await assert.rejects(journal.useWorkerApproval('rule', () => true, async () => { throw Error('uncertain') }, '+inspect'))
  await journal.revokeWorkerApproval('rule', digest)
  const revision = journal.state.seq, before = await disk.read()
  for (let i = 0; i < 5; i++) await journal.setManagementPhase('waiting-for-user', 'lead-repair-unverified')
  assert.deepEqual(await disk.read(), before)
  const timer = journal.setManagementPhase('waiting-for-user', 'lead-repair-unverified')
  const resumed = journal.resume(revision)
  await Promise.all([timer, resumed])
  assert.equal(journal.state.phase, 'running')
})

test('file journal loads 1951 revoke renewal approval and dispatched-start bytes', async t => {
  const { createHash } = await import('node:crypto')
  const home = await scratch(t), disk = await open(home), journal = await createLeadJournal(disk)
  t.after(() => disk.close())
  const digest = await seedApproval(journal), file = join(home, 'lead/thread-1.ndjson')
  await disk.close()
  let previous = JSON.parse((await fs.readFile(file, 'utf8')).trim().split('\n').at(-1)!).checksum
  let seq = journal.state.seq
  const events = [
    { type: 'worker-rule-dispatch', id: 'rule', diff: '+legacy' }, { type: 'worker-rule-revoked', id: 'rule' },
    { type: 'renew-plan', now: 1300 },
    { type: 'card-decision', decision: { version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 2, contractDigest: digest, choice: 'approve' }, expiresAt: 1900 },
    { type: 'attempt', id: 'a1', correlationId: 'a1', method: 'flow/start-goal', action: null, arguments: summarizeLeadArguments({}), kind: 'mutation', stepId: 'work', policyRevision: 1, projectPolicyRevision: null, contractRevision: 1 },
    { type: 'decision', id: 'a1', effect: 'allow', reason: 'policy', rule: null }, { type: 'dispatch-start', id: 'a1', dispatched: true },
  ]
  for (const event of events) {
    const record = { version: 1, seq: ++seq, ...event }
    const checksum = createHash('sha256').update(JSON.stringify({ record, previous })).digest('hex')
    await fs.appendFile(file, JSON.stringify({ record, previous, checksum }) + '\n'); previous = checksum
  }
  const next = await open(home); t.after(() => next.close())
  const restored = await createLeadJournal(next)
  assert.equal(restored.state.phase, 'running')
  assert.equal(restored.state.managementReason, null)
  assert.equal(restored.state.attempts.get('a1')!.dispatched, true)
})

for (const uncertain of [false, true]) test(`following retires approval authority and preserves audit history through repair replay (uncertain: ${uncertain})`, async t => {
  const { leadRig } = await import('./fixtures/lead.js')
  const { LeadHandbacks } = await import('../src/lead/handback.js')
  const s = await leadRig(t), run = await s.start(); await s.observe(0)
  const path = s.project.path + '/panel.tsx', head = 'a'.repeat(40)
  const rule = { id: 'rule-a', contractDigest: s.contract.digest, goalStartedSeq: s.journal.state.goalStartedSeq,
    key: { kind: 'fileChange' as const, path }, target: path, count: 0 }
  await s.journal.saveWorkerApproval(rule)
  await s.journal.useWorkerApproval(rule.id, () => true, async () => {}, '+confirmed')
  const card: any = { version: 1, id: 'result', revision: 1, type: 'result', contractDigest: s.contract.digest,
    outcome: 'reviewed', summary: 'Reviewed fixture', assertions: [], budget: { version: 1, revision: 1, caps: s.contract.caps,
      leadUsdMicros: 0, workerUsdMicros: 0, reservedUsdMicros: 0, roundsAdmitted: 1, spend: 'known', stop: null } }
  await s.journal.offerCard(card)
  const source: any = { repository: 'acme/widgets', branch: 'worker', head, cwd: '/workspace/worker', remote: 'origin', remoteUrl: 'https://github.com/acme/widgets.git',
    defaultBranch: 'main', runId: run.id, teamId: run.goal, runtime: 'alpha', sessionId: 'worker' }
  const decision: any = { version: 1, cardId: card.id, cardType: card.type, expectedRevision: 1, contractDigest: s.contract.digest, choice: 'accept-open-pr' }
  const publication: any = { id: 'publication', source, decision, at: 100, stage: 'push-prepared', effectStarted: false }
  await s.journal.publication(publication); await s.journal.publication({ ...publication, stage: 'pushed' })
  await s.journal.publication({ ...publication, stage: 'completed' }, { repository: source.repository, number: 7, branch: source.branch, head, branchOwner: 'lead', state: 'open', at: 100, check: null })
  await s.journal.decideCard(decision, null)
  const followingSeq = s.journal.state.seq
  const owner = new LeadHandbacks({ journal: s.journal, now: () => 100, gate: async () => null, round: () => 4,
    open: async op => op.round, release: async () => {}, reviewed: async () => null, push: async () => {} })
  await owner.observe([{ source: 'pull-request', project: s.project.path, repository: 'acme/widgets', subject: '7', event: 'failure-1', action: 'checks-failed', at: 101,
    head, fork: false, title: '', body: '', url: 'https://github.com/acme/widgets/pull/7', trigger: null, check: { head, state: 'failed', total: 1 } }])
  const home = await scratch(t), disk = await open(home); t.after(() => disk.close())
  for (const record of s.records) {
    if (uncertain && record.seq === followingSeq) await disk.append({ version: 1, seq: record.seq, type: 'worker-rule-dispatch', id: rule.id, diff: '+unacknowledged' })
    await disk.append({ ...record, seq: record.seq + (uncertain && record.seq >= followingSeq ? 1 : 0) })
    if (record.seq === followingSeq) {
      const atFollowing = await createLeadJournal(disk)
      assert.equal(atFollowing.state.workerApprovals[0]!.revoked, true)
      assert.equal(atFollowing.state.workerAuditWait, uncertain)
      assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(atFollowing.state, 'b'.repeat(64))).state, atFollowing.state)
    }
  }
  let journal = await createLeadJournal(disk)
  assert.equal(journal.state.workerApprovals[0]!.revoked, true)
  assert.equal(await journal.useWorkerApproval(rule.id, () => true, async () => { assert.fail('old authority must not re-arm') }), false)
  assert.equal(journal.state.workerApprovals[0]!.entries!.at(-1)!.diff, '+confirmed')
  if (uncertain) {
    assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
    assert.equal(journal.state.workerApprovals[0]!.entries![0]!.diff, '+unacknowledged')
  }
  // A valid #1951 repair saved the same key under a fresh id and dispatched it.
  const seq = journal.state.seq
  await disk.append({ version: 1, seq: seq + 1, type: 'worker-rule-saved', rule: { ...rule, id: 'rule-b' } })
  await disk.append({ version: 1, seq: seq + 2, type: 'worker-rule-dispatch', id: 'rule-b', diff: '+repair' })
  await disk.append({ version: 1, seq: seq + 3, type: 'worker-rule-used', id: 'rule-b', diff: '+repair' })
  await disk.close()
  const next = await open(home); t.after(() => next.close()); journal = await createLeadJournal(next)
  assert.deepEqual(replayLeadJournal(await next.read()), journal.state)
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
  assert.equal(journal.state.workerApprovals[0]!.revoked, true)
  assert.equal(journal.state.workerApprovals[1]!.count, 1)
  assert.equal(journal.state.managementReason, uncertain ? 'lead-worker-audit-failed' : null)
})

for (const revoked of [false, true]) test(`revised plan preserves a worker audit fence and diff through file reopen (revoked: ${revoked})`, async t => {
  const home = await scratch(t), disk = await open(home); t.after(() => disk.close())
  let journal = await createLeadJournal(disk)
  const digest = await seedApproval(journal)
  if (revoked) {
    await assert.rejects(journal.useWorkerApproval('rule', () => true, async () => { throw Error('uncertain') }, '+inspect'))
    await journal.revokeWorkerApproval('rule', digest)
  } else {
    await disk.append({ version: 1, seq: journal.state.seq + 1, type: 'worker-rule-dispatch', id: 'rule', diff: '+inspect' })
    journal = await createLeadJournal(disk)
  }
  const contract = { ...journal.state.contract!, revision: 2, digest: 'b'.repeat(64), goal: 'Inspect again' }
  await journal.offerCard({ version: 1, id: 'plan2', revision: 1, type: 'plan', contractDigest: contract.digest, contract })
  await journal.decideCard({ version: 1, cardId: 'plan2', cardType: 'plan', expectedRevision: 1, contractDigest: contract.digest, choice: 'approve' }, 2000)
  assert.equal(journal.state.phase, 'waiting-for-user')
  assert.equal(journal.state.managementReason, 'lead-worker-audit-failed')
  assert.equal(journal.state.workerAuditWait, true)
  assert.equal(journal.state.workerApprovals[0]!.revoked, true)
  assert.equal(journal.state.workerApprovals[0]!.entries![0]!.diff, '+inspect')
  assert.deepEqual(parseLeadCheckpoint(leadCheckpoint(journal.state, 'b'.repeat(64))).state, journal.state)
  await disk.close()
  const next = await open(home); t.after(() => next.close())
  const restored = await createLeadJournal(next)
  assert.deepEqual(restored.state, journal.state)
  await restored.resume()
  assert.equal(restored.state.phase, 'running')
  assert.equal(restored.state.workerApprovals[0]!.entries![0]!.diff, '+inspect')
})
