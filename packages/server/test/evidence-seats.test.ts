import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { digestOf } from '@harnessdesk/agent-inventory'
import {
  parseClientMessage,
  runtimeId,
  sessionId,
  ValidationError,
  type SeatRecord,
  type Session,
} from '@harnessdesk/protocol'

import { canonical } from '../src/evidence/revision.js'
import { SeatBook } from '../src/evidence/seats.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, writeAgent } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * The Seat record: written when a seat is kept, before the desk answers, and
 * immutable after — a closing is a second record, never an edit of the first.
 */

test('a kept seat is recorded with the checkout it works in, read from git, and closed once', async () => {
  const repo = await makeRepo()
  const store = new EvidenceStore(tempDir('hd-evidence-seats-'))
  const book = new SeatBook(store, () => 100)
  const record = await book.opened({
    agent: { id: 'scout', name: 'Scout', origin: 'user' },
    briefDigest: 'digest-1',
    seat: { runtime: 'fake', model: 'fake-1' },
    seatLabel: 'Fake Runtime · Fake One',
    passedOver: [],
    standing: { kind: 'permission', permission: 'read' },
    ceiling: null,
    cwd: repo.dir,
    session: { runtime: 'fake', sessionId: 's1' },
    board: null,
    role: null,
  })
  const project = await canonical(repo.dir)
  assert.deepEqual(record.checkout, { cwd: repo.dir, project, branch: 'main', head: await repo.git('rev-parse', 'HEAD') })
  assert.equal(record.openedAt, 100)
  assert.equal(record.closed, null)
  assert.deepEqual(book.latestOf('fake', 's1'), record)

  const closed = await book.closed('fake', 's1', 'deleted')
  assert.deepEqual(closed.map((seat) => seat.closed), [{ at: 100, why: 'deleted' }])
  assert.deepEqual(await book.closed('fake', 's1', 'deleted'), [], 'a closed seat is not closed again')

  // On disk: the opening as written, and one closing beside it — never an edit of the opening.
  const lines = (await readFile(join(store.folderOf(project), 'seats.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((line) => line.type), ['seat', 'seat-closed'])
  assert.equal(lines[0].record.ceiling, null)
  assert.equal('closed' in lines[0].record, false)
})

test("a seat phase 3 keeps for an Agent that says only `ceiling:` is recorded in that order's words, and read back", async () => {
  const repo = await makeRepo()
  const dir = tempDir('hd-evidence-seats-')
  const book = new SeatBook(new EvidenceStore(dir), () => 100)
  const record = await book.opened({
    agent: { id: 'scout', name: 'Scout', origin: 'user' },
    briefDigest: 'digest-1',
    seat: { runtime: 'fake' },
    seatLabel: 'Fake Runtime',
    passedOver: [],
    standing: { kind: 'ceiling', level: 'edit' },
    ceiling: { level: 'edit', hold: 'asked' },
    cwd: repo.dir,
    session: { runtime: 'fake', sessionId: 's1' },
    board: null,
    role: null,
  })
  // A later desk reads it back as it was written: no `permission:` was invented for it.
  const later = new SeatBook(new EvidenceStore(dir))
  await later.load()
  assert.deepEqual(later.latestOf('fake', 's1'), record)
  assert.deepEqual(later.latestOf('fake', 's1')?.standing, { kind: 'ceiling', level: 'edit' })
})

test('a Seat a backup brought is history: a kept Seat comes first, and the desk never closes a restored one', async () => {
  const dir = tempDir('hd-evidence-seats-')
  const store = new EvidenceStore(dir)
  const opening = (id: string, openedAt: number, restored: { at: number } | null) => ({
    type: 'seat' as const,
    record: {
      id,
      agent: { id: 'scout', name: 'Scout', origin: 'user' as const },
      briefDigest: 'digest-1',
      seat: { runtime: 'fake' },
      seatLabel: 'Fake Runtime',
      passedOver: [],
      standing: { kind: 'permission' as const, permission: 'read' as const },
      ceiling: null,
      checkout: { cwd: '/work/repo', project: '/work/repo', branch: 'main', head: null },
      session: { runtime: 'fake', sessionId: 's1' },
      board: null,
      role: null,
      openedAt,
      ...(restored ? { restored } : {}),
    },
  })
  // The restored one says it was opened later; the one this desk kept still answers for the conversation.
  await store.append('/work/repo', 'seats', [opening('kept', 1, null), opening('from-backup', 50, { at: 60 })])
  const book = new SeatBook(store, () => 100)
  await book.load()
  assert.equal(book.latestOf('fake', 's1')?.id, 'kept')
  assert.equal(book.latestKeptOf('fake', 's1')?.id, 'kept')

  const closed = await book.closed('fake', 's1', 'deleted')
  assert.deepEqual(closed.map((seat) => seat.id), ['kept'], 'only the Seat this desk kept is closed')
  assert.equal(book.byId('from-backup')?.closed, null)

  // A conversation only a backup knows is drawn from it, and is no Agent this desk seated.
  await store.append('/work/repo', 'seats', [{ ...opening('only-restored', 5, { at: 60 }), record: { ...opening('only-restored', 5, { at: 60 }).record, session: { runtime: 'fake', sessionId: 's2' } } }])
  await book.load()
  assert.equal(book.latestOf('fake', 's2')?.id, 'only-restored')
  assert.equal(book.latestKeptOf('fake', 's2'), null)
})

test('through the host: an Agent seated leaves its Seat record before the call answers, and the wire reads it', async (t) => {
  const { host, stateDir, repo } = await evidenceDesk(t)
  const source = await writeAgent(stateDir)
  const session = (await host.call('agent/seat', { id: 'scout', cwd: repo.dir })) as Session

  const record = (await host.call('evidence/seat', { runtime: 'fake', sessionId: String(session.id) })) as SeatRecord
  assert.deepEqual(record.agent, { id: 'scout', name: 'Scout', origin: 'user' })
  assert.equal(record.briefDigest, digestOf(source))
  assert.deepEqual(record.seat, { runtime: 'fake' })
  assert.equal(record.seatLabel, session.settings?.seatLabel)
  assert.deepEqual(record.standing, { kind: 'permission', permission: 'read' })
  assert.equal(record.ceiling, null, 'null until phase 3 fills it')
  assert.deepEqual(record.session, { runtime: 'fake', sessionId: String(session.id) })
  assert.equal(record.checkout.branch, 'main')
  assert.equal(record.board, null)
  assert.equal(record.closed, null)
  // On disk already: the call did not answer before the record was written.
  const folder = new EvidenceStore(join(stateDir, 'evidence')).folderOf(await canonical(repo.dir))
  assert.match(await readFile(join(folder, 'seats.ndjson'), 'utf8'), new RegExp(record.id))
  // A conversation never seated has no record, and says so as null.
  assert.equal(await host.call('evidence/seat', { runtime: 'fake', sessionId: 'nobody' }), null)
})

test('through the host: a seat whose record cannot be written is closed, and the refusal says why', async (t) => {
  const { host, runtime, stateDir, repo } = await evidenceDesk(t)
  await writeAgent(stateDir)
  // A file where the store's folder has to be: nothing under it can be written.
  await writeFile(join(stateDir, 'evidence'), 'not a folder')
  await assert.rejects(
    host.call('agent/seat', { id: 'scout', cwd: repo.dir }),
    /^Error: Scout was seated on .+, and its Seat record could not be written, so the conversation was closed: /,
  )
  const opened = [...runtime.sessions.keys()]
  assert.equal(opened.length, 1)
  const held = host.registry.get(runtimeId('fake'), sessionId(String(opened[0])))
  assert.equal(held?.live ?? null, null, 'its handle is let go')
  assert.equal(held?.seatedAs ?? null, null, 'and it was never kept as the Agent')
})

test('the wire refuses a Seat record asked of no conversation', () => {
  const ask = (params: unknown) => parseClientMessage({ id: 1, method: 'evidence/seat', params })
  assert.throws(() => ask({ runtime: '', sessionId: 's1' }), ValidationError)
  assert.throws(() => ask({ runtime: 'fake', sessionId: ' ' }), ValidationError)
  assert.throws(() => ask({ runtime: 'fake' }), ValidationError)
  assert.deepEqual(ask({ runtime: 'fake', sessionId: 's1' }).params, { runtime: 'fake', sessionId: 's1' })
})
