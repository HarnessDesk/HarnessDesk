import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { SeatRecord } from '@harnessdesk/protocol'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { admitProject, gitReader, type GitReader } from '../src/provenance/git.js'
import { ProvenanceJournal, readCheckpoint } from '../src/provenance/journal.js'
import { Coalesced, RefObserver, type WorkerCheckpoint } from '../src/provenance/observer.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { makeRepo } from './fixtures/provenance-repo.js'
import type { Repo } from './fixtures/provenance-repo.js'

const waitUntil = async (condition: () => boolean | Promise<boolean>, name: string): Promise<void> => {
  const deadline = Date.now() + 10000
  while (!await condition()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${name}`)
    await delay(20)
  }
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('wake returns immediately and microtask bursts coalesce without concurrent scans', async () => {
  const gate = deferred()
  let calls = 0
  let active = 0
  let peak = 0
  const queue = new Coalesced(async () => {
    calls += 1
    peak = Math.max(peak, ++active)
    if (calls === 1) await gate.promise
    active -= 1
  }, (error) => { throw error })
  assert.equal(queue.wake(), undefined)
  await Promise.resolve()
  for (let i = 0; i < 40; i += 1) {
    queue.wake()
    await Promise.resolve()
  }
  assert.equal(calls, 1, 'only one scan may run while the first is blocked')
  gate.resolve()
  await queue.idle()
  assert.equal(calls, 2)
  assert.equal(peak, 1)
  await queue.close()
})

test('a failed scan can retry and close aborts active work without requeue', async () => {
  let calls = 0
  const errors: unknown[] = []
  const queue = new Coalesced(async (signal) => {
    calls += 1
    if (calls === 1) throw new Error('scan-failed')
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }, (error) => errors.push(error))
  queue.wake()
  await queue.idle()
  assert.equal(errors.length, 1)
  queue.wake()
  await Promise.resolve()
  const closing = queue.close()
  queue.wake()
  await closing
  assert.equal(calls, 2)
  assert.equal(queue.controller.signal.aborted, true)
})

test('settled scans keep existing metadata watches attached', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  let opened = 0
  let closed = 0
  const fakeWatch = (() => {
    opened += 1
    const watcher = {
      on: () => watcher,
      close: () => { closed += 1 },
    }
    return watcher
  }) as unknown as typeof watch
  const observer = new RefObserver({
    git: gitReader(handle), journal, changed: () => {}, problem: () => {}, watch: fakeWatch, pollMs: 0,
  })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  const attached = opened
  assert.ok(attached > 0)
  observer.wake()
  await observer.idle()
  assert.equal(opened, attached, 'a settled rescan must not replace every existing watcher')
  assert.equal(closed, 0, 'a settled rescan must leave every existing watcher attached')
})

const observed = async (t: TestContext, options: { watch?: typeof watch; pollMs?: number } = {}) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const problems: string[] = []
  let changed = 0
  const observer = new RefObserver({
    git: gitReader(handle), journal, changed: () => { changed += 1 },
    problem: (_kind, reason) => problems.push(reason), debounceMs: 5, pollMs: 0, ...options,
  })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  const has = async (sha: string) => (await journal.read()).entries.some((entry) =>
    entry.kind === 'commit' && (entry.value as { sha: string }).sha === sha,
  )
  assert.equal(await has(base), true)
  return { repo, base, journal, observer, problems, has, changed: () => changed }
}

test('real watches capture external branches, tags, rewinds and rapid round trips without turns', async (t) => {
  const f = await observed(t)
  assert.ok(!f.problems.includes('watch-unavailable'), 'real file notifications must attach')
  const next = await f.repo.commitTree(f.base, { one: 'changed\n' }, 'next')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await waitUntil(() => f.has(next), 'external fast-forward')
  await f.repo.git('update-ref', 'refs/heads/topic', next)
  await f.repo.git('update-ref', 'refs/heads/main', f.base)
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await f.repo.git('update-ref', 'refs/heads/main', f.base)
  await f.repo.git('tag', 'light', next)
  await f.repo.git('tag', '-a', 'annotated', '-m', 'tag', next)
  await f.repo.git('pack-refs', '--all')
  await waitUntil(async () => (await f.journal.read()).entries.filter((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string; after: string }).ref === 'refs/heads/main' &&
    (entry.value as { after: string }).after === f.base).length >= 2, 'repeated reflog movements')
  await f.repo.git('update-ref', '-d', 'refs/heads/topic')
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string; after: string | null }).ref === 'refs/heads/topic' &&
    (entry.value as { after: string | null }).after === null), 'branch deletion')
  assert.ok(f.changed() > 1)
})

test('detached HEAD, atomic ref replacement and a newly admitted linked HEAD are observed', async (t) => {
  const f = await observed(t)
  assert.ok(!f.problems.includes('watch-unavailable'), 'real file notifications must attach')
  const next = await f.repo.commitTree(f.base, { two: 'next\n' }, 'next')
  await f.repo.git('checkout', '--detach', f.base)
  await f.repo.git('update-ref', '--no-deref', 'HEAD', next)
  await waitUntil(() => f.has(next), 'detached HEAD')
  const ref = join(f.repo.dir, '.git/refs/heads/atomic')
  await writeFile(`${ref}.lock`, `${next}\n`)
  await rename(`${ref}.lock`, ref)
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string }).ref === 'refs/heads/atomic'), 'atomic replacement')
  await f.observer.close()
  const linked = join(f.repo.stateDir, 'linked')
  await f.repo.git('worktree', 'add', '--detach', linked, f.base)
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir, linked])
  const observer = new RefObserver({ git: gitReader(handle), journal: f.journal, changed: () => {},
    problem: () => {}, debounceMs: 5, pollMs: 0 })
  t.after(() => observer.close())
  await observer.start(handle, readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint)
  await observer.idle()
  const linkedHead = join(handle.checkouts.get(linked)!, 'HEAD')
  await writeFile(linkedHead, `${next}\n`)
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { checkout: string; after: string }).checkout === linked &&
    (entry.value as { after: string }).after === next), 'linked HEAD')
})

test('restart catches up and a removed reflog leaves a durable gap', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const next = await f.repo.commitTree(f.base, { one: 'offline\n' }, 'offline')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await rm(join(f.repo.dir, '.git/logs/refs/heads/main'))
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  const problems: string[] = []
  const observer = new RefObserver({ git: gitReader(handle), journal: f.journal, changed: () => {},
    problem: (_kind, reason) => problems.push(reason) })
  t.after(() => observer.close())
  await observer.start(handle, readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint)
  await observer.idle()
  assert.equal(await f.has(next), true)
  assert.ok(problems.includes('history-gap'))
  assert.ok((await f.journal.read()).entries.some((entry) => entry.kind === 'gap'))
})

test('unavailable watches use real polling and say capture is degraded', async (t) => {
  const f = await observed(t, { watch: (() => { throw new Error('watch-refused') }) as typeof watch, pollMs: 1000 })
  const next = await f.repo.commitTree(f.base, { one: 'poll\n' }, 'poll')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await waitUntil(() => f.has(next), 'polling fallback')
  assert.ok(f.problems.includes('watch-unavailable'))
})

test('parent work beyond the batch survives checkpoint replay and abort never writes a cursor', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const start = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint
  const tip = 'e'.repeat(40)
  const parent = 'd'.repeat(40)
  const controller = deferred()
  let entered = false
  const fake: GitReader = {
    snapshot: async () => ({ refs: new Map([['refs/heads/main', tip]]), heads: new Map(), takenAt: Date.now() }),
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commit: async (sha, signal) => {
      if (sha === parent) {
        entered = true
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        signal.throwIfAborted()
      }
      await delay(55)
      return { sha, tree: sha, parents: [parent] }
    },
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], close: async () => { controller.resolve() },
  }
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  t.after(() => gitReader(handle).close())
  const observer = new RefObserver({ git: fake, journal: f.journal, changed: () => {}, problem: () => {}, pollMs: 60000 })
  await observer.start(handle, start)
  await waitUntil(() => entered, 'second parent read')
  const before = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint
  assert.ok(before.frontier.includes(parent), 'the unvisited parent must be durable')
  await observer.close()
  await controller.promise
  assert.deepEqual(readCheckpoint((await f.journal.read()).entries), before)
})

test('plane disables, re-enables, forgets and closes independent projects without late registration', async () => {
  const one = await makeRepo()
  const two = await makeRepo()
  const store = new EvidenceStore(join(one.stateDir, 'evidence'))
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: one.stateDir, projects: () => [one.dir, two.dir], push: () => {}, log: () => {},
  })
  try {
    await plane.start()
    await waitUntil(async () => (await plane.status()).length === 2, 'two project registrations')
    await plane.setCapture(one.dir, false)
    assert.equal((await plane.status(one.dir))[0]?.enabled, false)
    assert.equal((await plane.status(two.dir))[0]?.enabled, true)
    const reply = await plane.read(one.dir, ['a'.repeat(40)])
    assert.equal(reply.commits[0]?.reason, 'capture-off')
    await plane.setCapture(one.dir, true)
    assert.equal((await plane.status(one.dir))[0]?.enabled, true)
    plane.setProjects([two.dir])
    await waitUntil(async () => (await plane.status()).length === 1, 'forgotten project cleanup')
    assert.equal((await plane.status())[0]?.project, two.dir)
    assert.ok((await readFile(join(store.folderOf(one.dir), 'provenance.ndjson'), 'utf8')).includes('capture-toggle'))
  } finally {
    await plane.close()
  }
  const empty = new ProvenancePlane({ evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: one.stateDir, projects: () => [one.dir], push: () => assert.fail('late notification'), log: () => {} })
  const starting = empty.start()
  await empty.close()
  await starting
  assert.deepEqual(await empty.status(), [])
})

test('a saved enable preference publishes stopped health when admission fails afterwards', async () => {
  const repo = await makeRepo()
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const notices: import('@harnessdesk/protocol').CaptureHealth[] = []
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir],
    push: (notice) => { if (notice.method === 'provenance/changed') notices.push(notice.params.health) }, log: () => {},
  })
  try {
    await plane.start()
    await waitUntil(async () => (await plane.status()).length === 1, 'project registration')
    await plane.setCapture(repo.dir, false)
    await rm(join(repo.dir, '.git'), { recursive: true, force: true })
    await assert.rejects(plane.setCapture(repo.dir, true))
    const health = (await plane.status(repo.dir))[0]
    assert.equal(health?.enabled, true)
    assert.equal(health?.state, 'stopped')
    assert.equal(notices.at(-1)?.enabled, true)
    assert.equal(notices.at(-1)?.state, 'stopped')
  } finally {
    await plane.close()
  }
})

test('a registered linked checkout reads, toggles, and retries its canonical project capture', async () => {
  const repo = await makeRepo()
  const head = await repo.commitTree(null, { 'work.ts': 'export const work = true\n' }, 'head')
  await repo.git('update-ref', 'refs/heads/main', head)
  const linked = join(repo.stateDir, 'linked-checkout')
  await repo.git('worktree', 'add', '--detach', linked, head)
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir, linked], push: () => {}, log: () => {},
  })
  try {
    await plane.start()
    await waitUntil(async () => {
      if ((await plane.status()).length !== 1) return false
      return (await plane.status(linked).catch(() => []))[0]?.project === repo.dir
    }, 'linked checkout alias registration')
    assert.equal((await plane.status(linked))[0]?.project, repo.dir)
    await plane.setCapture(linked, false)
    assert.equal((await plane.status(repo.dir))[0]?.enabled, false)
    await plane.setCapture(linked, true)
    assert.equal((await plane.status(linked))[0]?.enabled, true)
    await plane.retry(linked)
    assert.equal((await plane.status(repo.dir))[0]?.project, repo.dir)
  } finally {
    await plane.close()
  }
})


test('restart rebuilds a local fact from durable fingerprints after its original object disappears', async () => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'seat work\n' }, 'first')
  await repo.git('update-ref', 'refs/heads/main', first)
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const seat: SeatRecord = {
    id: 'seat-1', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Recorded seat',
    passedOver: [], standing: { kind: 'permission', permission: 'read' }, ceiling: null,
    checkout: { cwd: repo.dir, project: repo.dir, branch: 'main', head: base },
    session: { runtime: 'fixture', sessionId: 'original-session' }, board: null, role: null,
    openedAt: 1, closed: null,
  }
  const { closed, ...opening } = seat
  void closed
  await store.append(repo.dir, 'seats', [{ type: 'seat', record: opening }])
  await store.append(repo.dir, 'evidence', [{ type: 'evidence', record: {
    id: 'fact-1', seat: seat.id, checkout: { cwd: repo.dir, branch: 'main' }, observedAt: 10,
    fact: { kind: 'diff', from: base, to: first, files: 1, added: 1, removed: 1 },
  } }])
  const create = () => new ProvenancePlane({
    evidence: { store, seats: { byId: () => seat } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir], push: () => {}, log: () => {},
  })
  const old = create()
  await old.start()
  try {
    await waitUntil(async () => {
      if (!(await old.status()).length) return false
      return (await old.read(repo.dir, [first])).commits[0]?.state === 'attributed'
    }, 'original local association')
  } finally {
    await old.close()
  }
  const tree = await repo.git('rev-parse', `${first}^{tree}`)
  const rewritten = await repo.git('commit-tree', tree, '-p', base, '-m', 'message amend')
  await repo.git('update-ref', 'refs/heads/main', rewritten)
  await rename(join(repo.dir, '.git/objects', first.slice(0, 2), first.slice(2)), join(repo.stateDir, 'old-object'))
  const next = create()
  await next.start()
  try {
    await waitUntil(async () => {
      if (!(await next.status()).length) return false
      return (await next.read(repo.dir, [rewritten])).commits[0]?.state === 'attributed'
    }, 'association after original object loss')
    const result = (await next.read(repo.dir, [rewritten])).commits[0]!
    assert.equal(result.seats[0]?.session.sessionId, 'original-session')
    assert.deepEqual(result.evidenceIds, ['fact-1'])
  } finally {
    await next.close()
  }
})

const assertNestedCheckoutAttribution = async (
  t: TestContext,
  repo: Repo,
  checkout: string,
  roots: readonly string[],
): Promise<void> => {
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'nested Seat work\n' }, 'nested Seat work')
  await repo.git('update-ref', 'refs/heads/main', first)
  const nested = join(checkout, 'nested')
  await mkdir(nested)
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const seat: SeatRecord = {
    id: 'nested-seat', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Nested Seat',
    passedOver: [], standing: { kind: 'permission', permission: 'read' }, ceiling: null,
    checkout: { cwd: nested, project: repo.dir, branch: 'main', head: base },
    session: { runtime: 'fixture', sessionId: 'nested-session' }, board: null, role: null,
    openedAt: 1, closed: null,
  }
  const { closed, ...opening } = seat
  void closed
  await store.append(repo.dir, 'seats', [{ type: 'seat', record: opening }])
  await store.append(repo.dir, 'evidence', [{ type: 'evidence', record: {
    id: 'nested-fact', seat: seat.id, checkout: { cwd: nested, branch: 'main' }, observedAt: 10,
    fact: { kind: 'diff', from: base, to: first, files: 1, added: 1, removed: 1 },
  } }])
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: () => seat } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => roots, push: () => {}, log: () => {},
  })
  t.after(() => plane.close())
  await plane.start()
  await waitUntil(async () => (await plane.status(repo.dir).catch(() => []))[0]?.project === repo.dir, 'canonical project registration')
  await waitUntil(async () => (await plane.read(repo.dir, [first])).commits[0]?.state === 'attributed', 'nested checkout attribution')
  const result = (await plane.read(repo.dir, [first])).commits[0]!
  assert.deepEqual(result.seats.map((item) => item.id), [seat.id])
  assert.deepEqual(result.evidenceIds, ['nested-fact'])
}

test('a nested ordinary checkout CWD is admitted through its canonical checkout root for attribution', async (t) => {
  const repo = await makeRepo()
  await assertNestedCheckoutAttribution(t, repo, repo.dir, [repo.dir])
})

test('a nested linked-worktree CWD is admitted through its canonical checkout root for attribution', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const linked = join(repo.stateDir, 'linked-checkout')
  await repo.git('worktree', 'add', '--detach', linked, base)
  await assertNestedCheckoutAttribution(t, repo, linked, [repo.dir, linked])
})


test('an annotated tag captures its commit even when no branch reaches that commit', async (t) => {
  const repo = await makeRepo()
  const target = await repo.commitTree(null, { one: 'tag only\n' }, 'tag only')
  await repo.git('tag', '-a', 'only-tag', '-m', 'observed tag', target)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const git = gitReader(handle)
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const observer = new RefObserver({ git, journal, changed: () => {}, problem: () => {}, pollMs: 0 })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  const read = await journal.read()
  assert.ok(read.entries.some((entry) => entry.kind === 'commit' && (entry.value as { sha: string }).sha === target))
  const tag = await repo.git('rev-parse', 'refs/tags/only-tag')
  assert.notEqual(tag, target)
  assert.ok(read.entries.some((entry) => entry.kind === 'ref' && (entry.value as { after: string }).after === tag))
  assert.ok(!(read.entries.some((entry) => entry.kind === 'commit' && (entry.value as { sha: string }).sha === tag)))
})


test('a crash after an object append requeues its parents before acknowledging the ref cursor', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const checkpoint = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint
  const tip = 'e'.repeat(40)
  const parent = 'd'.repeat(40)
  await f.journal.append('commit', {
    id: 'unacknowledged-tip', sha: tip, tree: tip, parents: [parent], firstSeenAt: Date.now(),
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [f.repo.dir],
    window: { from: checkpoint.scanStartedAt, to: Date.now() },
    patch: { stable: '', exact: '', files: [] }, files: [], why: null,
  })
  const fake: GitReader = {
    snapshot: async () => ({ refs: new Map([['refs/heads/main', tip]]), heads: new Map(), takenAt: Date.now() }),
    reflogs: async () => ({ moves: [], cursors: new Map(checkpoint.logs), gaps: [], more: false }),
    commit: async (sha) => ({ sha, tree: sha, parents: [f.base] }),
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], close: async () => {},
  }
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  t.after(() => gitReader(handle).close())
  const observer = new RefObserver({ git: fake, journal: f.journal, changed: () => {}, problem: () => {}, pollMs: 0 })
  t.after(() => observer.close())
  await observer.start(handle, checkpoint)
  await observer.idle()
  assert.ok(await f.has(parent), 'an unacknowledged object must not lose its parent work')
  assert.deepEqual((readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint).frontier, [])
})
