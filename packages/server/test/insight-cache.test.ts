import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { appendFile, link, mkdir, readFile, readdir, rename, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { Ledger } from '../src/ledger/index.js'
import { INSIGHT_BYTE_LIMIT_MESSAGE } from '../src/ledger/insight.js'
import { Pricing } from '../src/ledger/pricing.js'
import { tempDir } from './scratch.js'

const query = { root: '/work/project', from: Date.parse('2026-09-19'), to: Date.parse('2026-09-21') }
const meta = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', cwd: query.root } })}\n`
const event = (second: number) => `${JSON.stringify({ timestamp: `2026-09-20T00:00:${String(second).padStart(2, '0')}.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } } })}\n`

const fixture = async (limit?: number) => {
  const dir = tempDir('hd-insight-cache-'); const corpus = join(dir, 'corpus')
  await mkdir(corpus)
  const path = join(corpus, 'rollout.jsonl'); await writeFile(path, meta + event(0))
  const ledger = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }),
    ...(limit === undefined ? {} : { insightByteLimit: limit }) })
  return { ledger, path, corpus, dir }
}

const reads = (t: TestContext, corpus: string) => {
  const streams: fs.ReadStream[] = []; const starts: number[] = []
  const original = fs.createReadStream
  t.mock.method(fs, 'createReadStream', ((path: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    const stream = original(path, options)
    if (String(path).startsWith(corpus)) { streams.push(stream); starts.push(options?.start ?? 0) }
    return stream
  }) as typeof fs.createReadStream)
  return { streams, starts, bytes: () => streams.reduce((sum, stream) => sum + stream.bytesRead, 0) }
}

test('a second Usage open and timed refresh read no unchanged source bytes', async (t) => {
  const { ledger, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const first = await ledger.readInsight(query, { refresh: true }); const bytes = count.bytes()
  const second = await ledger.readInsight(query, { refresh: true })
  assert.equal(count.bytes(), bytes)
  assert.equal(count.streams.length, 1)
  assert.deepEqual(second.samples.map((sample) => sample.key), first.samples.map((sample) => sample.key))
})

test('unchanged observations survive a Ledger restart without rereading source bytes', async (t) => {
  const { ledger, corpus, dir } = await fixture()
  const count = reads(t, corpus)
  const first = await ledger.readInsight(query)
  const bytes = count.bytes()
  ledger.close()
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  const second = await reopened.readInsight(query)
  assert.deepEqual(second.samples.map((sample) => sample.key), first.samples.map((sample) => sample.key))
  assert.equal(count.bytes(), bytes, 'restart reuses the unchanged indexed observations')
})

test('default cache admits two large normalized sources that fit the aggregate budget across restart', async (t) => {
  const { InsightCache } = await import('../src/ledger/insight-cache.js')
  const dir = tempDir('hd-insight-large-source-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const targets: Parameters<InstanceType<typeof InsightCache>['reference']>[0][] = []
  for (let source = 0; source < 2; source++) {
    const path = join(corpus, `source-${source}.jsonl`)
    const header = JSON.stringify({ type: 'session_meta', payload: { id: `session-${source}`, cwd: query.root } }) + '\n'
    const records = Array.from({ length: 40_000 }, (_, i) => JSON.stringify({
      timestamp: new Date(Date.parse('2026-09-20T00:00:00Z') + i * 1000).toISOString(),
      type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0 } } }, seq: i,
    }) + '\n')
    await writeFile(path, header + records.join(''))
    const file = await stat(path)
    targets.push({ path, kind: 'codex', runtime: 'alpha', size: file.size, mtime: file.mtimeMs, changedAt: file.ctimeMs, identity: path })
  }
  const count = reads(t, corpus)
  const cache = new InsightCache(dir); t.after(() => cache.close())
  await cache.withLease(async () => {
    const refs = []
    for (const target of targets) {
      const result = await cache.reference(target, 64 * 1024 * 1024)
      assert.equal(result.limited, false)
      assert.ok(result.ref?.generation, 'each source fits the aggregate and must be indexed')
      refs.push(result.ref!)
    }
    const snapshot = cache.snapshot(refs); assert.ok(snapshot)
    try { let observations = 0; snapshot.each(() => { observations++ }); assert.equal(observations, 80_000) } finally { snapshot.close() }
  })
  const db = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'), { readOnly: true })
  const sizes = db.prepare('SELECT bytes FROM generations').all() as { bytes: number }[]; db.close()
  assert.equal(sizes.length, 2)
  assert.ok(sizes.every(({ bytes }) => bytes > 16 * 1024 * 1024))
  assert.ok(sizes.reduce((sum, item) => sum + item.bytes, 0) < 128 * 1024 * 1024)
  cache.close()
  const previousBytes = count.bytes(), reopened = new InsightCache(dir); t.after(() => reopened.close())
  await reopened.withLease(async () => { for (const target of targets) assert.ok((await reopened.reference(target, 64 * 1024 * 1024)).ref?.generation) })
  assert.equal(count.bytes(), previousBytes, 'restart reuses both indexed sources')
})

test('aggregate budget protects pinned generations and preserves data on oversized admission', async (t) => {
  const { PersistentInsight } = await import('../src/ledger/insight-persistent.js')
  const { ledger } = await fixture(); t.after(() => ledger.close())
  const sample = (await ledger.readInsight(query)).samples[0]!; assert.ok(sample)
  const target = (name: string) => ({ runtime: 'alpha', kind: 'gemini' as const, path: `/synthetic/${name}`, size: 1, mtime: 1, identity: name })
  const first = target('first'), second = target('other')
  const entry = (one: typeof first, model?: string) => ({ target: one, offset: 1, tail: [], samples: [{ ...sample, ...(model === undefined ? {} : { model }) }], limited: false })
  const seedDir = tempDir('hd-insight-size-seed-'), seed = new PersistentInsight(seedDir)
  assert.ok(seed.acquire()); assert.equal(seed.put(entry(first)), true); seed.release(); seed.close()
  const seedDb = new DatabaseSync(join(seedDir, 'insight-cache-v2.sqlite'), { readOnly: true })
  const size = (seedDb.prepare('SELECT bytes FROM generations').get() as { bytes: number }).bytes; seedDb.close()
  const dir = tempDir('hd-insight-total-limit-'), store = new PersistentInsight(dir, size + 64)
  t.after(() => store.close()); assert.ok(store.acquire())
  assert.equal(store.put(entry(first)), true)
  assert.equal(store.put(entry(second)), false, 'the pinned first generation cannot be evicted')
  assert.ok(store.get(first, () => true)); assert.equal(store.get(second, () => true), null)
  assert.equal(store.put(entry(first, 'x'.repeat(size + 64))), false, 'a source larger than total budget is refused')
  assert.ok(store.get(first, () => true), 'refusal retains the committed generation')
  store.release(); assert.ok(store.acquire())
  assert.equal(store.put(entry(second)), true, 'an unpinned source may be evicted within the same total budget')
  assert.equal(store.get(first, () => true), null); assert.ok(store.get(second, () => true))
})

for (const mode of ['append', 'rewrite'] as const) test(`a ${mode} of a pinned source persists its cursor for restart`, async (t) => {
  const { InsightCache } = await import('../src/ledger/insight-cache.js')
  const dir = tempDir('hd-insight-update-restart-'), corpus = join(dir, 'corpus'); await mkdir(corpus)
  const path = join(corpus, 'rollout.jsonl'), original = meta + Array.from({ length: 8 }, (_, i) => event(i)).join('')
  await writeFile(path, original)
  const target = async () => { const file = await stat(path); return { path, kind: 'codex' as const, runtime: 'alpha', size: file.size, mtime: file.mtimeMs, changedAt: file.ctimeMs, identity: path } }
  const first = await target(), seed = new InsightCache(dir)
  await seed.withLease(async () => { assert.ok((await seed.reference(first, 64 * 1024 * 1024)).ref?.generation) }); seed.close()
  const db = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'), { readOnly: true })
  const bytes = (db.prepare('SELECT bytes FROM generations').get() as { bytes: number }).bytes; db.close()
  const cache = new InsightCache(dir, Math.floor(bytes * 1.7)); t.after(() => cache.close())
  const count = reads(t, corpus)
  await cache.withLease(async () => {
    const prior = (await cache.reference(first, 64 * 1024 * 1024)).ref; assert.ok(prior?.generation)
    if (mode === 'append') await appendFile(path, event(8))
    else await writeFile(path, original.replace('\"input_tokens\":10', '\"input_tokens\":20'))
    await utimes(path, new Date(2000), new Date(2000))
    const changed = await target(), next = (await cache.reference(changed, 64 * 1024 * 1024)).ref
    assert.ok(next?.generation, 'changed source must publish an indexed generation')
    assert.equal(cache.resolve(prior, () => true).length, 8, 'the pinned previous reference stays readable')
    assert.equal(cache.resolve(next, () => true).length, mode === 'append' ? 9 : 8)
  })
  cache.close(); const bytesBefore = count.bytes(), reopened = new InsightCache(dir, Math.floor(bytes * 1.7)); t.after(() => reopened.close())
  await reopened.withLease(async () => { const ref = (await reopened.reference(await target(), 64 * 1024 * 1024)).ref; assert.ok(ref?.generation); assert.equal(reopened.resolve(ref, () => true).length, mode === 'append' ? 9 : 8) })
  assert.equal(count.bytes(), bytesBefore, 'restart reuses the changed source without reading its corpus')
})

test('serialized record fallback identity is opaque while the sample key stays stable', async (t) => {
  const { ledger, path } = await fixture(); t.after(() => ledger.close())
  const canary = 'synthetic-private-record-canary'
  const record = JSON.parse(event(0)); record.synthetic = canary
  await writeFile(path, meta + JSON.stringify(record) + '\n')
  const first = await ledger.readInsight(query)
  assert.equal(first.samples.length, 1)
  const sample = first.samples[0]!
  assert.ok(!sample.requestId?.includes(canary), 'fallback ID does not retain serialized record contents')
  assert.equal(sample.key, createHash('sha256').update(`${sample.source.id}:${JSON.stringify(record)}`).digest('hex'))
  assert.equal(sample.requestId, sample.key)
})

test('busy cache lease falls back to the source reader without losing usage', async (t) => {
  const { ledger, corpus, dir } = await fixture(); t.after(() => ledger.close())
  const lock = new DatabaseSync(join(dir, 'insight-pass-lock.sqlite'))
  lock.exec('CREATE TABLE lease (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE')
  t.after(() => { lock.exec('ROLLBACK'); lock.close() })
  const count = reads(t, corpus)
  const detail = await ledger.readInsight(query)
  assert.equal(detail.samples.length, 1)
  assert.equal(count.streams.length, 1)
  assert.ok(!detail.gaps.includes('A recorded usage source could not be read.'))
})

test('two Ledgers preserve usage when the first holds the cache lease during a read', async (t) => {
  const { ledger, path, corpus, dir } = await fixture(); t.after(() => ledger.close())
  const other = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => other.close())
  const original = fs.createReadStream
  const gate = new PassThrough(); let source: fs.ReadStream | undefined
  let opened!: () => void
  const firstOpened = new Promise<void>((resolve) => { opened = resolve })
  t.mock.method(fs, 'createReadStream', ((target: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    const stream = original(target, options)
    if (target === path && !source) { source = stream; opened(); return gate as unknown as fs.ReadStream }
    return stream
  }) as typeof fs.createReadStream)
  const reading = ledger.readInsight(query)
  await firstOpened
  try {
    const competing = await other.readInsight(query)
    assert.equal(competing.samples.length, 1)
  } finally { source!.pipe(gate) }
  const first = await reading
  assert.equal(first.samples.length, 1)
  assert.deepEqual(first.samples.map((sample) => sample.key), (await other.readInsight(query)).samples.map((sample) => sample.key))
})

test('a shared source pass retains each requested project in query order', async (t) => {
  const { ledger, path } = await fixture(); t.after(() => ledger.close())
  const otherRoot = '/work/other'
  const otherMeta = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-2', cwd: otherRoot } })}\n`
  await appendFile(path, otherMeta + event(1))
  const [other, first, otherAgain] = await ledger.readInsights([{ ...query, root: otherRoot }, query, { ...query, root: otherRoot }])
  assert.deepEqual(other!.samples.map((sample) => sample.from), [Date.parse('2026-09-20T00:00:01Z')])
  assert.deepEqual(first!.samples.map((sample) => sample.from), [Date.parse('2026-09-20T00:00:00Z')])
  assert.deepEqual(otherAgain, other)
})

test('failed cache admissions retain the host-lifetime source-count ceiling', async (t) => {
  const { InsightCache } = await import('../src/ledger/insight-cache.js')
  const { PersistentInsight } = await import('../src/ledger/insight-persistent.js')
  const dir = tempDir('hd-insight-memory-cap-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const Cache = InsightCache as unknown as new (state: string, bytes: number | undefined, files: number) => InstanceType<typeof InsightCache>
  const cache = new Cache(dir, undefined, 2); t.after(() => cache.close())
  t.mock.method(PersistentInsight.prototype, 'put', () => false)
  const count = reads(t, corpus)
  const targets: Parameters<InstanceType<typeof InsightCache>['read']>[0][] = []
  for (let i = 0; i < 3; i++) {
    const path = join(corpus, `${i}.jsonl`); await writeFile(path, meta + event(i)); const file = await stat(path)
    targets.push({ path, kind: 'codex' as const, runtime: 'alpha', size: file.size, mtime: file.mtimeMs, changedAt: file.ctimeMs, identity: path })
  }
  await cache.withLease(async () => { for (const target of targets) await cache.read(target, 10_000) })
  await cache.withLease(async () => { await cache.read(targets[0]!, 10_000) })
  assert.equal(count.streams.length, 4, 'the oldest failed-admission entry was evicted')
})

test('cache use is refreshed once after the lease and retains recently used sources', async (t) => {
  const { InsightCache } = await import('../src/ledger/insight-cache.js')
  const dir = tempDir('hd-insight-lru-batch-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const targets: Parameters<InstanceType<typeof InsightCache>['read']>[0][] = []
  for (let i = 0; i < 3; i++) {
    const path = join(corpus, `${i}.jsonl`); await writeFile(path, meta + event(i)); const file = await stat(path)
    targets.push({ path, kind: 'codex', runtime: 'alpha', size: file.size, mtime: file.mtimeMs, changedAt: file.ctimeMs, identity: path })
  }
  const seed = new InsightCache(dir)
  await seed.withLease(async () => { await seed.read(targets[0]!, 10_000) }); seed.close()
  const db = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  const bytes = (db.prepare('SELECT bytes FROM generations').get() as { bytes: number }).bytes
  const cache = new InsightCache(dir, bytes * 2 + 100); t.after(() => { cache.close(); db.close() })
  await cache.withLease(async () => { await cache.read(targets[1]!, 10_000) })
  const key = (target: typeof targets[number]) => createHash('sha256').update(JSON.stringify([target.runtime, target.kind, target.path])).digest('hex')
  db.prepare('UPDATE generations SET used = 1 WHERE source = ?').run(key(targets[0]!))
  db.prepare('UPDATE generations SET used = 2 WHERE source = ?').run(key(targets[1]!))
  await cache.withLease(async () => {
    await cache.read(targets[0]!, 10_000)
    assert.equal((db.prepare('SELECT used FROM generations WHERE source = ?').get(key(targets[0]!)) as { used: number }).used, 1,
      'the lease does not write last-used metadata per read')
  })
  assert.ok((db.prepare('SELECT used FROM generations WHERE source = ?').get(key(targets[0]!)) as { used: number }).used > 2)
  await cache.withLease(async () => { await cache.read(targets[2]!, 10_000) })
  const published = (db.prepare('SELECT source FROM published').all() as { source: string }[]).map((one) => one.source).sort()
  assert.deepEqual(published, [key(targets[0]!), key(targets[2]!)].sort(), 'the untouched source is evicted first')
})

test('a failed deferred cache-use refresh does not lose the completed usage read', async (t) => {
  const { ledger, corpus, dir } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const before = await ledger.readInsight(query)
  const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  cache.exec("CREATE TRIGGER fail_usage_refresh BEFORE UPDATE OF used ON generations BEGIN SELECT RAISE(ROLLBACK, 'synthetic LRU failure'); END")
  cache.close()
  const bytes = count.bytes()
  const after = await ledger.readInsight(query)
  assert.deepEqual(after.samples.map((one) => one.key), before.samples.map((one) => one.key))
  assert.equal(count.bytes(), bytes, 'a failed best-effort refresh does not cause a source reread')
})

test('a rejected cache write after an append keeps the source reading without rereading bytes', async (t) => {
  const { ledger, path, corpus, dir } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
  const prefix = (await stat(path)).size
  const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  cache.exec("CREATE TRIGGER fail_cache_insert BEFORE INSERT ON observations BEGIN SELECT RAISE(ROLLBACK, 'synthetic cache failure'); END")
  cache.close()
  await appendFile(path, event(1))
  const after = await ledger.readInsight(query)
  assert.equal(after.samples.length, 2)
  const bytes = count.bytes()
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
  assert.deepEqual(count.starts, [0, prefix])
  assert.equal(count.bytes(), bytes)
})

test('a killed cache publication leaves the previous generation usable', { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, corpus, dir } = await fixture()
  const before = await ledger.readInsight(query); ledger.close()
  const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  const row = cache.prepare('SELECT entry FROM generations').get() as { entry: string }
  cache.close()
  const entry = { ...JSON.parse(row.entry), samples: before.samples.map((one) => ({ ...one, key: 'uncommitted-synthetic-key' })) }
  const childCode = `
    import { DatabaseSync } from 'node:sqlite'
    import { PersistentInsight } from ${JSON.stringify(new URL('../src/ledger/insight-persistent.js', import.meta.url).href)}
    const cache = new PersistentInsight(process.env.HD_TEST_DIR)
    if (!cache.acquire()) process.exit(2)
    const exec = DatabaseSync.prototype.exec
    DatabaseSync.prototype.exec = function (sql) { if (sql === 'COMMIT') process.kill(process.pid, 'SIGKILL'); return exec.call(this, sql) }
    cache.put(JSON.parse(process.env.HD_TEST_ENTRY))
    process.exit(3)
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', childCode], {
    env: { ...process.env, HD_TEST_DIR: dir, HD_TEST_ENTRY: JSON.stringify(entry) }, encoding: 'utf8',
  })
  assert.equal(child.signal, 'SIGKILL', child.stderr)
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  const count = reads(t, corpus)
  const after = await reopened.readInsight(query)
  assert.deepEqual(after.samples.map((one) => one.key), before.samples.map((one) => one.key))
  assert.equal(count.streams.length, 0, 'the last committed generation remains valid')
})

test('a pass keeps a superseded pinned generation while another source is published', async (t) => {
  const { ledger, path, corpus, dir } = await fixture(); t.after(() => ledger.close())
  await ledger.readInsight(query)
  const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  const before = cache.prepare('SELECT generation FROM published').get() as { generation: string }
  await appendFile(path, event(1))
  await writeFile(join(corpus, 'zz-later.jsonl'), meta + event(2))
  const detail = await ledger.readInsight(query)
  assert.equal(detail.samples.length, 3)
  assert.ok(cache.prepare('SELECT id FROM generations WHERE id = ?').get(before.generation), 'the pass-pinned generation remains available')
  cache.close()
})

test('a small disposable-cache budget evicts an unpinned source for a new source', async (t) => {
  const dir = tempDir('hd-insight-eviction-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const firstPath = join(corpus, 'first.jsonl'); const nextPath = join(corpus, 'next.jsonl')
  await writeFile(firstPath, meta + event(0))
  const options = { stateDir: dir, insightCacheLimit: 1800, corpora: [{ runtime: 'alpha', kind: 'codex' as const, root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) }
  const ledger = new Ledger(options)
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
  await utimes(firstPath, new Date('2026-09-01'), new Date('2026-09-01'))
  await writeFile(nextPath, meta + event(1))
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
  const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  const rows = cache.prepare('SELECT source FROM published').all()
  cache.close()
  assert.equal(rows.length, 1, 'only one admitted source fits the test budget')
  ledger.close()
  const reopened = new Ledger(options); t.after(() => reopened.close())
  const count = reads(t, corpus)
  assert.equal((await reopened.readInsight(query)).samples.length, 1)
  assert.equal(count.streams.length, 0, 'the newly admitted source survives restart')
})

test('a corrupt disposable cache is a miss, not a zero usage result', async (t) => {
  const { ledger, corpus, dir } = await fixture()
  const original = await ledger.readInsight(query)
  ledger.close()
  await writeFile(join(dir, 'insight-cache-v2.sqlite'), 'synthetic corrupt cache')
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  const count = reads(t, corpus)
  const detail = await reopened.readInsight(query)
  assert.deepEqual(detail.samples.map((sample) => sample.key), original.samples.map((sample) => sample.key))
  assert.equal(count.streams.length, 1)
})

test('a damaged but valid cached JSON payload cannot become a zero observation', async (t) => {
  const { ledger, corpus, dir } = await fixture()
  const before = await ledger.readInsight(query); ledger.close()
  const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  const row = cache.prepare('SELECT id, entry FROM generations').get() as { id: string; entry: string }
  const entry = JSON.parse(row.entry); entry.offset = 0
  cache.prepare('UPDATE generations SET entry = ? WHERE id = ?').run(JSON.stringify(entry), row.id)
  cache.close()
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  const count = reads(t, corpus)
  const after = await reopened.readInsight(query)
  assert.deepEqual(after.samples.map((sample) => sample.key), before.samples.map((sample) => sample.key))
  assert.equal(count.streams.length, 1)
})

test('disposable cache files are private even under a permissive process umask', { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, dir } = await fixture(); t.after(() => ledger.close())
  const previous = process.umask(0)
  try { await ledger.readInsight(query) } finally { process.umask(previous) }
  for (const name of ['insight-pass-lock.sqlite', 'insight-cache-v2.sqlite']) {
    assert.equal((await stat(join(dir, name))).mode & 0o077, 0, name)
  }
})

test('the disposable cache supports a concurrent read snapshot while another connection commits', async (t) => {
  const { ledger, dir } = await fixture(); t.after(() => ledger.close())
  await ledger.readInsight(query)
  const reader = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'), { readOnly: true })
  const writer = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
  t.after(() => { reader.close(); writer.close() })
  reader.exec('BEGIN')
  const before = reader.prepare('SELECT entry FROM generations').get() as { entry: string }
  writer.exec("UPDATE generations SET entry = '{}' WHERE id IN (SELECT generation FROM published)")
  const during = reader.prepare('SELECT entry FROM generations').get() as { entry: string }
  assert.equal(during.entry, before.entry, 'the read snapshot stays stable across the external commit')
  reader.exec('ROLLBACK')
})

test('cache WAL sidecars are private under a permissive process umask', { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, dir } = await fixture(); t.after(() => ledger.close())
  const modes = new Map<string, number>()
  const exec = DatabaseSync.prototype.exec
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = join(dir, `insight-cache-v2.sqlite${suffix}`)
        if (fs.existsSync(sidecar)) modes.set(suffix, fs.statSync(sidecar).mode & 0o077)
      }
    }
    return exec.call(this, sql)
  })
  const previous = process.umask(0)
  try { await ledger.readInsight(query) } finally { process.umask(previous) }
  assert.deepEqual([...modes.entries()].sort(), [['-shm', 0], ['-wal', 0]], 'observed SQLite sidecars are private')
})

for (const name of ['insight-pass-lock.sqlite', 'insight-cache-v2.sqlite']) test(`a symlinked ${name} is not opened or modified`, { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, dir } = await fixture(); t.after(() => ledger.close())
  const victim = join(dir, 'other.sqlite'); const db = new DatabaseSync(victim)
  db.exec('CREATE TABLE sentinel (id INTEGER)'); db.close()
  await symlink(victim, join(dir, name))
  const detail = await ledger.readInsight(query)
  assert.equal(detail.samples.length, 1, 'the source reader remains available')
  const check = new DatabaseSync(victim)
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('lease', 'generations')").get(), undefined)
  check.close()
})

for (const suffix of ['-wal', '-shm']) test(`a symlinked cache ${suffix} sidecar cannot modify its target`, { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, corpus, dir } = await fixture()
  await ledger.readInsight(query); ledger.close()
  const victim = join(dir, 'sidecar-victim'); await writeFile(victim, 'synthetic sidecar target')
  await symlink(victim, join(dir, `insight-cache-v2.sqlite${suffix}`))
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  assert.equal((await reopened.readInsight(query)).samples.length, 1)
  assert.equal(await readFile(victim, 'utf8'), 'synthetic sidecar target')
})

test('a hard-linked cache file is not modified', { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, dir } = await fixture(); t.after(() => ledger.close())
  const victim = join(dir, 'other.sqlite'); const db = new DatabaseSync(victim)
  db.exec('CREATE TABLE sentinel (id INTEGER)'); db.close()
  const beforeMode = (await stat(victim)).mode & 0o777
  await link(victim, join(dir, 'insight-cache-v2.sqlite'))
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
  assert.equal((await stat(victim)).mode & 0o777, beforeMode)
  const check = new DatabaseSync(victim)
  assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'generations'").get(), undefined)
  check.close()
})

test('a serialized-record canary is absent from cache artifacts across restart', async (t) => {
  const { ledger, path, corpus, dir } = await fixture()
  const record = JSON.parse(event(0)); const canary = 'synthetic-cache-artifact-canary-1573'; record.synthetic = canary
  await writeFile(path, meta + JSON.stringify(record) + '\n')
  const before = await ledger.readInsight(query); ledger.close()
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  const count = reads(t, corpus)
  const after = await reopened.readInsight(query); reopened.close()
  assert.equal(count.streams.length, 0)
  assert.deepEqual(after.samples.map((sample) => [sample.key, sample.requestId]), before.samples.map((sample) => [sample.key, sample.requestId]))
  const artifacts = (await readdir(dir)).filter((name) => name.startsWith('insight-'))
  assert.ok(artifacts.length > 0)
  for (const name of artifacts) assert.equal((await readFile(join(dir, name))).includes(Buffer.from(canary)), false, name)
})

test('ordinary provider and model strings containing the negative-zero marker survive restart', async (t) => {
  const dir = tempDir('hd-insight-marker-text-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const marker = '__hd_insight_negative_zero__'; const id = `provider-${marker}`; const model = `model-${marker}`
  const record = { type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: query.root,
    message: { id, model, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  await writeFile(join(corpus, 'messages.jsonl'), `${JSON.stringify(record)}\n`)
  const make = () => new Ledger({ stateDir: dir, now: () => 123, corpora: [{ runtime: 'alpha', kind: 'claude', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  const first = make(); const before = await first.readInsight(query); first.close()
  const second = make(); t.after(() => second.close())
  const count = reads(t, corpus); const after = await second.readInsight(query)
  assert.equal(count.streams.length, 0)
  assert.equal(after.samples[0]?.requestId, id)
  assert.equal(after.samples[0]?.model, model)
  assert.deepEqual(after.samples, before.samples)
})

test('a valid negative-zero observation has the same value after index reuse', async (t) => {
  const { ledger, path, corpus, dir } = await fixture()
  const raw = event(0).replace('"input_tokens":10', '"input_tokens":-0')
  await writeFile(path, meta + raw)
  const first = await ledger.readInsight(query)
  assert.ok(Object.is(first.samples[0]!.input.value, -0))
  ledger.close()
  const reopened = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  const after = await reopened.readInsight(query)
  assert.ok(Object.is(after.samples[0]!.input.value, -0), 'cache replay preserves the exact numeric value')
})

test('a cached observation is repriced using the current price overlay', async (t) => {
  const dir = tempDir('hd-insight-reprice-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const path = join(corpus, 'messages.jsonl'); const overlay = join(dir, 'pricing.json')
  const record = { type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: query.root,
    message: { id: 'provider-id', model: 'test-model', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  await writeFile(path, `${JSON.stringify(record)}\n`)
  await writeFile(overlay, JSON.stringify({ 'test-model': { input: 1, output: 1 } }))
  const pricing = new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: overlay, fetchCatalogue: async () => ({}) })
  const ledger = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'claude', root: corpus }], pricing })
  t.after(() => ledger.close())
  const count = reads(t, corpus)
  const first = await ledger.readInsight(query)
  assert.equal(first.samples.length, 1)
  assert.equal(first.samples[0]!.usd.value, 11 / 1_000_000)
  await writeFile(overlay, JSON.stringify({ 'test-model': { input: 2, output: 2 } }))
  await pricing.warm()
  const second = await ledger.readInsight(query)
  assert.equal(second.samples[0]!.usd.value, 22 / 1_000_000)
  assert.equal(count.streams.length, 1, 'repricing does not reread unchanged source bytes')
})

test('indexed project pricing is captured before the post-read callback', async (t) => {
  const dir = tempDir('hd-insight-price-snapshot-'); const corpus = join(dir, 'corpus'); await mkdir(corpus)
  const record = { type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: query.root,
    message: { id: 'provider-id', model: 'test-model', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  await writeFile(join(corpus, 'messages.jsonl'), `${JSON.stringify(record)}\n`)
  const pricing = new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) })
  let rate = 1 / 1_000_000
  t.mock.method(pricing, 'rateObservation', () => ({ rates: { input: rate, output: rate, cacheRead: rate, cacheWrite: rate }, observedAt: null, kind: 'overlay', fingerprint: 'fake' }))
  const ledger = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'claude', root: corpus }], pricing })
  t.after(() => ledger.close())
  const observed = await ledger.withInsightSources(query, 1, (view) => {
    rate = 10 / 1_000_000
    const values: (number | null)[] = []; view.each((one) => values.push(one.usd.value)); return values
  })
  assert.deepEqual(observed, [11 / 1_000_000], 'callback-time price changes do not rewrite the completed source pass')
})

test('a cached project alias is resolved again after a symlink retarget', { skip: process.platform === 'win32' }, async (t) => {
  const { ledger, path, corpus, dir } = await fixture(); t.after(() => ledger.close())
  const one = join(dir, 'one'); const two = join(dir, 'two'); const alias = join(dir, 'alias')
  await mkdir(one); await mkdir(two); await symlink(one, alias)
  const header = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-1', cwd: alias } })}\n`
  await writeFile(path, header + event(0))
  const count = reads(t, corpus)
  assert.equal((await ledger.readInsight({ ...query, root: one })).samples.length, 1)
  await unlink(alias); await symlink(two, alias)
  assert.equal((await ledger.readInsight({ ...query, root: one })).samples.length, 0)
  assert.equal((await ledger.readInsight({ ...query, root: two })).samples.length, 1)
  assert.equal(count.streams.length, 1)
})

test('an aborted source scan is not published as a cached complete observation', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const original = fs.createReadStream; const gate = new PassThrough(); let source: fs.ReadStream | undefined
  let opened!: () => void; const firstOpened = new Promise<void>((resolve) => { opened = resolve })
  t.mock.method(fs, 'createReadStream', ((target: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    const stream = original(target, options)
    if (target === path && !source) { source = stream; opened(); return gate as unknown as fs.ReadStream }
    return stream
  }) as typeof fs.createReadStream)
  const signal = new AbortController()
  const pending = ledger.readInsight(query, { signal: signal.signal })
  await firstOpened; signal.abort(); source!.pipe(gate)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
})

test('a growing transcript parses only appended bytes and retains its session context', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  await ledger.readInsight(query); const size = (await stat(path)).size; const bytes = count.bytes()
  const appended = event(1); await appendFile(path, appended)
  const detail = await ledger.readInsight(query)
  assert.deepEqual(count.starts, [0, size])
  assert.equal(count.bytes() - bytes, Buffer.byteLength(appended))
  assert.equal(detail.samples.length, 2)
  assert.ok(detail.samples.every((sample) => sample.sessionId === 'session-1' && sample.project === query.root))
})

test('a replaced file with the same size and mtime is read again after a cached open', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  await ledger.readInsight(query); await ledger.readInsight(query)
  const before = await stat(path); const replacement = join(corpus, 'replacement')
  await writeFile(replacement, meta + event(2)); await utimes(replacement, before.atime, before.mtime); await rename(replacement, path)
  const detail = await ledger.readInsight(query)
  assert.deepEqual(count.starts, [0, 0])
  assert.equal(detail.samples.length, 1)
  assert.equal(detail.samples[0]?.from, Date.parse('2026-09-20T00:00:02Z'))
})

test('files older than the requested range are skipped before opening a stream', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  await utimes(path, new Date('2026-09-01'), new Date('2026-09-01'))
  const count = reads(t, corpus)
  const detail = await ledger.readInsight(query)
  assert.equal(count.bytes(), 0); assert.equal(count.streams.length, 0)
  assert.equal(detail.samples.length, 0)
})

test('the scan budget truncates, reports Partial, and resumes without parsing the prefix again', async (t) => {
  const limit = Buffer.byteLength(meta + event(0))
  const { ledger, path, corpus } = await fixture(limit); t.after(() => ledger.close())
  await appendFile(path, event(1))
  const count = reads(t, corpus)
  const first = await ledger.readInsight(query)
  assert.ok(count.bytes() <= limit, 'the stream spends at most the request budget')
  assert.equal(first.samples.length, 1)
  assert.ok(first.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  const second = await ledger.readInsight(query)
  assert.deepEqual(count.starts, [0, limit])
  assert.equal(second.samples.length, 2)
  assert.ok(!second.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
})

test('a same-size rewrite or shrink replaces cached samples instead of adding to them', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  await ledger.readInsight(query)
  const original = await stat(path)
  await writeFile(path, meta + event(3))
  await utimes(path, original.atime, new Date(original.mtimeMs + 2000))
  const rewritten = await ledger.readInsight(query)
  assert.equal(rewritten.samples.length, 1)
  assert.equal(rewritten.samples[0]?.from, Date.parse('2026-09-20T00:00:03Z'))
  await writeFile(path, meta)
  assert.equal((await ledger.readInsight(query)).samples.length, 0)
  assert.deepEqual(count.starts, [0, 0, 0])
})

test('a partial trailing record survives an append and is emitted only once', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const extra = event(1); const split = extra.length - 12
  await appendFile(path, extra.slice(0, split))
  assert.equal((await ledger.readInsight(query)).samples.length, 1)
  await appendFile(path, extra.slice(split))
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
  assert.deepEqual(count.starts, [0, Buffer.byteLength(meta + event(0))])
})

test('cache rows are filtered for each range and concurrent opens share one source read', async (t) => {
  const { ledger, corpus } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const [first, second] = await Promise.all([ledger.readInsight(query), ledger.readInsight(query)])
  assert.equal(first.samples.length, 1); assert.equal(second.samples.length, 1)
  assert.equal(count.streams.length, 1)
  const later = await ledger.readInsight({ ...query, from: Date.parse('2026-09-20T01:00:00Z') })
  assert.equal(later.samples.length, 0)
  const other = await ledger.readInsight({ ...query, root: '/work/other' })
  assert.equal(other.samples.length, 0)
  assert.equal(count.streams.length, 1)
})

test('a budget-limited read reaches the Insight response even without known dollar rates', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { ledger, path } = await fixture(Buffer.byteLength(meta + event(0))); t.after(() => ledger.close())
  await appendFile(path, event(1))
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => [] } } as never, seats: () => [], seating: {} as never })
  const partial = await plane.usage(query)
  assert.equal(partial.scan, 'partial')
  assert.equal(partial.totals.turns.coverage, 'partial')
  assert.equal((await plane.usage(query)).scan, 'complete')
})

test('growth between discovery and stream opening still reports a limited response', async (t) => {
  const limit = Buffer.byteLength(meta + event(0))
  const { ledger, path } = await fixture(limit); t.after(() => ledger.close())
  const original = fs.createReadStream
  let grew = false
  t.mock.method(fs, 'createReadStream', ((source: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    if (source === path && !grew) { fs.appendFileSync(path, event(1)); grew = true }
    return original(source, options)
  }) as typeof fs.createReadStream)
  const first = await ledger.readInsight(query)
  assert.ok(first.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  assert.equal((await ledger.readInsight(query)).samples.length, 2)
})

test('large source sample counts survive cold and cached reads within the shared byte budget', async (t) => {
  const dir = tempDir('hd-insight-large-cache-')
  const alpha = join(dir, 'alpha'); const beta = join(dir, 'beta')
  await mkdir(alpha); await mkdir(beta)
  // More observations than V8 accepts as arguments, comfortably below 64 MiB.
  const observations = 150_000
  const content = meta + Array.from({ length: observations }, (_, index) => `${JSON.stringify({
    timestamp: new Date(Date.parse('2026-09-20') + index).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } },
  })}\n`).join('')
  const limit = Buffer.byteLength(content)
  await writeFile(join(alpha, 'rollout.jsonl'), content)
  await writeFile(join(beta, 'rollout.jsonl'), meta + event(1))
  const ledger = new Ledger({ stateDir: dir, insightByteLimit: limit,
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alpha }, { runtime: 'beta', kind: 'codex', root: beta }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => ledger.close())
  const count = reads(t, dir)
  const first = await ledger.readInsight(query)
  assert.equal(count.bytes(), limit, 'the large source spends the budget; the next source is not read')
  assert.equal(first.samples.length, observations)
  assert.ok(first.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  assert.ok(!first.gaps.includes('A recorded usage source could not be read.'))
  const second = await ledger.readInsight(query, { refresh: true })
  assert.equal(second.samples.filter((sample) => sample.runtime === 'alpha').length, observations)
  assert.equal(second.samples.filter((sample) => sample.runtime === 'beta').length, 1)
  assert.equal(count.bytes(), limit + Buffer.byteLength(meta + event(1)), 'the cached large source reads no bytes')
  assert.ok(!second.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  assert.ok(!second.gaps.includes('A recorded usage source could not be read.'))
})

for (const kind of ['claude', 'qwen'] as const) {
  for (const continuation of ['append', 'budget'] as const) {
    test(`${kind} deduplicates older message IDs across ${continuation} scans with first-observation values`, async (t) => {
      const dir = tempDir('hd-insight-dedup-cache-')
      const corpus = join(dir, 'corpus'); const chats = join(corpus, 'project', 'chats')
      await mkdir(chats, { recursive: true })
      const path = join(chats, 'messages.jsonl')
      const record = (id: number, input = 10) => `${JSON.stringify({
        type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: query.root,
        ...(kind === 'claude'
          ? { message: { id: `message-${id}`, model: 'test-model', usage: { input_tokens: input, output_tokens: 1 } } }
          : { uuid: `message-${id}`, model: 'test-model', usageMetadata: { promptTokenCount: input, cachedContentTokenCount: 0, candidatesTokenCount: 1, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0 } }),
      })}\n`
      const prefix = Array.from({ length: 65 }, (_, index) => record(index)).join('')
      const suffix = record(0, 999) + record(65)
      await writeFile(path, prefix + (continuation === 'budget' ? suffix : ''))
      const options = { stateDir: dir, corpora: [{ runtime: 'alpha', kind, root: corpus }],
        pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) }
      const ledger = new Ledger({ ...options, ...(continuation === 'budget' ? { insightByteLimit: Buffer.byteLength(prefix) } : {}) })
      t.after(() => ledger.close())
      const count = reads(t, corpus)
      const first = await ledger.readInsight(query)
      assert.equal(first.samples.length, 65)
      if (continuation === 'append') await appendFile(path, suffix)
      const continued = await ledger.readInsight(query, { refresh: true })
      assert.deepEqual(count.starts, [0, Buffer.byteLength(prefix)])
      assert.equal(count.bytes(), Buffer.byteLength(prefix + suffix))
      assert.equal(continued.samples.length, 66, 'only the new message adds an observation')
      assert.equal(continued.samples.find((sample) => sample.requestId === 'message-0')?.input.value, 10)
      assert.equal(continued.samples.reduce((sum, sample) => sum + (sample.input.value ?? 0), 0), 660)
      const fresh = new Ledger(options); t.after(() => fresh.close())
      const full = await fresh.readInsight(query)
      const values = (detail: typeof full) => detail.samples.map((sample) => [sample.key, sample.input, sample.output, sample.usd])
      assert.deepEqual(values(continued), values(full), 'continuation agrees with a full-file scan')
      const cached = await ledger.readInsight(query)
      assert.deepEqual(values(cached), values(continued))
      await writeFile(path, record(0, 7))
      const rewritten = await ledger.readInsight(query)
      assert.equal(rewritten.samples.length, 1)
      assert.equal(rewritten.samples[0]?.input.value, 7, 'rewrites discard source-wide seen observations')
    })
  }
}

test('a read resolves each folder once, however many samples name it', async (t) => {
  const { ledger, path } = await fixture(); t.after(() => ledger.close())
  const other = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-2', cwd: '/work/other' } })}\n`
  await writeFile(`${path}.other.jsonl`, other + Array.from({ length: 200 }, (_, second) => event(second % 60)).join(''))
  const native = fs.realpathSync.native
  let resolved = 0
  t.mock.method(fs.realpathSync, 'native', ((target: fs.PathLike, options?: fs.EncodingOption) => { resolved += 1; return native(target, options) }) as typeof native)
  const detail = await ledger.readInsight(query)
  assert.equal(detail.samples.length, 1)
  assert.ok(resolved <= 10, `${resolved} folder resolutions for 201 samples`)
})

test('roots read together share one pass over the usage sources, and each reads as it does alone', async (t) => {
  const { ledger, path, corpus } = await fixture(); t.after(() => ledger.close())
  const other = `${JSON.stringify({ type: 'session_meta', payload: { id: 'session-2', cwd: '/work/other' } })}\n`
  await writeFile(`${path}.other.jsonl`, other + event(1) + event(2))
  const listed: string[] = []
  const readdir = fs.promises.readdir
  t.mock.method(fs.promises, 'readdir', ((target: fs.PathLike, ...rest: unknown[]) => {
    if (String(target).startsWith(corpus)) listed.push(String(target))
    return (readdir as (...args: unknown[]) => unknown)(target, ...rest)
  }) as typeof readdir)
  const queries = [query, { ...query, root: '/work/other' }, { ...query, root: '/work/nothing-here' }]
  const shape = (detail: Awaited<ReturnType<Ledger['readInsight']>>) =>
    ({ samples: detail.samples.map((sample) => [sample.key, sample.project, sample.input.value]), gaps: detail.gaps, complete: detail.complete })

  const alone = []
  for (const one of queries) alone.push(shape(await ledger.readInsight(one)))
  const onePass = listed.length / queries.length
  assert.ok(onePass >= 1, 'a read lists the usage sources')
  listed.length = 0
  const together = (await ledger.readInsights(queries)).map(shape)
  assert.deepEqual(together, alone)
  assert.deepEqual(together.map((detail) => detail.samples.length), [1, 2, 0])
  assert.equal(listed.length, onePass, 'three roots over one range list the sources once')

  listed.length = 0
  await ledger.readInsights([query, { ...query, from: query.from + 1 }])
  assert.equal(listed.length, 2 * onePass, 'a different range is a pass of its own')
})

test('a pass for several reads carries each read’s byte budget, so none stops where reading alone would not', async (t) => {
  const rollout = (cwd: string, id: string) =>
    `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n${Array.from({ length: 40 }, (_, second) => event(second)).join('')}`
  const roots = [query.root, '/work/other', '/work/third']
  const size = Buffer.byteLength(rollout(query.root, 'session-0'))
  const desk = async () => {
    const made = await fixture(Math.floor(size * 1.5)); t.after(() => made.ledger.close())
    for (const [index, root] of roots.entries()) await writeFile(index === 0 ? made.path : `${made.path}.${index}.jsonl`, rollout(root, `session-${index}`))
    return made.ledger
  }
  const capped = (detail: Awaited<ReturnType<Ledger['readInsight']>>) => detail.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE)

  assert.ok(capped(await (await desk()).readInsight(query)), 'one root alone stops at its budget on a desk with more sources than that')
  const together = await (await desk()).readInsights(roots.map((root) => ({ ...query, root })))
  assert.deepEqual(together.map(capped), [false, false, false], 'three roots carry three budgets')
  assert.deepEqual(together.map((detail) => detail.samples.length), [40, 40, 40])
  // Teams that reuse a clone folder ask for the same root: each still brings its read's budget.
  const repeated = await (await desk()).readInsights([query, query, query])
  assert.deepEqual(repeated.map(capped), [false, false, false], 'three reads of one root carry three budgets')
  assert.equal(repeated[1], repeated[0], 'and are answered once')
})

test('indexed Goal source timestamps are frozen at validation before the Seat snapshot', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { ledger: original, corpus, dir } = await fixture(); original.close()
  let clock = Date.parse('2026-09-21T00:00:00Z'); let seatSnapshot = 0
  const now = () => clock++
  const ledger = new Ledger({ stateDir: dir, now, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => ledger.close())
  const doc = { goal: { id: 'goal-a', root: query.root, sentence: 'Team', state: 'open' } }
  const seat = { id: 'seat-a', board: 'goal-a', agent: null, briefDigest: 'same', seat: { runtime: 'alpha' }, seatLabel: 'Seat',
    checkout: { project: query.root }, session: { runtime: 'alpha', sessionId: 'session-1' }, openedAt: 0, closed: null, restored: null }
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => [doc], read: () => doc } } as never,
    seats: () => { seatSnapshot = clock; return [seat] as never }, seating: {} as never, now })
  const report = await plane.goal('goal-a')
  assert.equal(report.sources.length, 1)
  assert.ok(report.sources[0]!.checkedAt < seatSnapshot, 'validation time precedes the Seat snapshot')
})

test('a streamed Goal preserves repeated discovery of the same source', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { ledger: first, corpus, dir } = await fixture(); first.close()
  const target = { runtime: 'alpha', kind: 'codex' as const, root: corpus }
  const ledger = new Ledger({ stateDir: dir, corpora: [target, target],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => ledger.close())
  assert.equal((await ledger.readInsight(query)).samples.length, 2, 'legacy detail retains both discovery positions')
  const doc = { goal: { id: 'goal-a', root: query.root, sentence: 'Team', state: 'open' } }
  const seat = { id: 'seat-a', board: 'goal-a', agent: null, briefDigest: 'same', seat: { runtime: 'alpha' }, seatLabel: 'Seat',
    checkout: { project: query.root }, session: { runtime: 'alpha', sessionId: 'session-1' }, openedAt: 0, closed: null, restored: null }
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => [doc], read: () => doc } } as never,
    seats: () => [seat] as never, seating: {} as never, now: () => Date.parse('2026-09-21T00:00:00Z') })
  assert.equal((await plane.goal('goal-a')).totals.turns.value, 2, 'streaming authenticates once and expands both references')
})

test('a streamed Goal attributes against Seats after its source read completes', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { ledger, path } = await fixture(); t.after(() => ledger.close())
  const doc = { goal: { id: 'goal-a', root: query.root, sentence: 'Team', state: 'open' } }
  const seat = { id: 'seat-a', board: 'goal-a', agent: null, briefDigest: 'same', seat: { runtime: 'alpha' }, seatLabel: 'Seat',
    checkout: { project: query.root }, session: { runtime: 'alpha', sessionId: 'session-1' }, openedAt: 0, closed: null, restored: null }
  let seats: readonly typeof seat[] = []
  const original = fs.createReadStream; const gate = new PassThrough(); let source: fs.ReadStream | undefined
  let opened!: () => void; const firstOpened = new Promise<void>((resolve) => { opened = resolve })
  t.mock.method(fs, 'createReadStream', ((target: Parameters<typeof fs.createReadStream>[0], options?: { start?: number }) => {
    const stream = original(target, options)
    if (target === path && !source) { source = stream; opened(); return gate as unknown as fs.ReadStream }
    return stream
  }) as typeof fs.createReadStream)
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => [doc], read: () => doc } } as never,
    seats: () => seats as never, seating: {} as never, now: () => Date.parse('2026-09-21T00:00:00Z') })
  const pending = plane.goal('goal-a')
  await firstOpened
  seats = [seat]
  source!.pipe(gate)
  assert.equal((await pending).totals.turns.value, 1, 'the Seat registered during the read owns its observation')
})

test('a budget-exhausted streamed Goal keeps a grown source’s previously indexed prefix', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const dir = tempDir('hd-insight-grown-budget-'); const alpha = join(dir, 'alpha'); const beta = join(dir, 'beta')
  await mkdir(alpha); await mkdir(beta)
  const prefix = meta + event(0); await writeFile(join(alpha, 'a.jsonl'), prefix); await writeFile(join(beta, 'b.jsonl'), prefix)
  const make = (stateDir: string) => new Ledger({ stateDir, insightByteLimit: Buffer.byteLength(prefix),
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alpha }, { runtime: 'beta', kind: 'codex', root: beta }],
    pricing: new Pricing({ cachePath: join(stateDir, 'rates.json'), overlayPath: join(stateDir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  const old = make(join(dir, 'old')); const next = make(join(dir, 'next'))
  t.after(() => { old.close(); next.close() })
  assert.equal((await old.readInsight({ ...query, runtime: 'beta' })).samples.length, 1)
  assert.equal((await next.readInsight({ ...query, runtime: 'beta' })).samples.length, 1)
  await appendFile(join(beta, 'b.jsonl'), event(1))
  const before = await old.readInsight(query)
  assert.equal(before.samples.length, 2)
  assert.ok(before.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
  const doc = { goal: { id: 'goal-a', root: query.root, sentence: 'Team', state: 'open' } }
  const seats = ['alpha', 'beta'].map((runtime) => ({ id: `seat-${runtime}`, board: 'goal-a', agent: null, briefDigest: 'same',
    seat: { runtime }, seatLabel: runtime, checkout: { project: query.root }, session: { runtime, sessionId: 'session-1' }, openedAt: 0, closed: null, restored: null }))
  const plane = new InsightPlane({ ledger: () => next, goals: { store: { list: () => [doc], read: () => doc } } as never,
    seats: () => seats as never, seating: {} as never, now: () => Date.parse('2026-09-21T00:00:00Z') })
  const report = await plane.goal('goal-a')
  assert.equal(report.totals.turns.value, 2)
  assert.ok(report.gaps.includes(INSIGHT_BYTE_LIMIT_MESSAGE))
})

test('a streamed Goal prefers a newer indexed generation over an older in-memory prefix', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { PersistentInsight } = await import('../src/ledger/insight-persistent.js')
  const dir = tempDir('hd-insight-generation-choice-'); const alpha = join(dir, 'alpha'); const beta = join(dir, 'beta')
  await mkdir(alpha); await mkdir(beta)
  const prefix = meta + event(0); await writeFile(join(alpha, 'a.jsonl'), prefix); await writeFile(join(beta, 'b.jsonl'), prefix)
  const make = () => new Ledger({ stateDir: dir, insightByteLimit: Buffer.byteLength(prefix),
    corpora: [{ runtime: 'alpha', kind: 'codex', root: alpha }, { runtime: 'beta', kind: 'codex', root: beta }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  const first = make(); const second = make(); t.after(() => { first.close(); second.close() })
  const failure = t.mock.method(PersistentInsight.prototype, 'put', () => false)
  assert.equal((await first.readInsight({ ...query, runtime: 'beta' })).samples.length, 1)
  failure.mock.restore()
  await appendFile(join(beta, 'b.jsonl'), event(1) + event(2))
  assert.equal((await second.readInsight({ ...query, runtime: 'beta' })).samples.length, 1, 'the partial newer generation is available')
  // Resume once: the newer still-limited prefix now contains two observations.
  assert.equal((await second.readInsight({ ...query, runtime: 'beta' })).samples.length, 2)
  const doc = { goal: { id: 'goal-a', root: query.root, sentence: 'Team', state: 'open' } }
  const seats = ['alpha', 'beta'].map((runtime) => ({ id: `seat-${runtime}`, board: 'goal-a', agent: null, briefDigest: 'same',
    seat: { runtime }, seatLabel: runtime, checkout: { project: query.root }, session: { runtime, sessionId: 'session-1' }, openedAt: 0, closed: null, restored: null }))
  const plane = new InsightPlane({ ledger: () => first, goals: { store: { list: () => [doc], read: () => doc } } as never,
    seats: () => seats as never, seating: {} as never, now: () => Date.parse('2026-09-21T00:00:00Z') })
  const report = await plane.goal('goal-a')
  assert.equal(report.totals.turns.value, 3, 'the current disk generation wins over a stale memory prefix')
})

test('a damaged prior index after a partial append fails instead of returning an empty partial result', async (t) => {
  const { PersistentInsight } = await import('../src/ledger/insight-persistent.js')
  const { ledger, path, corpus, dir } = await fixture()
  await ledger.readInsight(query); ledger.close()
  const prefix = (await stat(path)).size
  await appendFile(path, event(1) + event(2))
  const reopened = new Ledger({ stateDir: dir, insightByteLimit: Buffer.byteLength(event(1)),
    corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => reopened.close())
  t.mock.method(PersistentInsight.prototype, 'put', () => {
    const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
    cache.exec("UPDATE generations SET entry = '{}'")
    cache.close()
    return false
  })
  const count = reads(t, corpus)
  await assert.rejects(reopened.withInsightSources(query, 1, (view) => { let found = 0; view.each(() => { found++ }); return found }),
    /Recorded usage cache is temporarily unavailable/)
  assert.deepEqual(count.starts, [prefix])
})

for (const batch of [false, true]) test(`post-read cache damage makes ${batch ? 'batched Goals fail' : 'a Goal reject'} without rereading`, async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { ledger, corpus, dir } = await fixture(); t.after(() => ledger.close())
  const count = reads(t, corpus)
  const now = Date.parse('2026-09-21T00:00:00Z')
  const doc = { goal: { id: 'goal-a', root: query.root, sentence: 'Team', state: 'open' } }
  let damaged = false
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => [doc], read: () => doc } } as never,
    seats: () => {
      if (!damaged) {
        damaged = true
        const cache = new DatabaseSync(join(dir, 'insight-cache-v2.sqlite'))
        cache.exec("UPDATE generations SET entry = '{}'")
        cache.close()
      }
      return []
    }, seating: {} as never, now: () => now })
  if (batch) {
    const result = await plane.goals(['goal-a'])
    assert.deepEqual(result.reports, [])
    assert.deepEqual(result.failed, ['goal-a'])
  } else await assert.rejects(plane.goal('goal-a'), /Recorded usage cache is temporarily unavailable/)
  assert.equal(count.streams.length, 1, 'the request does not reset its source-byte budget')
})

test('provider dedupe survives a restart and append', async (t) => {
  const dir = tempDir('hd-insight-provider-restart-'); const corpus = join(dir, 'corpus')
  await mkdir(corpus)
  const path = join(corpus, 'messages.jsonl'); const privateId = 'synthetic-provider-dedupe-identity'
  const record = (id: string, input: number) => `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-20T00:00:00.000Z', cwd: query.root,
    message: { id, model: 'test-model', usage: { input_tokens: input, output_tokens: 1 } } })}\n`
  const initial = record(privateId, 10); await writeFile(path, initial)
  const options = { stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'claude' as const, root: corpus }],
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) }
  const first = new Ledger(options); assert.equal((await first.readInsight(query)).samples.length, 1); first.close()
  const second = new Ledger(options); t.after(() => second.close())
  const count = reads(t, corpus)
  await appendFile(path, record(privateId, 999) + record('new-message', 20))
  const detail = await second.readInsight(query)
  assert.deepEqual(count.starts, [Buffer.byteLength(initial)])
  assert.deepEqual(detail.samples.map((sample) => sample.input.value), [10, 20])
})

test('a Team read does not materialize cached observations from unrelated projects', async (t) => {
  const { InsightPlane } = await import('../src/insight/plane.js')
  const { InsightCache } = await import('../src/ledger/insight-cache.js')
  const dir = tempDir('hd-insight-team-cache-'); const corpus = join(dir, 'corpus')
  await mkdir(corpus)
  const root = '/work/project-0'; const now = Date.parse('2026-09-21T00:00:00Z')
  for (let project = 0; project < 3; project++) for (let n = 0; n < 2; n++) {
    const session = `fixture-${project}-${n}`
    const header = `${JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: `/work/project-${project}` } })}\n`
    await writeFile(join(corpus, `rollout-${project}-${n}.jsonl`), header + event(0) + event(1))
  }
  const ledger = new Ledger({ stateDir: dir, corpora: [{ runtime: 'alpha', kind: 'codex', root: corpus }], now: () => now,
    pricing: new Pricing({ cachePath: join(dir, 'rates.json'), overlayPath: join(dir, 'pricing.json'), fetchCatalogue: async () => ({}) }) })
  t.after(() => ledger.close())
  const docs = [{ goal: { id: 'goal-a', root, sentence: 'Synthetic Team', state: 'open' } }]
  const seats = Array.from({ length: 2 }, (_, n) => ({ id: `seat-${n}`, agent: { id: 'agent', name: 'Agent', origin: 'project' }, briefDigest: 'same',
    seat: { runtime: 'alpha' }, seatLabel: `Seat ${n}`, checkout: { project: root }, board: 'goal-a',
    session: { runtime: 'alpha', sessionId: `fixture-0-${n}` }, openedAt: 0, closed: null, restored: null }))
  const plane = new InsightPlane({ ledger: () => ledger, goals: { store: { list: () => docs, read: () => docs[0] } } as never,
    seats: () => seats as never, seating: {} as never, now: () => now })
  const first = await plane.goal('goal-a')
  assert.equal(first.totals.turns.value, 4)
  let unrelated = 0; let calls = 0
  const read = InsightCache.prototype.read
  t.mock.method(InsightCache.prototype, 'read', async function (this: InstanceType<typeof InsightCache>, ...args: Parameters<typeof read>) {
    const result = await read.apply(this, args)
    calls++
    unrelated += result.samples.filter((sample) => sample.project !== root).length
    return result
  })
  const warm = await plane.goal('goal-a')
  assert.equal(warm.totals.turns.value, 4)
  assert.equal(calls, 6, 'the probe observed each source in the Team pass')
  assert.equal(unrelated, 0, 'warm Team pass does not construct unrelated samples')
})
