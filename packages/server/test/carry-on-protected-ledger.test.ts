import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { CarryOnIncidents, type CarryOnRecord } from '../src/carry-on/incidents.js'

const rig = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-carry-protected-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'incidents.json')
  return { file, ledger: new CarryOnIncidents({ file }) }
}
const record = (id: string, pending = true): CarryOnRecord => ({
  incidentId: `incident-${id}`, runtime: 'fake', sessionId: id, owner: 'chat', state: 'stopped', cause: 'credits', turnId: `turn-${id}`,
  agent: 'fake', from: { name: 'Fake' }, resetsAt: null, nextAt: null, openedAt: 1, lastAt: 1, tried: [], hops: 0, alwaysScope: 'desk',
  ...(pending ? { unwritten: [{ id: `marker-${id}`, runtime: 'fake', sessionId: id, phase: 'stopped' }] } : {}),
})

test('all 64 protected records refuse admission without evicting an unwritten marker', async t => {
  const { file, ledger } = await rig(t)
  for (let n = 0; n < 64; n++) await ledger.serial(() => ledger.put(record(String(n))))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put(record('extra'))), /capacity/i)
  assert.deepEqual(await readFile(file), before)
  const reopened = new CarryOnIncidents({ file }); await reopened.load()
  assert.equal(reopened.all().length, 64)
  assert.ok(reopened.get('fake', '0')?.unwritten?.length)
})

test('a rekey cannot overwrite an unrelated protected record', async t => {
  const { file, ledger } = await rig(t)
  await ledger.serial(() => ledger.put(record('first')))
  await ledger.serial(() => ledger.put(record('second')))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put({ ...record('first'), sessionId: 'second' }, { runtime: 'fake', sessionId: 'first' })), /capacity|collision/i)
  assert.deepEqual(await readFile(file), before)
})

test('oversized writes preserve the existing ledger bytes', async t => {
  const { file, ledger } = await rig(t)
  await ledger.serial(() => ledger.put(record('first')))
  const before = await readFile(file)
  const large = { ...record('second'), future: '\\u0001'.repeat(50_000) }
  await assert.rejects(ledger.serial(() => ledger.put(large)), /capacity|size/i)
  assert.deepEqual(await readFile(file), before)
})

test('an unreadable ledger is not replaced on the next put', async t => {
  const { file, ledger } = await rig(t)
  const before = Buffer.from('{broken JSON')
  await writeFile(file, before)
  await ledger.load()
  await assert.rejects(ledger.serial(() => ledger.put(record('new'))))
  assert.deepEqual(await readFile(file), before)
})

test('global pending capacity refuses the 65th marker and retains all earlier entries', async t => {
  const { file, ledger } = await rig(t)
  for (let n = 0; n < 16; n++) {
    const base = record(String(n))
    const unwritten = Array.from({ length: 4 }, (_, at) => ({ id: `marker-${n}-${at}`, runtime: 'fake', sessionId: String(n), phase: 'stopped' as const }))
    await ledger.serial(() => ledger.put({ ...base, unwritten }))
  }
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put(record('extra'))), /capacity/i)
  assert.deepEqual(await readFile(file), before)
})

test('a 17th pending marker is refused without truncating an existing incident', async t => {
  const { file, ledger } = await rig(t)
  const base = record('full')
  const pending = Array.from({ length: 16 }, (_, n) => ({ id: `marker-${n}`, runtime: 'fake', sessionId: 'full', phase: 'stopped' as const }))
  await ledger.serial(() => ledger.put({ ...base, unwritten: pending }))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put({ ...base, unwritten: [...pending, { ...pending[0]!, id: 'excess' }] })), /capacity/i)
  assert.deepEqual(await readFile(file), before)
})

test('duplicate record identities freeze an ambiguous ledger without rewriting its bytes', async t => {
  const { file, ledger } = await rig(t)
  const before = Buffer.from(JSON.stringify({ version: 1, records: [record('duplicate'), record('duplicate')] }))
  await writeFile(file, before)
  await ledger.load()
  await assert.rejects(ledger.serial(() => ledger.put(record('new'))))
  assert.deepEqual(await readFile(file), before)
})

test('a durable two-slot reservation precedes effects and counts against marker capacity', async t => {
  const { file, ledger } = await rig(t)
  const base = record('reserve', false)
  await ledger.serial(() => ledger.put(base))
  const reservable = ledger as unknown as { reserve: (record: CarryOnRecord, slots: 1 | 2, action: 'move') => Promise<CarryOnRecord> }
  const reserved = await ledger.serial(() => reservable.reserve(base, 2, 'move'))
  const data = JSON.parse(await readFile(file, 'utf8')) as { records: { reservation?: { slots: number; ceilingBytes: number; id: string } }[] }
  assert.equal(data.records[0]?.reservation?.slots, 2)
  assert.equal(data.records[0]?.reservation?.id, reserved.reservation?.id)
  assert.ok((data.records[0]?.reservation?.ceilingBytes ?? 0) > Buffer.byteLength(JSON.stringify(data.records[0])))
})

test('external replacement of the loaded ledger cannot be overwritten', async t => {
  const { file, ledger } = await rig(t)
  await ledger.serial(() => ledger.put(record('first')))
  const changed = Buffer.from(JSON.stringify({ version: 1, records: [record('external')] }))
  await writeFile(file, changed)
  await assert.rejects(ledger.serial(() => ledger.put(record('next'))))
  assert.deepEqual(await readFile(file), changed)
})

test('an ordinary record update cannot silently remove a pending marker', async t => {
  const { file, ledger } = await rig(t)
  const base = record('keep')
  await ledger.serial(() => ledger.put(base))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put({ ...base, unwritten: undefined })), /pending|marker|protected/i)
  assert.deepEqual(await readFile(file), before)
})

test('an outstanding reservation cannot be silently removed by a later update', async t => {
  const { file, ledger } = await rig(t)
  const base = record('reserve', false)
  await ledger.serial(() => ledger.put(base))
  const reserved = await ledger.serial(() => ledger.reserve(base, 2, 'move'))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put({ ...reserved, reservation: undefined })), /reservation|protected/i)
  assert.deepEqual(await readFile(file), before)
})

test('per-incident capacity counts pending markers together with unmaterialized slots', async t => {
  for (const [count, slots, allowed] of [[14, 2, true], [15, 2, false], [16, 1, false]] as const) {
    const { file, ledger } = await rig(t)
    const base = { ...record(`case-${count}`, false), unwritten: Array.from({ length: count }, (_, n) => ({ id: `marker-${n}`, runtime: 'fake', sessionId: `case-${count}`, phase: 'stopped' as const })) }
    await ledger.serial(() => ledger.put(base))
    const before = await readFile(file)
    if (allowed) {
      const held = await ledger.serial(() => ledger.reserve(base, slots, 'move'))
      assert.equal((held.unwritten?.length ?? 0) + held.reservation!.slots, 16)
    } else {
      await assert.rejects(ledger.serial(() => ledger.reserve(base, slots, 'move')), /capacity/i)
      assert.deepEqual(await readFile(file), before)
    }
  }
})

test('an ordinary update cannot mutate a protected marker with the same ID', async t => {
  const { file, ledger } = await rig(t)
  const base = { ...record('fixed'), unwritten: [{ id: 'fixed-marker', runtime: 'fake', sessionId: 'fixed', phase: 'stopped' as const,
    anchor: { kind: 'turn' as const, turnId: 'old-turn' }, future: { keep: true } }] }
  await ledger.serial(() => ledger.put(base))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put({ ...base, unwritten: [{ ...base.unwritten[0]!, anchor: { kind: 'turn', turnId: 'new-turn' }, future: { keep: false } }] } as unknown as CarryOnRecord)), /marker|protected/i)
  assert.deepEqual(await readFile(file), before)
})

test('an undercharged persisted marker escrow freezes the existing file', async t => {
  const { file, ledger } = await rig(t)
  const bad = { ...record('escrow'), unwritten: [{ id: 'escrow-marker', runtime: 'fake', sessionId: 'escrow', phase: 'stopped',
    anchor: { kind: 'continuation', operationId: 'operation' }, prospective: true,
    receipt: { operationId: 'operation', incidentId: 'incident-escrow', incarnation: 'owner', ceilingBytes: 1 } }] }
  const before = Buffer.from(JSON.stringify({ version: 1, records: [bad] }))
  await writeFile(file, before)
  await ledger.load()
  await assert.rejects(ledger.serial(() => ledger.put(record('next'))))
  assert.deepEqual(await readFile(file), before)
})

test('a symlinked carry-on ledger is preserved and never used as a writable file', async t => {
  const { symlink, lstat } = await import('node:fs/promises')
  const { file, ledger } = await rig(t)
  const target = `${file}.target`
  const original = Buffer.from(JSON.stringify({ version: 1, records: [record('protected')] }))
  await writeFile(target, original)
  try { await symlink(target, file) } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Windows account cannot create a symlink'); return }
    throw error
  }
  await ledger.load()
  await assert.rejects(ledger.serial(() => ledger.put(record('new'))))
  assert.equal((await lstat(file)).isSymbolicLink(), true)
  assert.deepEqual(await readFile(target), original)
})

test('materializing a slot requires a matching new protected marker', async t => {
  const { file, ledger } = await rig(t)
  const base = record('materialize', false)
  await ledger.serial(() => ledger.put(base))
  const reserved = await ledger.serial(() => ledger.reserve(base, 2, 'move'))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put({ ...reserved, reservation: { ...reserved.reservation!, slots: 1 } })), /reservation|marker|protected/i)
  assert.deepEqual(await readFile(file), before)
})

test('the 240 KiB bound uses actual encoded bytes and preserves the exact boundary', async t => {
  const { file, ledger } = await rig(t)
  const base = { ...record('boundary', false), futurePadding: '' }
  const overhead = Buffer.byteLength(JSON.stringify({ version: 1, records: [base] }), 'utf8')
  const exact = { ...base, futurePadding: 'x'.repeat(240 * 1024 - overhead) }
  await ledger.serial(() => ledger.put(exact))
  const before = await readFile(file)
  assert.equal(before.length, 240 * 1024)
  await assert.rejects(ledger.serial(() => ledger.put(record('excess', false))), /capacity|size/i)
  assert.deepEqual(await readFile(file), before)
})

test('invalid UTF-8 in an otherwise shaped ledger is preserved byte for byte', async t => {
  const { file, ledger } = await rig(t)
  const body = JSON.stringify({ version: 1, records: [{ ...record('bad-utf8'), future: '__INVALID__' }] })
  const [left, right] = body.split('__INVALID__')
  const before = Buffer.concat([Buffer.from(left!), Buffer.from([0xff]), Buffer.from(right!)])
  await writeFile(file, before)
  await ledger.load()
  await assert.rejects(ledger.serial(() => ledger.put(record('next'))))
  assert.deepEqual(await readFile(file), before)
})

test('legacy uncertain incidents without markers are protected from eviction and rekey', async t => {
  const { file, ledger } = await rig(t)
  for (let n = 0; n < 64; n++) await ledger.serial(() => ledger.put({ ...record(String(n), false), state: 'asked', uncertain: true }))
  const before = await readFile(file)
  await assert.rejects(ledger.serial(() => ledger.put(record('new', false))), /capacity/i)
  await assert.rejects(ledger.serial(() => ledger.put({ ...record('other', false), sessionId: '0' }, { runtime: 'fake', sessionId: '1' })), /capacity|protected/i)
  assert.deepEqual(await readFile(file), before)
})
