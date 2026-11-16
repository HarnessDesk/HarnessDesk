import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import test from 'node:test'

import { PersistentInsight, sourceKey } from '../src/ledger/insight-persistent.js'
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

for (const mode of ['append', 'rewrite'] as const) test(`a pinned large generation permits a fitting ${mode} replacement and keeps the old reference`, (t) => {
  const dir = tempDir('hd-insight-replacement-')
  const target = { runtime: 'fake', path: '/synthetic/source', kind: 'gemini' as const, size: 1, mtime: 1, identity: 'fake' }
  const before = Array.from({ length: 8 }, (_, i) => sample(`old-${i}`, 's0', i + 1))
  const seed = new PersistentInsight(dir); assert.ok(seed.acquire())
  assert.equal(seed.put({ target, offset: 1, tail: [], samples: before, limited: false }), true)
  const held = seed.get(target, () => false); assert.ok(held); seed.release(); seed.close()
  const database = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  const originalBytes = (database.prepare('SELECT bytes FROM generations WHERE id = ?').get(held.generation) as { bytes: number }).bytes
  const limit = Math.floor(originalBytes * 1.7)
  const store = new PersistentInsight(dir, limit); t.after(() => { store.close(); database.close() })
  assert.ok(store.acquire()); assert.ok(store.get(target, () => false), 'previous generation is pinned')
  const changed = { ...target, size: 2, mtime: 2 }
  const after = mode === 'append' ? [sample('added', 's0', 9)] : before.map((one, i) => ({ ...one, key: `new-${i}` }))
  assert.equal(store.put({ target: changed, offset: 2, tail: [], samples: after, limited: false }, mode === 'append' ? held.generation : undefined), true,
    'replacement fits alone even while its predecessor is pinned')
  const current = store.get(changed, () => true); assert.ok(current)
  assert.equal(current.entry.samples.length, mode === 'append' ? 9 : 8)
  assert.deepEqual(store.get(target, () => true, held.generation)?.entry.samples.map(one => one.key), before.map(one => one.key))
  const snapshot = new InsightSnapshot(join(dir, 'insight-cache-v2.sqlite'), [{ target, generation: held.generation }])
  const old: string[] = []; snapshot.each(one => old.push(one.key)); snapshot.close()
  assert.deepEqual(old, before.map(one => one.key), 'old snapshot remains authentic and readable')
  store.release(); assert.ok(store.acquire())
  const reopened = store.get(changed, () => true); assert.ok(reopened); assert.equal(reopened.entry.offset, 2)
  assert.equal(reopened.entry.samples.length, mode === 'append' ? 9 : 8)
  const extra = { ...target, path: '/synthetic/extra', identity: 'extra' }
  store.put({ target: extra, offset: 1, tail: [], samples: [], limited: false })
  assert.equal(database.prepare('SELECT id FROM generations WHERE id = ?').get(held.generation), undefined, 'later publication reclaims the unpinned superseded generation')
})

test('an unpinned replaced generation is credited once while another source is evicted', (t) => {
  const dir = tempDir('hd-insight-replace-evict-')
  const target = (name: string) => ({ runtime: 'fake', path: `/synthetic/${name}`, kind: 'gemini' as const, size: 1, mtime: 1, identity: name })
  const first = target('source-a'), other = target('source-b'), samples = Array.from({ length: 8 }, (_, i) => sample(`sample-${i}`, 's0', i + 1))
  const entry = (source: typeof first) => ({ target: source, offset: 1, tail: [], samples, limited: false })
  const seed = new PersistentInsight(dir); assert.ok(seed.acquire()); assert.ok(seed.put(entry(first))); assert.ok(seed.put(entry(other))); seed.release(); seed.close()
  const db = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite')); t.after(() => db.close())
  const old = db.prepare('SELECT g.id, g.bytes FROM generations g JOIN published p ON p.generation = g.id WHERE g.source = ?').get(sourceKey(first)) as { id: string; bytes: number }
  const store = new PersistentInsight(dir, Math.floor(old.bytes * 1.75)); t.after(() => store.close()); assert.ok(store.acquire())
  assert.equal(store.put({ ...entry(first), target: { ...first, size: 2, mtime: 2 }, offset: 2 }), true)
  assert.equal(store.get(other, () => false), null, 'unrelated source must be evicted to fit')
  assert.ok(store.get(first, () => true, old.id), 'the credited predecessor is not also evicted')
  const published = db.prepare('SELECT SUM(g.bytes) AS bytes FROM generations g JOIN published p ON p.generation = g.id').get() as { bytes: number }
  assert.ok(published.bytes <= Math.floor(old.bytes * 1.75), 'published sources stay within budget')
})

test('replacement cannot evict another pinned source or repeatedly credit older pinned generations', (t) => {
  const dir = tempDir('hd-insight-replace-pins-')
  const target = (name: string) => ({ runtime: 'fake', path: `/synthetic/${name}`, kind: 'gemini' as const, size: 1, mtime: 1, identity: name })
  const first = target('source-a'), other = target('source-b'), samples = Array.from({ length: 8 }, (_, i) => sample(`sample-${i}`, 's0', i + 1))
  const entry = (source: typeof first) => ({ target: source, offset: 1, tail: [], samples, limited: false })
  const seed = new PersistentInsight(dir); assert.ok(seed.acquire()); assert.ok(seed.put(entry(first))); assert.ok(seed.put(entry(other))); seed.release(); seed.close()
  const db = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite')); t.after(() => db.close())
  const bytes = (db.prepare('SELECT bytes FROM generations WHERE source = ?').get(sourceKey(first)) as { bytes: number }).bytes
  const limit = Math.floor(bytes * 1.75), store = new PersistentInsight(dir, limit); t.after(() => store.close()); assert.ok(store.acquire())
  assert.ok(store.get(other, () => false), 'unrelated generation is pinned')
  const changed = { ...first, size: 2, mtime: 2 }
  assert.equal(store.put({ ...entry(first), target: changed, offset: 2 }), false, 'other pinned source still counts')
  assert.ok(store.get(first, () => false)); assert.ok(store.get(other, () => false))
  store.release(); assert.ok(store.acquire())
  assert.ok(store.get(first, () => false), 'old generation is pinned')
  assert.equal(store.put({ ...entry(first), target: changed, offset: 2 }), true)
  const newer = { ...first, size: 3, mtime: 3 }
  assert.equal(store.put({ ...entry(first), target: newer, offset: 3 }), false, 'older pinned generation is not credited again')
  assert.equal(store.get(changed, () => true)?.entry.offset, 2)
})

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
