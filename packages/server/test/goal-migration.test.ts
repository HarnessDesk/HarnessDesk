import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { convertRoom, importMigrationSeats, migrateDesk, migrationOpening, type LegacyRoom } from '../src/goals/migration.js'
import { GoalStore } from '../src/goals/store.js'
import { intent, seat } from './fixtures/goals.js'
import { tempDir } from './scratch.js'

const plain = (): LegacyRoom => ({ version: 1, nextIntent: 1, messaging: true, intents: [], channel: [] })
const member = 'fake\u0000one'

const rooms = (): Record<string, LegacyRoom> => ({
  '%2Fwork%2Flegacy.json': { ...plain(), nicknames: { [member]: 'Old name' } },
  'empty.json': { ...plain(), id: 'empty', root: '/work/repo', name: 'An empty room', members: [] },
  'standing.json': { ...plain(), id: 'standing', root: '/work/repo', members: ['fake\u0000two'] },
  'wrapped.json': {
    ...plain(), id: 'wrapped', root: '/work/repo',
    plans: [{ id: 1, goal: 'Past work', state: 'wrapped', createdAt: 1, wrappedAt: 3 }],
  },
  'many.json': {
    ...plain(), id: 'many', root: '/work/repo', nextIntent: 3,
    plans: [
      { id: 1, goal: 'First', state: 'running', createdAt: 2 },
      { id: 2, goal: 'Second', state: 'running', createdAt: 2 },
      { id: 3, goal: 'Later but finished', state: 'wrapped', createdAt: 4, wrappedAt: 5 },
    ],
    intents: [intent(2, { plan: 1 })],
  },
  'board.json': {
    ...plain(), id: 'board', root: '/work/repo', messaging: false,
    channel: (['delivered', 'queued', 'held', 'refused', 'shown'] as const).map((state, at) => ({
      id: `m-${at}`, kind: 'message', from: { kind: 'user' }, at, state, text: state, envelope: `kept ${state}`,
    })),
  },
  'flow.json': {
    ...plain(), id: 'flow', root: '/work/repo', cwd: '/work/repo/sub', members: ['fake\u0000flow'],
    roles: { ['fake\u0000flow']: 'reviewer' },
    roster: { ['fake\u0000flow']: { cwd: '/work/lanes/one', title: 'Reviewer', agent: 'Fake Runtime', model: 'small', at: 4 } },
  },
  '%2Fwork%2Flinked.json': { ...plain(), root: '/work/repo', name: 'Root was corrected' },
})

test('all eight historical shapes preserve ids, cards, delivery states and Plan history', () => {
  const converted = Object.entries(rooms()).map(([file, raw]) => convertRoom(file, raw))
  assert.equal(converted.length, 8)
  assert.equal(converted.every((room) => room.goal.state === 'open' && room.goal.receipt === null), true)
  assert.equal(converted.find((room) => room.goal.id === 'many')?.goal.sentence, 'Second')
  assert.equal(converted.find((room) => room.goal.id === 'wrapped')?.goal.sentence, 'Past work')
  assert.equal(converted.find((room) => room.goal.id === 'empty')?.goal.sentence, 'An empty room')
  assert.equal(converted.find((room) => room.goal.id === '/work/legacy')?.seats[0]?.sessionId, 'one')
  assert.equal(converted.find((room) => room.goal.id === '/work/linked')?.goal.root, '/work/repo')
  assert.deepEqual(converted.find((room) => room.goal.id === 'many')?.legacy.plans, rooms()['many.json']!.plans)
  assert.deepEqual(converted.find((room) => room.goal.id === 'many')?.board.intents, rooms()['many.json']!.intents)
  assert.deepEqual(converted.find((room) => room.goal.id === 'board')?.board.channel, rooms()['board.json']!.channel)
  assert.equal(converted.every((room) => !('members' in room.goal) && !('members' in room.board)), true)
})

test('migration records remembered and inferred locations without fabricating authority or revisions', () => {
  const remembered = convertRoom('flow.json', rooms()['flow.json']).seats[0]!
  const inferredRoom = convertRoom('%2Fwork%2Flegacy.json', rooms()['%2Fwork%2Flegacy.json'])
  const inferred = inferredRoom.seats[0]!
  assert.equal(remembered.cwd, '/work/lanes/one')
  assert.equal(remembered.role, 'reviewer')
  assert.equal(remembered.seatLabel, 'Fake Runtime · small')
  assert.equal(inferredRoom.legacy.seatLocations[inferred.id], 'inferred')
  assert.equal(inferredRoom.legacy.nicknames[inferred.id], 'Old name')
  assert.equal(inferredRoom.legacy.nicknames[member], undefined)
  const opening = migrationOpening(inferred)
  assert.deepEqual(opening.standing, { kind: 'unknown' })
  assert.deepEqual(opening.checkout, { cwd: '/work/legacy', project: '/work/legacy', branch: null, head: null })
  assert.deepEqual([opening.agent, opening.briefDigest, opening.ceiling], [null, null, null])
})

test('an activation failure keeps all original bytes and retry imports fixed Seat ids only once', async () => {
  const home = tempDir('hd-goal-migration-')
  await mkdir(join(home, 'team'))
  const sources = new Map(Object.entries(rooms()).map(([file, raw]) => [file, JSON.stringify(raw, null, 2) + '\n']))
  sources.set('inbound.json', '{ "fake\\u0000one": "hold" }\n')
  for (const [file, text] of sources) await writeFile(join(home, 'team', file), text)
  const imported = new Map<string, unknown>()
  const importing = async (seats: { id: string }[]): Promise<void> => {
    for (const record of seats) imported.set(record.id, record)
  }
  await assert.rejects(migrateDesk(home, importing, async () => { throw new Error('power cut') }), /power cut/)
  assert.deepEqual(await readdir(home), ['team'])
  const count = imported.size
  assert.equal(count, 3)
  assert.equal(await migrateDesk(home, importing), 'migrated')
  assert.equal(imported.size, count)
  assert.equal(await migrateDesk(home, importing), 'existing')
  for (const [file, text] of sources) assert.equal(await readFile(join(home, 'team', file), 'utf8'), text)
  const store = new GoalStore(home)
  await store.load()
  assert.equal(store.list().length, 8)
  assert.equal(store.noticeSeen, false)
  const original = sources.get('many.json')!
  assert.equal(store.read('many').legacy?.sourceSha256, createHash('sha256').update(original).digest('hex'))
  await store.acknowledgeMigration()
  const reopened = new GoalStore(home)
  await reopened.load()
  assert.equal(reopened.noticeSeen, true)
})

test('a reused phase-4 Seat keeps its Agent, brief and ceiling; duplicate kept matches refuse', async () => {
  const wanted = convertRoom('flow.json', rooms()['flow.json']).seats[0]!
  const existing = seat('kept-before-upgrade', {
    board: wanted.board, session: { runtime: wanted.runtime, sessionId: wanted.sessionId },
    agent: { id: 'reviewer', name: 'Reviewer', origin: 'user' }, briefDigest: 'a'.repeat(64),
    standing: { kind: 'ceiling', level: 'read' }, ceiling: { level: 'read', hold: 'held' },
  })
  let writes = 0
  const book = {
    all: () => [existing],
    importOpening: async () => { writes++; return existing },
  }
  await importMigrationSeats([wanted], book)
  assert.equal(writes, 0)
  assert.equal(existing.agent?.name, 'Reviewer')
  await assert.rejects(importMigrationSeats([wanted], { ...book, all: () => [existing, { ...existing, id: 'duplicate' }] }), /Two kept Seats/)
  assert.equal(writes, 0)
})

test('duplicate ids and conversations name both source files before imports begin', async () => {
  for (const duplicate of ['id', 'conversation']) {
    const home = tempDir('hd-goal-duplicate-')
    await mkdir(join(home, 'team'))
    await writeFile(join(home, 'team', 'one.json'), JSON.stringify({ ...plain(), id: 'one', root: '/work/repo', members: [member] }))
    await writeFile(join(home, 'team', 'two.json'), JSON.stringify({
      ...plain(), id: duplicate === 'id' ? 'one' : 'two', root: '/work/repo',
      members: duplicate === 'conversation' ? [member] : [],
    }))
    let calls = 0
    await assert.rejects(migrateDesk(home, async () => { calls++ }), /one.json and two.json/)
    assert.equal(calls, 0)
    assert.deepEqual(await readdir(home), ['team'])
  }
})

test('malformed arrays, members, newer versions and reserved filenames are never staged', () => {
  const base = { ...plain(), id: 'room', root: '/work/repo' }
  for (const over of [
    { version: 2 }, { members: ['broken'] }, { members: [42] }, { members: 'bad' },
    { plans: {} }, { intents: [{ id: 1 }] }, { channel: [{ kind: 'message' }] },
    { roster: [] }, { root: 'relative' },
  ]) assert.throws(() => convertRoom('bad.json', { ...base, ...over }))
  assert.throws(() => convertRoom('index.json', { ...base, id: 'index' }), /file naming rule/)
})

test('a fresh desk shows no upgrade notice; a partial or newer active store refuses', async () => {
  const fresh = tempDir('hd-goal-fresh-')
  await migrateDesk(fresh, async (seats) => { assert.deepEqual(seats, []) })
  const store = new GoalStore(fresh)
  await store.load()
  assert.equal(store.noticeSeen, true)
  assert.deepEqual(store.list(), [])
  const partial = tempDir('hd-goal-partial-')
  await mkdir(join(partial, 'goals'))
  await assert.rejects(migrateDesk(partial, async () => {}), /ENOENT/)
  await writeFile(join(partial, 'goals', 'index.json'), JSON.stringify({ version: 2, ids: [], noticeSeen: true }))
  await assert.rejects(migrateDesk(partial, async () => {}), /Goal index cannot be read/)
})

test('a 4096-character legacy id uses a hashed filename and round-trips without rekeying', async () => {
  const home = tempDir('hd-goal-long-id-')
  await mkdir(join(home, 'team'))
  const id = 'g'.repeat(4096)
  await writeFile(join(home, 'team', 'long.json'), JSON.stringify({ ...plain(), id, root: '/work/repo' }))
  await migrateDesk(home, async () => {})
  const store = new GoalStore(home)
  await store.load()
  assert.equal(store.read(id).goal.id, id)
  const files = await readdir(join(home, 'goals'))
  assert.equal(files.some((file) => /^h-[0-9a-f]{64}\.json$/.test(file)), true)
})
