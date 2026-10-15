import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import fs from 'node:fs/promises'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, relative } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { SeatRecord } from '@harnessdesk/protocol'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { admitProject, gitReader, type GitReader } from '../src/provenance/git.js'
import { ProvenanceJournal, readCheckpoint, writeCheckpoint, type JournalEntry } from '../src/provenance/journal.js'
import { Coalesced, RefObserver, type WorkerCheckpoint } from '../src/provenance/observer.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { makeRepo, scriptedGit } from './fixtures/provenance-repo.js'
import type { Repo } from './fixtures/provenance-repo.js'

const noWatch = (() => { const watcher = { on: () => watcher, close: () => {} }; return watcher }) as unknown as typeof watch
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

for (const restart of [false, true]) test(`an unreadable journalled commit cannot stall the next ancestry batch${restart ? ' after restart' : ''}`, async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const sha = (n: number) => n.toString(16).padStart(40, '0')
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  // Another capture already retained this parent edge. Its object is no
  // longer readable here; observing it is not proof its ancestry was walked.
  await journal.append('commit', {
    id: `commit-${sha(201)}`, sha: sha(201), tree: sha(201), parents: [sha(202)], firstSeenAt: 20,
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [], window: { from: null, to: 20 },
    patch: { stable: '', exact: '', files: [] }, files: [], why: null,
  })
  let scans = 0
  const problems: string[] = []
  const batches: number[] = []
  const git: GitReader = {
    snapshot: async () => {
      assert.ok(++scans <= 4, 'bounded catch-up must settle')
      return { refs: new Map([['refs/heads/main', sha(1)]]), heads: new Map(), takenAt: 30 }
    },
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commitTimes: async (ids) => {
      if (ids.includes(sha(201))) throw new Error('git-failed')
      return new Map(ids.map((id) => [id, 20]))
    },
    commit: async (id) => {
      if (id === sha(201)) throw new Error('git-failed')
      return { sha: id, tree: id, parents: id === sha(450) ? [] : [sha(Number.parseInt(id, 16) + 1)], committedAt: 20 }
    },
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    kinds: async () => new Map(), ancestors: async () => [], batch: (_signal, work) => work(git), close: async () => {},
  }
  let observer: RefObserver
  let captured = 1
  const options = { git, journal, watch: noWatch, pollMs: 0, now: () => 30, historyFloor: () => 10,
    problem: (_kind: string, reason: string) => problems.push(reason),
    changed: () => { batches.push(observer.checkpoint!.frontier.length) },
  }
  if (restart) {
    // The durable state left by the first 200 visits, including its known tip.
    for (let n = 1; n <= 200; n += 1) await journal.append('commit', {
      id: `commit-${sha(n)}`, sha: sha(n), tree: sha(n), parents: [sha(n + 1)], firstSeenAt: 30,
      fingerprintVersion: 1, discoveredBy: [], checkoutHints: [], window: { from: null, to: 30 },
      patch: { stable: '', exact: '', files: [] }, files: [], why: null,
    })
    await writeCheckpoint(journal, { generation: 1, refs: [['refs/heads/main', sha(1)]], heads: [], logs: [],
      frontier: [sha(201)], capturedThrough: 30, scanStartedAt: 30, openedAt: 30, historyFloor: 10,
      baseline: [sha(1)], rangeKeys: [], rangePending: [] } satisfies WorkerCheckpoint)
    captured = 201
  }
  observer = new RefObserver(options)
  t.after(() => observer.close())
  await observer.start(handle, readCheckpoint((await journal.read()).entries) as WorkerCheckpoint | null)
  await observer.idle()
  const entries = (await journal.read()).entries
  assert.equal(entries.filter((entry) => entry.kind === 'commit').length, 450, `catch-up stopped with ${captured} prior observations`)
  assert.deepEqual(observer.checkpoint!.frontier, [])
  assert.equal(batches.length, restart ? 2 : 3, 'every bounded batch continues without an external wake')
  assert.ok(problems.includes('history-gap'), 'the unavailable object remains visible')
})

test('status explains a frontier blocked after one batch by an unreadable unobserved object', async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const repo = await makeRepo()
  const sha = (n: number) => n.toString(16).padStart(40, '0')
  await writeFile(join(repo.dir, '.git/refs/heads/main'), `${sha(900)}\n`)
  const store = new EvidenceStore(repo.stateDir)
  const journal = new ProvenanceJournal(join(store.folderOf(repo.dir), 'provenance.ndjson'))
  const frontier = Array.from({ length: 450 }, (_, n) => sha(n + 1))
  await writeCheckpoint(journal, { generation: 1, refs: [['refs/heads/main', sha(900)]], heads: [[repo.dir, sha(900)]], logs: [],
    frontier, capturedThrough: 20, scanStartedAt: 20, openedAt: 30, historyFloor: 0,
    baseline: [], rangeKeys: [], rangePending: [] } satisfies WorkerCheckpoint)
  const script = scriptedGit()
  const run: typeof script.run = async (executable, args, options) => {
    if (args.includes('log')) return Buffer.from(options.input!.toString('utf8').trim().split('\n')
      .map((id) => `${id} 20\n`).join(''))
    const at = args.indexOf('cat-file')
    if (at >= 0 && args[at + 1] === 'commit') {
      const id = args[at + 2]!
      if (id === sha(201)) throw new Error('git-failed')
      return Buffer.from(`tree ${id}\ncommitter Jane Doe <dev@example.com> 20 +0000\n\nfixture\n`)
    }
    return script.run(executable, args, options)
  }
  const plane = new ProvenancePlane({ evidence: { store } as EvidencePlane, stateDir: repo.stateDir,
    projects: () => [repo.dir], reader: { run }, now: () => 30, log: () => {}, push: () => {} })
  t.after(() => plane.close())
  await plane.start()
  await waitUntil(async () => (await plane.status())[0]?.reason === 'Some history was unavailable when capture resumed.', 'blocked capture status')
  const status = (await plane.status(repo.dir))[0]!
  assert.equal(status.state, 'degraded')
  assert.ok(status.pending > 0, 'the frontier stays available for a later retry')
  assert.ok(status.nextStep.includes('Retry'))
  const entries = (await new ProvenanceJournal(join(store.folderOf(repo.dir), 'provenance.ndjson')).read()).entries
  assert.equal(entries.filter((entry) => entry.kind === 'commit').length, 200, 'the first batch completed before the blocked read')
  assert.ok((readCheckpoint(entries) as WorkerCheckpoint).frontier.includes(sha(201)))
})

for (const probe of [true, false]) test(`a metadata refusal during ${probe ? 'clock probing' : 'a journalled object read'} cannot advance capture`, async (t) => {
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const tip = 'a'.repeat(40)
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  await journal.append('commit', { id: 'known', sha: tip, tree: tip, parents: [], firstSeenAt: 20,
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [], window: { from: null, to: 20 }, patch: null, files: [], why: null })
  const saved: WorkerCheckpoint = { generation: 1, refs: [['refs/heads/main', tip]], heads: [], logs: [], frontier: [tip],
    capturedThrough: 20, scanStartedAt: 20, openedAt: 30, historyFloor: 10, baseline: [], rangeKeys: [], rangePending: [] }
  await writeCheckpoint(journal, saved)
  const git: GitReader = {
    snapshot: async () => ({ refs: new Map(saved.refs), heads: new Map(), takenAt: 30 }),
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commitTimes: probe ? async () => { throw new Error('metadata-changed') } : undefined,
    commit: async () => { throw new Error('metadata-changed') },
    kinds: async () => new Map(), patch: async () => { assert.fail('metadata refusal must stop object work') },
    files: async () => [], ancestors: async () => [], batch: (_signal, work) => work(git), close: async () => {},
  }
  let changed = 0
  const problems: string[] = []
  const observer = new RefObserver({ git, journal, watch: noWatch, pollMs: 0, now: () => 30, historyFloor: () => 10,
    changed: () => { changed += 1 }, problem: (_kind, reason) => problems.push(reason) })
  t.after(() => observer.close())
  await observer.start(handle, saved)
  await observer.idle()
  assert.equal(changed, 0)
  assert.deepEqual(observer.checkpoint, saved)
  assert.deepEqual(readCheckpoint((await journal.read()).entries), saved)
  assert.deepEqual(problems, ['history-gap'])
})

for (const cost of [0, 100]) test(`an in-window frontier captures a bounded batch before checkpointing with ${cost}ms fake reads`, async (t) => {
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const sha = (n: number) => n.toString(16).padStart(40, '0')
  const frontier = Array.from({ length: 450 }, (_, n) => sha(n + 1000))
  const saved: WorkerCheckpoint = { generation: 1, refs: [['refs/heads/main', sha(2000)]], heads: [], logs: [],
    frontier, capturedThrough: 1, scanStartedAt: 1, openedAt: 1, historyFloor: 0,
    baseline: [], rangeKeys: Array.from({ length: 13000 }, (_, n) => `range-${n}`), rangePending: [] }
  const entries: JournalEntry[] = []
  const checkpoints: unknown[] = []
  const journal = {
    read: async () => ({ entries: [...entries], broken: false }),
    append: async (kind: JournalEntry['kind'], value: unknown) => { entries.push({ seq: entries.length + 1, kind, value }); return entries.length },
    checkpoint: async (value: unknown) => { checkpoints.push(value) },
    flush: async () => {},
  } as unknown as ProvenanceJournal
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  const expectedBatch = cost ? 50 : 200
  const expectedScans = Math.ceil(frontier.length / expectedBatch)
  let scans = 0
  const problems: string[] = []
  const git: GitReader = {
    snapshot: async () => {
      if (++scans > expectedScans) throw new Error('scan-work-budget-exceeded')
      return { refs: new Map(saved.refs), heads: new Map(), takenAt: 1000 + clock }
    },
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commit: async (id) => { clock += cost; return { sha: id, tree: id, parents: [], committedAt: 1 } },
    patch: async () => ({ stable: sha(3000), exact: sha(3001), files: ['file'] }),
    files: async () => [], kinds: async () => new Map(), ancestors: async () => [],
    batch: (_signal, work) => work(git), close: async () => {},
  }
  const batches: number[] = []
  let observed = 0
  let yields = 0
  const observer = new RefObserver({ git, journal, watch: noWatch, pollMs: 0, now: () => 1000 + clock,
    slices: { yield: async () => { yields += 1 } },
    problem: (_kind, reason) => { problems.push(reason) },
    changed: () => { const count = entries.filter((entry) => entry.kind === 'commit').length; batches.push(count - observed); observed = count },
  })
  t.after(() => observer.close())
  await observer.start(handle, saved)
  await observer.idle()
  assert.equal(batches[0], expectedBatch, 'slow asynchronous Git reads must not reduce a scan to one commit')
  assert.equal(observed, frontier.length)
  assert.equal(batches.length, expectedScans)
  assert.equal(checkpoints.length, expectedScans, 'one checkpoint per completed batch, rather than per commit')
  assert.ok(yields >= Math.floor(frontier.length / 100), 'the larger batch still yields within bounded item slices')
  assert.deepEqual(problems, [])
  assert.deepEqual(observer.checkpoint!.frontier, [])
})

for (const mode of ['frontier', 'below-floor', 'tag']) test(`replaying ${mode} work for durably observed commits writes no checkpoint`, async (t) => {
  const tag = mode === 'tag'
  const below = mode === 'below-floor'
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const sha = (n: number) => n.toString(16).padStart(40, '0')
  const known = Array.from({ length: below ? 350 : 21 }, (_, n) => sha(n + 100))
  const tip = tag ? sha(500) : known[0]!
  const saved: WorkerCheckpoint = { generation: 1, refs: [['refs/heads/main', tip]], heads: [], logs: [],
    frontier: tag ? [tip] : known, capturedThrough: 1, scanStartedAt: 1, openedAt: 11, historyFloor: below ? 10 : 0,
    baseline: [], rangeKeys: [], rangePending: [] }
  const entries: JournalEntry[] = known.map((id, n) => ({ seq: n + 1, kind: 'commit', value: {
    id: `commit-${id}`, sha: id, tree: id, parents: [], firstSeenAt: 1, fingerprintVersion: 1,
    discoveredBy: [], checkoutHints: [], window: { from: null, to: 1 }, patch: null, files: [], why: null,
  } }))
  const checkpoints: unknown[] = []
  const journal = {
    read: async () => ({ entries: [...entries], broken: false }),
    append: async () => { assert.fail('no new observation is expected') },
    checkpoint: async (value: unknown) => { checkpoints.push(value) },
    flush: async () => {},
  } as unknown as ProvenanceJournal
  let clock = 0
  let reads = 0
  let scans = 0
  t.mock.method(performance, 'now', () => clock)
  const git: GitReader = {
    snapshot: async () => ({ refs: new Map(saved.refs), heads: new Map(), takenAt: 1000 + clock }),
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commitTimes: below ? async (ids) => new Map(ids.map((id) => [id, 1])) : undefined,
    commit: async (id) => { reads += 1; clock += 100; return tag && id === tip ? null : { sha: id, tree: id, parents: [], committedAt: 1 } },
    patch: async () => { assert.fail('known commits must not be fingerprinted again') }, files: async () => [],
    kinds: async () => new Map(), ancestors: async () => [known[0]!],
    batch: (_signal, work) => work(git), close: async () => {},
  }
  const observer = new RefObserver({ git, journal, watch: noWatch, pollMs: 0, now: () => 1000 + clock,
    historyFloor: () => saved.historyFloor!, changed: () => { scans += 1 }, problem: () => { assert.fail('replay should succeed') },
  })
  t.after(() => observer.close())
  await observer.start(handle, saved)
  await observer.idle()
  assert.equal(observer.checkpoint!.capturedThrough, saved.capturedThrough, 'replay and tag peeling are not new captures')
  assert.equal(checkpoints.length, 0, 'durable observations already retain the frontier replay needs')
  assert.equal(entries.length, known.length)
  assert.deepEqual(observer.checkpoint!.frontier, [])
  if (below) {
    assert.equal(reads, 0, 'the clock batch discards even already-journalled IDs before individual reads')
    assert.equal(scans, 1, 'the full below-floor frontier drains together')
  }
})

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

test('a wake during a failed scan survives without retrying a failure on its own', async () => {
  const entered = deferred()
  const release = deferred()
  let calls = 0
  const errors: unknown[] = []
  const queue = new Coalesced(async () => {
    calls += 1
    if (calls === 1) {
      entered.resolve()
      await release.promise
    }
    throw new Error('scan-failed')
  }, (error) => errors.push(error))
  try {
    queue.wake()
    await entered.promise
    queue.wake()
    release.resolve()
    await queue.idle()
    assert.equal(calls, 2, 'the pending wake retries once; a failure alone does not loop')
    assert.equal(errors.length, 2)
  } finally {
    release.resolve()
    await queue.close()
  }
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

const cursors = async (journal: ProvenanceJournal) =>
  (await journal.read()).entries.filter((entry) => entry.kind === 'cursor').length

test('a scan that finds nothing new writes nothing, and one that finds something still does', async (t) => {
  const f = await observed(t)
  const settled = await cursors(f.journal)
  assert.ok(settled > 0, 'the first scan recorded where capture is')
  for (let wake = 0; wake < 4; wake += 1) {
    f.observer.wake()
    await f.observer.idle()
  }
  assert.equal(await cursors(f.journal), settled, 'four scans that found nothing wrote nothing')
  const next = await f.repo.commitTree(f.base, { one: 'changed\n' }, 'next')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  await waitUntil(() => f.has(next), 'a new commit')
  await f.observer.idle()
  assert.ok(await cursors(f.journal) > settled, 'a scan that found a commit recorded it')
})

test('after a restart, a scan that finds nothing new writes nothing either', async (t) => {
  const f = await observed(t)
  await f.observer.close()
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  const observer = new RefObserver({ git: gitReader(handle), journal: f.journal, changed: () => {}, problem: () => {}, pollMs: 0 })
  t.after(() => observer.close())
  const settled = await cursors(f.journal)
  await observer.start(handle, readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint)
  await observer.idle()
  observer.wake()
  await observer.idle()
  assert.equal(await cursors(f.journal), settled)
})

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
  // Deletion can only be observed for a ref a completed snapshot knew about.
  // Reflog movements may be journaled before that snapshot is checkpointed;
  // deleting sooner can also remove the topic's only reflog before capture.
  await waitUntil(async () => {
    const checkpoint = readCheckpoint((await f.journal.read()).entries) as WorkerCheckpoint | null
    return checkpoint?.refs.some(([ref]) => ref === 'refs/heads/topic') ?? false
  }, 'topic in a completed snapshot')
  await f.repo.git('update-ref', '-d', 'refs/heads/topic')
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string; after: string | null }).ref === 'refs/heads/topic' &&
    (entry.value as { after: string | null }).after === null), 'branch deletion')
  assert.ok(f.changed() > 1)
})

test('a coalesced watch during loose-ref pruning survives the failed scan and captures round trips', async (t) => {
  const listeners: (() => void)[] = []
  const fakeWatch = ((_path: string, listener: () => void) => {
    listeners.push(listener)
    const watcher = { on: () => watcher, close: () => {} }
    return watcher
  }) as unknown as typeof watch
  const f = await observed(t, { watch: fakeWatch })
  const next = await f.repo.commitTree(f.base, { one: 'changed\n' }, 'next')
  await f.repo.git('update-ref', 'refs/heads/main', next)
  f.observer.wake()
  await f.observer.idle()
  await f.repo.git('update-ref', 'refs/heads/topic', next)

  const release = deferred()
  const open = fs.open
  let held = false
  let delivered = false
  let failedOpen: string | undefined
  const opening = t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    if (!held && args[0] === join(f.repo.dir, '.git/refs/heads/topic')) {
      held = true
      await release.promise
    }
    try {
      return await open(...args)
    } catch (error) {
      if (args[0] === join(f.repo.dir, '.git/refs/heads/topic')) failedOpen = (error as NodeJS.ErrnoException).code
      throw error
    }
  })
  syncBuiltinESMExports()
  t.after(() => { opening.mock.restore(); syncBuiltinESMExports() })
  // Guard a broken reproduction as well as the promises held by the test.
  t.after(() => release.resolve())
  f.observer.wake()
  try {
    await waitUntil(() => held, 'loose topic open after its metadata check')
    await f.repo.git('update-ref', '-m', 'first rewind', 'refs/heads/main', f.base)
    await f.repo.git('update-ref', 'refs/heads/main', next)
    await f.repo.git('update-ref', '-m', 'second rewind', 'refs/heads/main', f.base)
    await f.repo.git('tag', 'light', next)
    await f.repo.git('tag', '-a', 'annotated', '-m', 'tag', next)
    await f.repo.git('pack-refs', '--all')
    const wake = f.observer.wake.bind(f.observer)
    t.mock.method(f.observer, 'wake', () => { wake(); delivered = true })
    // A busy watcher can coalesce all of these writes into one notification.
    listeners[0]!()
    await waitUntil(() => delivered, 'coalesced watch delivery during the blocked scan')
  } finally {
    release.resolve()
  }
  await f.observer.idle()
  assert.equal(failedOpen, 'ENOENT', 'pack-refs removed the loose ref between lstat and open')
  assert.ok(f.problems.includes('history-gap'), 'pruning really failed the in-flight read')
  const entries = (await f.journal.read()).entries
  const checkpoint = readCheckpoint(entries) as WorkerCheckpoint
  assert.ok(checkpoint.refs.some(([ref]) => ref === 'refs/heads/topic'), 'the queued watch must capture the packed topic')
  for (const ref of ['refs/tags/light', 'refs/tags/annotated']) {
    assert.ok(checkpoint.refs.some(([name]) => name === ref), `capture ${ref}`)
  }
  assert.equal(entries.filter((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string }).ref === 'refs/heads/main' &&
    (entry.value as { before: string }).before === next &&
    (entry.value as { after: string }).after === f.base &&
    (entry.value as { recordedAt: number | null }).recordedAt !== null).length, 2, 'retain both rewinds from the reflog')
  await f.repo.git('update-ref', '-d', 'refs/heads/topic')
  listeners[0]!()
  await waitUntil(async () => (await f.journal.read()).entries.some((entry) => entry.kind === 'ref' &&
    (entry.value as { ref: string; after: string | null }).ref === 'refs/heads/topic' &&
    (entry.value as { after: string | null }).after === null), 'packed topic deletion')
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
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
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
      clock += 6000
      return { sha, tree: sha, parents: [parent] }
    },
    kinds: async (shas) => new Map(shas.map((sha) => [sha, 'commit'])),
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], batch: (_signal, work) => work(fake), close: async () => { controller.resolve() },
  }
  const handle = await admitProject(f.repo.dir, f.repo.stateDir, [f.repo.dir])
  t.after(() => gitReader(handle).close())
  const observer = new RefObserver({ git: fake, journal: f.journal, changed: () => {}, problem: () => {}, pollMs: 60000 })
  t.after(() => observer.close())
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
  options: {
    readonly invalidCwds?: (nested: string) => readonly string[]
    readonly seatAtRoot?: boolean
    readonly malformedSibling?: boolean
    readonly malformedSeatSibling?: boolean
  } = {},
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
    checkout: { cwd: options.seatAtRoot ? checkout : nested, project: repo.dir, branch: 'main', head: base },
    session: { runtime: 'fixture', sessionId: 'nested-session' }, board: null, role: null,
    openedAt: 1, closed: null,
  }
  const invalidSeats = (options.invalidCwds?.(nested) ?? []).map((cwd, index): SeatRecord => ({
    ...seat,
    id: `invalid-seat-${index}`,
    checkout: { ...seat.checkout, cwd },
    session: { runtime: 'fixture', sessionId: `invalid-session-${index}` },
  }))
  const { closed, ...opening } = seat
  void closed
  await store.append(repo.dir, 'seats', [
    ...invalidSeats.map(({ closed: _closed, ...record }) => ({ type: 'seat' as const, record })),
    { type: 'seat', record: opening },
  ])
  await store.append(repo.dir, 'evidence', [
    ...invalidSeats.map((invalid, index) => ({ type: 'evidence' as const, record: {
      id: `invalid-fact-${index}`, seat: invalid.id, checkout: { cwd: invalid.checkout.cwd, branch: 'main' }, observedAt: 10,
      fact: { kind: 'diff' as const, from: base, to: first, files: 1, added: 1, removed: 1 },
    } })),
    { type: 'evidence', record: {
    id: 'nested-fact', seat: seat.id, checkout: { cwd: nested, branch: 'main' }, observedAt: 10,
    fact: { kind: 'diff', from: base, to: first, files: 1, added: 1, removed: 1 },
  } },
  ])
  if (options.malformedSeatSibling) {
    await appendFile(join(store.folderOf(repo.dir), 'seats.ndjson'),
      `{malformed\n${JSON.stringify({ v: 1, type: 'seat', record: { ...opening, id: 'malformed-seat', openedAt: 'unreadable' } })}\n`,
    )
    const seatRead = await store.read(repo.dir, 'seats')
    assert.equal(seatRead.skipped, 2, 'both malformed JSON and an invalid Seat opening are skipped')
    assert.deepEqual(seatRead.lines.map(line => line.type === 'seat' ? line.record.id : null), [seat.id])
    assert.equal((await store.read(repo.dir, 'evidence')).skipped, 0, 'only Seat records are damaged')
  }
  if (options.malformedSibling) await appendFile(join(store.folderOf(repo.dir), 'evidence.ndjson'), '{malformed\n')
  const seats = new Map([...invalidSeats, seat].map((record) => [record.id, record]))
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: (id: string) => seats.get(id) ?? null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => roots, push: () => {}, log: () => {},
  })
  t.after(() => plane.close())
  await plane.start()
  await waitUntil(async () => (await plane.status(repo.dir).catch(() => []))[0]?.project === repo.dir, 'canonical project registration')
  await waitUntil(async () => (await plane.read(repo.dir, [first])).commits[0]?.state === 'attributed', 'nested checkout attribution')
  const result = (await plane.read(repo.dir, [first])).commits[0]!
  assert.deepEqual(result.seats.map((item) => item.id), [seat.id])
  assert.deepEqual(result.evidenceIds, ['nested-fact'])
  if (options.malformedSibling || options.malformedSeatSibling) {
    const health = (await plane.status(repo.dir))[0]!
    assert.equal(health.state, 'degraded')
    assert.match(health.reason, /evidence/i)
    if (options.malformedSeatSibling) {
      assert.equal(health.reason, 'Some local evidence records could not be read.')
      assert.equal(health.nextStep, 'Repair the local evidence and retry capture.')
    }
  }
}

test('a nested ordinary checkout CWD is admitted through its canonical checkout root for attribution', async (t) => {
  const repo = await makeRepo()
  await assertNestedCheckoutAttribution(t, repo, repo.dir, [repo.dir])
})

test('a root Seat matches a nested ordinary-checkout fact through the canonical checkout identity', async (t) => {
  const repo = await makeRepo()
  await assertNestedCheckoutAttribution(t, repo, repo.dir, [repo.dir], { seatAtRoot: true })
})

test('a nested linked-worktree CWD is admitted through its canonical checkout root for attribution', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const linked = join(repo.stateDir, 'linked-checkout')
  await repo.git('worktree', 'add', '--detach', linked, base)
  await assertNestedCheckoutAttribution(t, repo, linked, [repo.dir, linked])
})

test('a root Seat matches a nested linked-worktree fact through the canonical checkout identity', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  await repo.git('update-ref', 'refs/heads/main', base)
  const linked = join(repo.stateDir, 'linked-checkout')
  await repo.git('worktree', 'add', '--detach', linked, base)
  await assertNestedCheckoutAttribution(t, repo, linked, [repo.dir, linked], { seatAtRoot: true })
})

test('malformed and relative stored CWDs skip without blocking canonical nested attribution', async (t) => {
  const repo = await makeRepo()
  await assertNestedCheckoutAttribution(t, repo, repo.dir, [repo.dir], {
    invalidCwds: (nested) => [relative(process.cwd(), nested), `${nested}\0`],
  })
})

test('a malformed sibling evidence row degrades capture without blocking valid attribution', async (t) => {
  const repo = await makeRepo()
  await assertNestedCheckoutAttribution(t, repo, repo.dir, [repo.dir], { malformedSibling: true })
})

test('malformed sibling Seat records degrade capture without blocking valid attribution', async (t) => {
  const repo = await makeRepo()
  await assertNestedCheckoutAttribution(t, repo, repo.dir, [repo.dir], { malformedSeatSibling: true })
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
    kinds: async (shas) => new Map(shas.map((sha) => [sha, 'commit'])),
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], batch: (_signal, work) => work(fake), close: async () => {},
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

test('a failed parent read retries the ancestry of an appended tip on the same observer', async (t) => {
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const tip = 'a'.repeat(40)
  const parent = 'b'.repeat(40)
  const root = 'c'.repeat(40)
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const reads: string[] = []
  const problems: string[] = []
  let fail = true
  const git: GitReader = {
    snapshot: async () => ({ refs: new Map([['refs/heads/main', tip]]), heads: new Map(), takenAt: 10 }),
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commit: async (sha) => {
      reads.push(sha)
      if (sha === parent && fail) throw new Error('injected-parent-read')
      return { sha, tree: sha, parents: sha === tip ? [parent] : sha === parent ? [root] : [] }
    },
    kinds: async (shas) => new Map(shas.map((sha) => [sha, 'commit'])),
    patch: async () => ({ stable: '', exact: '', files: [] }), files: async () => [],
    ancestors: async () => [], batch: (_signal, work) => work(git), close: async () => {},
  }
  const noWatch = (() => { const watcher = { on: () => watcher, close: () => {} }; return watcher }) as unknown as typeof watch
  const observer = new RefObserver({ git, journal, changed: () => {}, problem: (_kind, reason) => problems.push(reason),
    now: () => 10, pollMs: 0, watch: noWatch })
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  assert.deepEqual(problems, ['history-gap'])
  assert.equal(observer.checkpoint, null, 'the failed scan acknowledged no cursor')
  assert.deepEqual((await journal.read()).entries.filter((entry) => entry.kind === 'commit')
    .map((entry) => (entry.value as { sha: string }).sha), [tip], 'the tip was durable before the parent read failed')
  fail = false
  observer.wake()
  await observer.idle()
  const entries = (await journal.read()).entries
  assert.deepEqual(entries.filter((entry) => entry.kind === 'commit').map((entry) => (entry.value as { sha: string }).sha),
    [tip, parent, root], 'retry must rediscover every parent without restarting the observer')
  assert.deepEqual((readCheckpoint(entries) as WorkerCheckpoint).frontier, [])
  const count = reads.length
  observer.request([tip])
  await observer.idle()
  assert.equal(reads.length, count, 'only a successful scan can cache completed ancestry')
})
