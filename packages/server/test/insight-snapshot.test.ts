import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import test from 'node:test'

import { PersistentInsight } from '../src/ledger/insight-persistent.js'
import { InsightSnapshot } from '../src/ledger/insight-snapshot.js'
import type { UsageSample } from '../src/ledger/insight.js'
import { tempDir } from './scratch.js'

const sample = (id: string, session: string, input: number): UsageSample => ({
  key: id, source: { id: 'source', runtime: 'fake', kind: 'corpus', label: 'Recorded usage', observedAt: 1, checkedAt: 1, stale: false, problem: null },
  runtime: 'fake', sessionId: session, turnId: null, requestId: id, project: '/repo', model: null, from: 1, to: 1,
  scope: 'call', includesChildren: false, input: { value: input, quality: 'exact' }, output: { value: 0, quality: 'exact' },
  cacheRead: { value: 0, quality: 'exact' }, cacheWrite: { value: 0, quality: 'exact' }, usd: { value: null, quality: 'unknown' }, moneyBasis: 'unknown',
})

const fixture = () => {
  const dir = tempDir('hd-insight-snapshot-'); const store = new PersistentInsight(dir)
  assert.ok(store.acquire())
  const target = { runtime: 'fake', path: '/synthetic/source', kind: 'gemini' as const, size: 1, mtime: 1, identity: 'fake' }
  assert.ok(store.put({ target, offset: 1, tail: [], samples: [sample('one', 's0', 1), sample('two', 's0', 2), sample('three', 's1', 3)], limited: false }))
  const found = store.get(target, () => false); assert.ok(found)
  return { dir, store, ref: { target, generation: found.generation } }
}

test('snapshot authenticates unique groups before expanding duplicate source references', (t) => {
  const { dir, store, ref } = fixture(); t.after(() => store.close())
  const snap = new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [ref, ref]); t.after(() => snap.close())
  const all: string[] = []; snap.each((one) => all.push(one.key))
  assert.deepEqual(all, ['one', 'two', 'three', 'one', 'two', 'three'])
  const selected: [string, number, number][] = []
  snap.select(['/repo'], [{ runtime: 'fake', session: 's0' }], (one, source, ordinal) => selected.push([one.key, source, ordinal]))
  assert.deepEqual(selected, [['one', 0, 0], ['two', 0, 1], ['one', 1, 0], ['two', 1, 1]])
})

test('an external commit after snapshot verification makes selection fail instead of return stale or empty usage', (t) => {
  const { dir, store, ref } = fixture(); t.after(() => store.close())
  const snap = new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [ref]); t.after(() => snap.close())
  const writer = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  writer.exec('DELETE FROM observations WHERE ordinal = 0'); writer.close()
  assert.throws(() => snap.select(['/repo'], [{ runtime: 'fake', session: 's0' }], () => {}), /Recorded usage cache is temporarily unavailable/)
})

test('a mismatched indexed session cannot hide a valid observation during snapshot verification', (t) => {
  const { dir, store, ref } = fixture(); t.after(() => store.close())
  const writer = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  writer.exec("UPDATE observations SET session = 'other' WHERE ordinal = 0"); writer.close()
  assert.throws(() => new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [ref]), /Recorded usage cache is temporarily unavailable/)
})

test('an external commit while candidates are being visited aborts the snapshot before success', (t) => {
  const { dir, store, ref } = fixture(); t.after(() => store.close())
  const snap = new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [ref]); t.after(() => snap.close())
  let updated = false
  assert.throws(() => snap.select(['/repo'], [{ runtime: 'fake', session: 's0' }], () => {
    if (updated) return
    updated = true
    const writer = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
    writer.exec('DELETE FROM observations WHERE ordinal = 0'); writer.close()
  }), /Recorded usage cache is temporarily unavailable/)
  assert.equal(updated, true)
})

test('candidate lookup uses the project/runtime/session index', (t) => {
  const { dir, store } = fixture(); t.after(() => store.close())
  const db = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  t.after(() => db.close())
  db.exec('CREATE TEMP TABLE wanted_projects (project TEXT PRIMARY KEY); CREATE TEMP TABLE wanted_sessions (runtime TEXT, session TEXT, PRIMARY KEY(runtime, session)); CREATE TEMP TABLE active (generation TEXT, source_order INTEGER); CREATE INDEX active_generation ON active(generation)')
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT o.generation, o.ordinal FROM wanted_projects p CROSS JOIN wanted_sessions w
    CROSS JOIN observations o INDEXED BY observations_lookup WHERE o.project = p.project AND o.runtime = w.runtime AND o.session = w.session
      AND EXISTS (SELECT 1 FROM active a WHERE a.generation = o.generation)`).all() as { detail: string }[]
  assert.ok(plan.some((row) => /SEARCH o USING (?:COVERING )?INDEX observations_lookup/.test(row.detail)), JSON.stringify(plan))
  const expanded = db.prepare(`EXPLAIN QUERY PLAN SELECT o.payload, o.ordinal, a.source_order FROM wanted_projects p CROSS JOIN wanted_sessions w
    CROSS JOIN observations o INDEXED BY observations_lookup JOIN active a ON a.generation = o.generation
    WHERE o.project = p.project AND o.runtime = w.runtime AND o.session = w.session ORDER BY a.source_order, o.ordinal`).all() as { detail: string }[]
  assert.ok(expanded.some((row) => /SEARCH o USING INDEX observations_lookup/.test(row.detail)), JSON.stringify(expanded))
  assert.ok(expanded.some((row) => /SEARCH a USING INDEX active_generation/.test(row.detail)), JSON.stringify(expanded))
})

test('candidate authentication ignores inactive generations of the same session', (t) => {
  const { dir, store, ref } = fixture(); t.after(() => store.close())
  assert.ok(store.put({ target: ref.target, offset: 1, tail: [], samples: [sample('new', 's0', 4)], limited: false }))
  const latest = store.get(ref.target, () => false); assert.ok(latest)
  const snap = new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [{ target: ref.target, generation: latest.generation }]); t.after(() => snap.close())
  const selected: string[] = []
  snap.select(['/repo'], [{ runtime: 'fake', session: 's0' }], (one) => selected.push(one.key))
  assert.deepEqual(selected, ['new'])
})

test('snapshot open failures are sanitized and do not expose cache paths', () => {
  const path = join(tempDir('hd-insight-private-path-'), 'missing', 'cache.sqlite')
  assert.throws(() => new InsightSnapshot(path, []), (error: unknown) => {
    assert.equal((error as Error).message, 'Recorded usage cache is temporarily unavailable. Try again.')
    assert.ok(!(error as Error).message.includes(path))
    return true
  })
})

for (const phase of ['authentication', 'whole group', 'expansion'] as const) test(`an indexed ${phase} omission fails instead of returning incomplete usage`, (t) => {
  const { dir, store, ref } = fixture(); t.after(() => store.close())
  const snap = new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [ref]); t.after(() => snap.close())
  const prepare = DatabaseSync.prototype.prepare
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql)
    const target = phase === 'expansion' ? sql.includes('ORDER BY a.source_order, o.ordinal') : sql.includes('ORDER BY o.generation, o.ordinal')
    if (!target) return statement
    return new Proxy(statement, { get(original, key) {
      if (key === 'iterate') return function* (...args: unknown[]) { if (phase === 'whole group') return; let skip = true; for (const row of original.iterate(...args as [])) { if (skip) { skip = false; continue }; yield row } }
      const value = Reflect.get(original, key, original)
      return typeof value === 'function' ? value.bind(original) : value
    } })
  })
  assert.throws(() => snap.select(['/repo'], [{ runtime: 'fake', session: 's0' }], () => {}), /Recorded usage cache is temporarily unavailable/)
})
