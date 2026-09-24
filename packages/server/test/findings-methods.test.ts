import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { EvidenceRecord } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { FindingsPlane, READ_PAGE_LIMIT, type FindingsPort } from '../src/findings/plane.js'
import { tempDir } from './scratch.js'

/*
 * `finding/list` and `finding/read` as a person reads them: project-confined,
 * paged over a frozen snapshot, and never a reassuring "no findings" when
 * some of the ledger could not be read. A Seat's own scoped read
 * (`readForSeat`) is a different route entirely and never takes a cursor.
 */

const ROOT = '/work/repo'
const A = 'a'.repeat(40)

const raise = (n: number, goal = 'g1'): EvidenceRecord => ({
  id: `raise-${n}`,
  fact: { kind: 'finding', id: `finding-${String(n).padStart(4, '0')}`, state: 'open', at: A },
  card: { board: goal, id: 2 }, checkout: { cwd: ROOT, branch: 'fix' }, seat: 'seat-r', round: 2, observedAt: n, posted: null,
  finding: {
    version: 1, sequence: 1, operation: `op-raise-${n}`,
    origin: { goal, run: 'run-1', round: 2, card: 2, seat: 'seat-r', at: A },
    event: { kind: 'raise', title: `Finding ${n}`, body: 'Details.', category: 'ordinary', blocking: true, related: null, anchor: null },
  },
})

interface Rig {
  readonly store: EvidenceStore
  readonly plane: FindingsPlane
  readonly file: string
  now: number
}

const rig = async (): Promise<Rig> => {
  const home = tempDir('hd-findings-methods-')
  const store = new EvidenceStore(home)
  const out = { store, now: 1_000 } as unknown as Rig
  const port: FindingsPort = {
    store: {
      read: (project, file) => store.read(project, file),
      append: (project, file, lines) => store.append(project, file, lines),
    },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: {
      binding: () => null,
      candidate: async () => null,
      journal: async () => { throw new Error('no runs in this test') },
      pending: () => [],
    },
    projectOf: async (goal) => {
      if (goal !== 'g1') throw new Error('That Goal is not on this desk.')
      return ROOT
    },
    headOf: async () => ({ at: null, dirty: false }),
    now: () => out.now,
    log: () => {},
  }
  Object.assign(out, { plane: new FindingsPlane(port), file: join(store.folderOf(ROOT), 'evidence.ndjson') })
  return out
}

test('a foreign or missing Goal refuses without leaking a path', async () => {
  const { plane } = await rig()
  await assert.rejects(plane.list({ goal: 'unknown' }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'That Goal is not on this desk.')
    assert.ok(!error.message.includes('/'), 'no path leaks into the refusal')
    return true
  })
  await assert.rejects(plane.read({ goal: 'unknown', finding: 'finding-0001' }))
})

test('a snapshot cursor is a stable page: no row moves, none is duplicated or dropped', async () => {
  const { plane, store } = await rig()
  const records = Array.from({ length: 150 }, (_, i) => raise(i + 1))
  await store.append(ROOT, 'evidence', records.map((record) => ({ type: 'evidence', record }) as const))

  const first = await plane.list({ goal: 'g1' })
  assert.equal(first.rows.length, READ_PAGE_LIMIT)
  assert.ok(first.next)
  // No review series has admitted any of these yet, so none counts as currently blocking —
  // `FindingView.blocking` is initial eligibility, not the list's own blocking total; see the next test.
  assert.deepEqual(first.totals, { all: 150, open: 150, blocking: 0 })

  // A finding raised directly on the store, after the snapshot was framed: not this snapshot's news.
  await store.append(ROOT, 'evidence', [{ type: 'evidence', record: raise(151) }])
  const second = await plane.list({ goal: 'g1', cursor: first.next! })
  assert.equal(second.rows.length, 50, 'the new finding was not smuggled into this snapshot’s second page')
  assert.equal(second.next, null)
  const ids = [...first.rows, ...second.rows].map((one) => one.id)
  assert.equal(new Set(ids).size, 150, 'every row of the frozen snapshot appears exactly once across its pages')

  // Explicit invalidation: a write the findings plane itself records drops every snapshot of this Goal.
  await plane.appendPost({
    goal: 'g1', finding: 'finding-0001', operation: 'op-post-1',
    location: { repo: 'org/repo', pr: 1, comment: 1, kind: 'issue-comment', url: 'https://github.com/org/repo/pull/1#issuecomment-1', operation: 'op-post-1' },
  })
  await assert.rejects(plane.list({ goal: 'g1', cursor: first.next! }), /The findings changed\. Reload the list\./)
  // The very next read with no cursor is unaffected: a fresh first page, not a second refusal.
  const fresh = await plane.list({ goal: 'g1' })
  assert.equal(fresh.totals?.all, 151, 'the post event added no finding; the direct raise from before it did')
})

test('list blocking counts the active series, never a raw claimed bit alone', async () => {
  const { store } = await rig()
  await store.append(ROOT, 'evidence', [raise(1), raise(2), raise(3)].map((record) => ({ type: 'evidence', record }) as const))
  const port: FindingsPort = {
    store: { read: (project, file) => store.read(project, file), append: (project, file, lines) => store.append(project, file, lines) },
    seats: { byId: () => null, latestKeptOf: () => null },
    flows: {
      binding: () => null, candidate: async () => null, journal: async () => { throw new Error('unused') }, pending: () => [],
      // Only finding-0001 was admitted when its series' first review closed; 0002 raised blocking but was never admitted.
      seriesOfGoal: () => [{
        id: 'reviewer@/work/repo', role: 'reviewer', checkout: { cwd: ROOT, branch: null },
        reviewedAt: A, reviewRounds: [2], initial: ['finding-0001'], exceptions: [], pending: [],
      }],
    },
    projectOf: async () => ROOT, headOf: async () => ({ at: null, dirty: false }), now: () => 1, log: () => {},
  }
  const plane = new FindingsPlane(port)
  const page = await plane.list({ goal: 'g1' })
  assert.deepEqual(page.totals, { all: 3, open: 3, blocking: 1 })
  const blocking = await plane.list({ goal: 'g1', filter: 'blocking' })
  assert.deepEqual(blocking.rows.map((one) => one.id), ['finding-0001'])
})

test('a cursor read after five minutes is refused, not silently answered stale', async () => {
  const state = await rig()
  await state.store.append(ROOT, 'evidence', Array.from({ length: 120 }, (_, i) => raise(i + 1)).map((record) => ({ type: 'evidence', record }) as const))
  const first = await state.plane.list({ goal: 'g1' })
  assert.ok(first.next)
  state.now += 5 * 60 * 1000 + 1
  await assert.rejects(state.plane.list({ goal: 'g1', cursor: first.next! }), /The findings changed\. Reload the list\./)
})

test('unreadable evidence is never read as a clean, empty ledger', async () => {
  const { plane, store, file } = await rig()
  await store.append(ROOT, 'evidence', [{ type: 'evidence', record: raise(1) }])
  // A line this build cannot parse at all — the same shape evidence-store.test.ts uses for a torn write.
  await appendFile(file, '{"v":1,"type":"evidence","record":{"id":"half')

  const page = await plane.list({ goal: 'g1' })
  assert.equal(page.totals, null, 'never a reassuring zero or count once part of the ledger could not be read')
  assert.match(page.problem ?? '', /could not be read/)
  assert.equal(page.rows.length, 1, 'what could be read is still shown')

  const detail = await plane.read({ goal: 'g1', finding: 'finding-0001' })
  assert.match(detail.problem ?? '', /could not be read/)
})

test('a Seat’s own scoped read cannot carry a person’s cursor', async () => {
  const { plane } = await rig()
  await assert.rejects(
    plane.readForSeat({ intent: 1, cursor: 'whatever' }, { runtime: 'beta', sessionId: 'sess-1' }),
    /is not something a finding takes/,
  )
})
