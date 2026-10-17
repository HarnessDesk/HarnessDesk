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
  assert.equal((await recovered.read()).length, 1)
  assert.equal(recovered.report.truncatedTail, true)
  assert.ok(recovered.report.quarantine)
  assert.equal(await fs.readFile(recovered.report.quarantine, 'utf8'), '{"version":1,"seq":2')
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('\n'))
  await recovered.append(parseLeadJournalRecord({ version: 1, seq: 2, type: 'stop' }))
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
  assert.equal((await owner.recover(async () => null))[0]?.type, 'not-dispatched')
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
