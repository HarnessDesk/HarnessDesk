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
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 1)
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
