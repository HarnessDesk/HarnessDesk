import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import type { RuntimeId, SessionId, SessionSummary } from '@harnessdesk/protocol'

import { SessionIndex } from '../src/session-index.js'

const runtime = 'fake' as RuntimeId
const idOf = (id: string): SessionId => id as SessionId
const row = (id: string, updatedAt = 10, cwd = '/demo/project'): SessionSummary => ({
  runtime, id: idOf(id), title: `Conversation ${id}`, preview: 'Opening words', cwd,
  status: { type: 'notLoaded' }, createdAt: 1, updatedAt,
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('first page of 5,000 rows across 450 folders is an indexed query under 50 ms', () => {
  const index = new SessionIndex(':memory:')
  try {
    for (let i = 0; i < 5_000; i++) index.upsert(row(`session-${i}`, i, `/demo/project-${i % 450}`))
    const start = performance.now()
    const page = index.list()
    const elapsed = performance.now() - start
    console.log(`SessionIndex first page: ${elapsed.toFixed(2)} ms; 5,000 rows / 450 folders; ${page.data.length} rows`)
    assert.equal(page.data.length, 50)
    assert.equal(page.data[0]?.id, 'session-4999')
    assert.ok(elapsed < 50, `first page took ${elapsed.toFixed(2)} ms`)
    assert.ok(page.nextCursor)
  } finally { index.close() }
})

test('keyset pages tied timestamps without duplicates and filters imported, Team, removed and archive rows', () => {
  const index = new SessionIndex(':memory:')
  try {
    for (const id of ['c', 'a', 'b']) index.upsert(row(id))
    index.upsert({ ...row('a'), runtime: 'other' as RuntimeId })
    index.upsert(row('imported'), { origin: 'imported' })
    index.upsert(row('team'), { teamId: 'team-one' })
    index.upsert(row('archived'), { archived: true })
    index.upsert(row('removed'))
    index.remove(runtime, idOf('removed'))
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = index.list({ pageSize: 2, ...(cursor ? { cursor } : {}) })
      keys.push(...page.data.map((item) => `${item.runtime}:${item.id}`))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.deepEqual(keys, ['fake:a', 'fake:b', 'fake:c', 'other:a'])
    assert.deepEqual(index.list({ archived: 'only' }).data.map((item) => item.id), ['archived'])
    assert.throws(() => index.list({ cursor: 'broken' }), /cursor/i)
  } finally { index.close() }
})

test('writes preserve archive and Team membership and coalesce change events', async () => {
  const changes: { upserted: readonly SessionSummary[]; removed: readonly { runtime: RuntimeId; id: SessionId }[] }[] = []
  const index = new SessionIndex(':memory:', (change) => changes.push(change))
  try {
    index.upsert(row('one'))
    index.upsert(row('one', 20))
    index.setTitle(runtime, idOf('one'), 'New name')
    await tick()
    assert.equal(changes.length, 1)
    assert.equal(changes[0]?.upserted.length, 1)
    assert.equal(changes[0]?.upserted[0]?.title, 'New name')
    index.setArchived(runtime, idOf('one'), true)
    index.upsert(row('one', 30))
    assert.equal(index.list().data.length, 0)
    assert.equal(index.list({ archived: 'only' }).data[0]?.archived, true)
    index.setArchived(runtime, idOf('one'), false)
    index.setTeam(runtime, idOf('one'), 'team-one')
    index.upsert(row('one', 40))
    assert.equal(index.list().data.length, 0)
    index.setTeam(runtime, idOf('one'), null)
    assert.equal(index.list().data.length, 1)
    await tick()
    assert.equal(changes.at(-1)?.upserted[0]?.updatedAt, 40)
    index.remove(runtime, idOf('one'))
    await tick()
    assert.deepEqual(changes.at(-1)?.removed, [{ runtime, id: 'one' }])
    index.setTitle(runtime, idOf('one'), 'Do not revive')
    assert.equal(index.list().data.length, 0)
  } finally { index.close() }
})

test('older metadata observations preserve last activity for sessions and retained worktree owners', () => {
  const index = new SessionIndex(':memory:')
  const id = idOf('active-owner'), path = '/demo/worktrees/task'
  try {
    index.upsert(row(id, 40, path))
    index.rememberWorktree({ runtime, id, path, root: '/demo', branch: 'task', state: 'present' })
    index.upsert({ ...row(id, 0, path), preview: 'Refreshed metadata' })
    assert.equal(index.get(runtime, id)?.updatedAt, 40)
    assert.equal(index.get(runtime, id)?.preview, 'Refreshed metadata')
    assert.equal(index.storageWorktrees()[0]?.updatedAt, 40)
    assert.equal(index.storageOwners(path)[0]?.updatedAt, 40)
    index.upsert(row(id, 70, path))
    assert.equal(index.get(runtime, id)?.updatedAt, 70, 'new activity still advances the age')
    assert.equal(index.storageWorktrees()[0]?.updatedAt, 70)
    index.remove(runtime, id)
    assert.equal(index.storageWorktrees()[0]?.updatedAt, 70, 'removed owners retain their last activity')
  } finally { index.close() }
})

test('renames survive imported pages and ordinary metadata refreshes without changing origin', async t => {
  for (const initial of ['unseen', 'imported', 'desk'] as const) await t.test(initial, () => {
    const index = new SessionIndex(':memory:')
    const id = idOf('renamed')
    const title = 'Review the startup policy'
    try {
      if (initial !== 'unseen') index.upsert(row(id), { origin: initial })
      index.setTitle(runtime, id, title)
      index.importPage([row(id, 20)], () => false)
      const list = () => initial === 'desk' ? index.list() : index.history()
      assert.equal(list().data[0]?.title, title, 'the imported title cannot replace the rename')
      index.importPage([{ ...row(id, 30), title: null }], () => false)
      assert.equal(list().data[0]?.title, title, 'a listing without a title keeps the rename')
      index.upsert(row(id, 40), { origin: 'imported' })
      assert.equal(list().data[0]?.title, title, 'an ordinary write cannot replace the rename')
      index.setTitle(runtime, id, 'A later choice')
      index.upsert(row(id, 50), { origin: 'imported' })
      assert.equal(list().data[0]?.title, 'A later choice', 'an explicit later rename still wins')
      assert.equal(list().data[0]?.updatedAt, 50, 'other metadata still refreshes')
      assert.equal(index.isImported(runtime, id), initial !== 'desk')
    } finally { index.close() }
  })
})

test('repository answers persist, enrich rows and notify only eligible rows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-index-'))
  const file = join(home, 'sessions.sqlite')
  const changes: SessionSummary[][] = []
  const index = new SessionIndex(file, ({ upserted }) => changes.push([...upserted]))
  const repo = { root: '/demo', worktree: true, origin: 'example.com/acme/project' }
  try {
    index.upsert(row('one'))
    index.upsert(row('team'), { teamId: 'team-one' })
    await tick()
    assert.equal(index.repo('/demo/project'), null)
    index.putRepo('/demo/project', { repo, exists: false, checkedAt: 123 })
    await tick()
    assert.equal(changes.at(-1)?.length, 1)
    assert.deepEqual(index.list().data[0]?.repo, repo)
    assert.equal(index.list().data[0]?.folderGone, true)
    const count = changes.length
    index.putRepo('/demo/project', { repo, exists: false, checkedAt: 124 })
    await tick()
    assert.equal(changes.length, count, 'a cache timestamp refresh changes no summary')
  } finally { index.close() }
  const reopened = new SessionIndex(file)
  try {
    assert.deepEqual(reopened.repo('/demo/project'), { repo, exists: false, checkedAt: 124 })
    assert.deepEqual(reopened.list().data[0]?.repo, repo)
  } finally { reopened.close() }
  const db = new DatabaseSync(file)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 7)
    assert.equal(db.prepare('SELECT repo_root FROM sessions WHERE id = ?').get('one')?.repo_root, '/demo')
  } finally { db.close() }
})

test('upgrade is asynchronous, batched, once-only and leaves large transcript files unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-seed-'))
  const folder = join(home, 'transcripts', runtime)
  await mkdir(folder, { recursive: true })
  const files = new Map<string, string>()
  for (let i = 0; i < 65; i++) {
    const body = JSON.stringify({ version: 1, runtime, id: `seed-${i}`, savedAt: i,
      turns: [{ items: [{ text: i === 5 ? 'x'.repeat(2_000_000) : 'hello', title: 'Nested title', cwd: '/wrong' }] }],
      title: `Seed ${i}`, preview: 'Opening words', cwd: '/demo/project', updatedAt: i + 10 })
    const file = join(folder, `seed-${i}.json`)
    files.set(file, body)
    await writeFile(file, body)
  }
  const archive = JSON.stringify({ version: 1, entries: [{ runtime, sessionId: 'seed-2', archivedAt: 20 }] })
  await writeFile(join(home, 'archive.json'), archive)
  const batches: number[] = []
  const index = new SessionIndex(join(home, 'sessions.sqlite'), ({ upserted }) => batches.push(upserted.length))
  try {
    let finished = false
    const seeding = index.seed(home, { teamOf: (_, id) => id === 'seed-3' ? 'team-one' : null,
      titleOf: (_, id) => id === 'seed-4' ? 'Person chose this' : null }).then(() => { finished = true })
    assert.equal(index.list().data.length, 0)
    assert.equal(finished, false)
    // Live updates and deletions win over an in-flight upgrade.
    index.upsert(row('seed-0', 1_000))
    index.remove(runtime, idOf('seed-1'))
    await seeding
    await tick()
    assert.equal(index.list({ pageSize: 100 }).data.length, 62)
    assert.deepEqual(index.list({ archived: 'only' }).data.map((item) => item.id), ['seed-2'])
    assert.equal(index.list().data[0]?.title, 'Conversation seed-0')
    assert.equal(index.list({ pageSize: 100 }).data.find((item) => item.id === 'seed-4')?.title, 'Person chose this')
    const large = index.list({ pageSize: 100 }).data.find((item) => item.id === 'seed-5')
    assert.equal(large?.title, 'Seed 5')
    assert.equal(large?.cwd, '/demo/project')
    assert.ok(batches.length > 1)
    for (const [file, body] of files) assert.equal(await readFile(file, 'utf8'), body)
    assert.equal(await readFile(join(home, 'archive.json'), 'utf8'), archive)
    index.remove(runtime, idOf('seed-4'))
    await index.seed(home)
    assert.equal(index.list({ pageSize: 100 }).data.length, 61)
  } finally { index.close() }
  const reopened = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    await reopened.seed(home)
    assert.equal(reopened.list({ pageSize: 100 }).data.length, 61)
  } finally { reopened.close() }
})

test('seed reads root metadata around oversized turns, handles escapes and validates malformed fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-metadata-'))
  const folder = join(home, 'transcripts', runtime)
  await mkdir(folder, { recursive: true })
  const title = 'A \\"quoted\\" title { with braces } and \\ slashes'
  await writeFile(join(folder, 'header.json'), JSON.stringify({ version: 1, runtime, id: 'header', savedAt: 7,
    title, cwd: '/demo/header', turns: [{ text: 'x'.repeat(150_000), title: 'Do not use nested', cwd: '/wrong' }] }))
  await writeFile(join(folder, 'tail.json'), JSON.stringify({ version: 1, runtime, id: 'tail', savedAt: 8,
    turns: [{ text: 'x'.repeat(150_000), title: 'Do not use nested', cwd: '/wrong' }], title, cwd: '/demo/tail' }))
  await writeFile(join(folder, 'old.json'), JSON.stringify({ version: 1, runtime, id: 'old', savedAt: 9,
    turns: [{ title: 'Nested old title', cwd: '/wrong' }] }))
  await writeFile(join(folder, 'invalid-fields.json'), JSON.stringify({ version: 1, runtime, id: 'invalid-fields', savedAt: 10,
    title: 4, preview: {}, cwd: false, updatedAt: 'bad', turns: [] }))
  await writeFile(join(folder, 'mismatch.json'), JSON.stringify({ version: 1, runtime: 'other', id: 'mismatch', savedAt: 10, turns: [] }))
  await writeFile(join(folder, 'future.json'), JSON.stringify({ version: 2, runtime, id: 'future', savedAt: 10, turns: [] }))
  const index = new SessionIndex(':memory:')
  try {
    await index.seed(home)
    const rows = index.list().data
    assert.equal(rows.length, 4)
    assert.deepEqual(rows.filter((item) => item.id === 'header' || item.id === 'tail').map((item) => item.title), [title, title])
    assert.equal(rows.find((item) => item.id === 'header')?.cwd, '/demo/header')
    assert.equal(rows.find((item) => item.id === 'tail')?.cwd, '/demo/tail')
    assert.equal(rows.find((item) => item.id === 'old')?.title, null)
    assert.equal(rows.find((item) => item.id === 'old')?.cwd, '')
    assert.equal(rows.find((item) => item.id === 'invalid-fields')?.updatedAt, 10)
  } finally { index.close() }
})

test('title, archive and Team changes before seed reaches a transcript survive the upgrade and restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-pending-'))
  const folder = join(home, 'transcripts', runtime)
  await mkdir(folder, { recursive: true })
  for (const id of ['renamed', 'archived', 'team', 'live']) await writeFile(join(folder, `${id}.json`),
    JSON.stringify({ version: 1, runtime, id, savedAt: 10, turns: [], title: 'Old title', cwd: '/demo/project' }))
  const file = join(home, 'sessions.sqlite')
  const first = new SessionIndex(file)
  first.setTitle(runtime, idOf('renamed'), 'Person renamed this')
  first.setArchived(runtime, idOf('archived'), true)
  first.setTeam(runtime, idOf('team'), 'team-one')
  first.setTitle(runtime, idOf('live'), 'Latest title')
  first.setArchived(runtime, idOf('live'), true)
  first.close()
  const index = new SessionIndex(file)
  try {
    index.upsert(row('live'))
    await index.seed(home)
    assert.deepEqual(index.list().data.map((item) => item.id), ['renamed'])
    assert.equal(index.list().data[0]?.title, 'Person renamed this')
    assert.deepEqual(index.list({ archived: 'only' }).data.map((item) => item.id), ['archived', 'live'])
    assert.equal(index.list({ archived: 'only' }).data.find((item) => item.id === 'live')?.title, 'Latest title')
  } finally { index.close() }
})


test('seed retains metadata between oversized turns and trailing insight', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-insight-'))
  const folder = join(home, 'transcripts', runtime)
  await mkdir(folder, { recursive: true })
  const body = JSON.stringify({ version: 1, runtime, id: 'insight', savedAt: 7,
    turns: [{ items: [{ text: 'x'.repeat(150_000), title: 'Nested title' }] }],
    title: 'Review \"quoted\" retries', cwd: '/demo/retries', createdAt: 2, updatedAt: 20,
    insight: [{ text: 'y'.repeat(150_000), cwd: '/wrong' }] })
  const file = join(folder, 'insight.json')
  await writeFile(file, body)
  const index = new SessionIndex(':memory:')
  try {
    await index.seed(home)
    const summary = index.list().data[0]!
    assert.equal(summary.title, 'Review \"quoted\" retries')
    assert.equal(summary.cwd, '/demo/retries')
    assert.equal(summary.createdAt, 2)
    assert.equal(summary.updatedAt, 20)
    assert.equal(await readFile(file, 'utf8'), body)
  } finally { index.close() }
})

test('runtime-scoped pages find older matches and exclude removed registrations', () => {
  const index = new SessionIndex(':memory:')
  try {
    for (let i = 0; i < 60; i++) index.upsert({ ...row(`other-${i}`, 100-i), runtime: 'other' as RuntimeId })
    index.upsert(row('match', 1))
    assert.deepEqual(index.list({ runtimes: [runtime] }).data.map(one => one.id), ['match'])
    assert.deepEqual(index.list({ runtimes: [] }).data, [])
  } finally { index.close() }
})

test('native and unknown archive seeds stay withheld until an indexed id is confirmed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-session-native-'))
  for (const agent of ['native', 'local', 'unknown']) {
    const folder = join(home, 'transcripts', agent)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'seed.json'), JSON.stringify({ version: 1, runtime: agent, id: 'seed',
      savedAt: 10, title: 'Synthetic seed', cwd: '/demo', turns: [] }))
  }
  const index = new SessionIndex(join(home, 'sessions.sqlite'))
  try {
    await index.seed(home, { archiveCapability: (id: RuntimeId) => id === 'native' ? true : id === 'local' ? false : undefined } as never)
    assert.deepEqual(index.list().data.map(row => row.runtime), ['local'])
    assert.deepEqual(index.list({ archived: 'only' }).data, [])
    index.confirmArchived('native' as RuntimeId, idOf('unindexed'), false)
    index.confirmArchived('native' as RuntimeId, idOf('seed'), true)
    assert.deepEqual(index.list({ archived: 'only' }).data.map(row => row.runtime), ['native'])
    assert.deepEqual(index.unresolvedArchive('unknown' as RuntimeId), ['seed'])
  } finally { index.close() }
})

test('schema v1 upgrade retains row state, tombstones, repo answers and seed completion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hd-index-v1-'))
  const file = join(home, 'sessions.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE sessions(runtime TEXT, id TEXT, origin TEXT, title TEXT, preview TEXT, cwd TEXT, repo_root TEXT,
    created_at REAL, updated_at REAL, archived INTEGER NOT NULL DEFAULT 0, removed_at REAL, team_id TEXT, status TEXT, git TEXT, PRIMARY KEY(runtime,id));
    CREATE INDEX sessions_sidebar ON sessions(origin); CREATE INDEX sessions_page ON sessions(updated_at);
    CREATE INDEX sessions_repo ON sessions(repo_root); CREATE INDEX sessions_cwd ON sessions(cwd);
    CREATE TABLE repos(cwd TEXT PRIMARY KEY, repo_root TEXT, origin_url TEXT, worktree INTEGER, "exists" INTEGER, checked_at REAL);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO sessions VALUES('fake','kept','desk','Retained title',NULL,'/demo',NULL,1,2,1,NULL,NULL,'{"type":"idle"}',NULL);
    INSERT INTO sessions VALUES('fake','removed','desk',NULL,NULL,'/demo',NULL,1,2,0,3,NULL,'{"type":"idle"}',NULL);
    INSERT INTO repos VALUES('/demo','/demo',NULL,0,1,4);
    INSERT INTO meta VALUES('seed:transcripts:v1','1'); PRAGMA user_version=1;`)
  db.close()
  const index = new SessionIndex(file)
  try {
    await index.seed(home)
    assert.deepEqual(index.list().data, [])
    assert.equal(index.list({ archived: 'only' }).data[0]?.title, 'Retained title')
    assert.deepEqual(index.repo('/demo'), { repo: { root: '/demo', worktree: false }, exists: true, checkedAt: 4 })
    index.confirmArchived(runtime, idOf('removed'), false)
    assert.deepEqual(index.list().data, [])
  } finally { index.close() }
})

test('import consumes pending archive marks without discarding pending names or Team membership', () => {
  const index = new SessionIndex(':memory:')
  try {
    for (const archived of [true, false]) {
      const summary = row(`pending-${archived}`)
      index.setTitle(runtime, summary.id, 'Person chose this name')
      index.setTeam(runtime, summary.id, 'synthetic-team')
      index.setArchived(runtime, summary.id, archived)
      index.importPage([summary], () => null)
      assert.equal(index.history().data.find(row => row.id === summary.id)?.archived, archived)
      index.setArchived(runtime, summary.id, !archived)
      index.upsert({ ...summary, updatedAt: 20 })
      const imported = index.history().data.find(row => row.id === summary.id)!
      assert.equal(imported.archived, !archived, 'a later ordinary write must not replay the consumed mark')
      assert.equal(imported.title, 'Person chose this name', 'import must retain pending names')
      index.promote(runtime, summary.id)
      assert.ok(!index.list().data.some(row => row.id === summary.id), 'pending Team membership stays out of loose sidebar rows')
      assert.equal(index.teamMembers('synthetic-team').length, 1, 'pending Team membership survives import')
      index.setTeam(runtime, summary.id, null)
      assert.equal(index.list({ archived: !archived ? 'only' : 'exclude' }).data[0]?.id, summary.id)
    }
  } finally { index.close() }
})

test('ordinary writes preserve origin; promotion alone adopts an imported conversation', async () => {
  const changes: SessionSummary[][] = []
  const index = new SessionIndex(':memory:', ({ upserted }) => changes.push([...upserted]))
  try {
    index.upsert(row('preview'), { origin: 'imported' })
    index.upsert(row('preview', 20))
    assert.deepEqual(index.list().data, [], 'a read or event must not adopt a preview')
    index.upsert(row('desk'))
    index.upsert(row('desk', 20), { origin: 'imported' })
    assert.deepEqual(index.list().data.map(row => row.id), ['desk'], 'an existing desk row keeps its origin')
  } finally { index.close() }
})
