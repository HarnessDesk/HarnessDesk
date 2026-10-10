import assert from 'node:assert/strict'
import { watch } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SeatRecord } from '@harnessdesk/protocol'
import type { GitReader } from '../src/provenance/git.js'
import { admitProject, gitReader } from '../src/provenance/git.js'
import { captureHealth } from '../src/provenance/health.js'
import { digest, ProvenanceJournal, readCheckpoint, writeCheckpoint } from '../src/provenance/journal.js'
import { RefObserver, type WorkerCheckpoint } from '../src/provenance/observer.js'
import { makeRepo, scriptedGit } from './fixtures/provenance-repo.js'
import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { reconcileProject, rangeSource, rangeCandidates, type CommitObservation, type LinkObservation, type RangeObservation } from '../src/provenance/reconcile.js'

const DAY = 86400000
const sha = (n: number) => n.toString(16).padStart(40, '0')
const firstOpened = 450 * DAY
const noWatch = (() => { const watcher = { on: () => watcher, close: () => {} }; return watcher }) as unknown as typeof watch

const history = () => {
  const fingerprinted: string[] = []
  const excluded: string[] = []
  const git: GitReader = {
    snapshot: async () => ({ refs: new Map([['refs/heads/main', sha(500)]]), heads: new Map(), takenAt: firstOpened }),
    reflogs: async () => ({ moves: [], cursors: new Map(), gaps: [], more: false }),
    commit: async (id) => ({ sha: id, tree: id, parents: Number.parseInt(id, 16) > 1 ? [sha(Number.parseInt(id, 16) - 1)] : [], committedAt: Number.parseInt(id, 16) * DAY }),
    kinds: async (ids) => new Map(ids.map((id) => [id, 'commit'])),
    patch: async (_from, to) => { fingerprinted.push(to); return { stable: sha(1000), exact: sha(1001), files: ['file'] } },
    files: async () => [{ path: 'file', stable: sha(1000), exact: sha(1001) }],
    ancestors: async () => [], batch: (_signal, work) => work(git), close: async () => {},
  }
  return { git, fingerprinted, excluded }
}

test('a wider local Seat window lets History retry detached excluded commits without a capture toggle', async (t) => {
  const repo = await makeRepo()
  await writeFile(join(repo.dir, '.git/refs/heads/main'), `${sha(500)}\n`)
  const store = new EvidenceStore(repo.stateDir)
  const file = join(store.folderOf(repo.dir), 'provenance.ndjson')
  const script = scriptedGit()
  const fingerprinted: string[] = []
  const run: typeof script.run = async (executable, args, options) => {
    if (args.includes('log')) {
      const ids = options.input!.toString('utf8').trim().split('\n')
      return Buffer.from(`${ids.map((id) => `${id} ${Number.parseInt(id, 16) * DAY / 1000}`).join('\n')}\n`)
    }
    const at = args.indexOf('cat-file')
    if (at >= 0 && args[at + 1] === 'commit') {
      const id = args[at + 2]!
      // Independent roots: the detached request cannot be rediscovered from main.
      return Buffer.from(`tree ${id}\ncommitter Jane Doe <dev@example.com> ${Number.parseInt(id, 16) * DAY / 1000} +0000\n\nfixture\n`)
    }
    if (args.includes('diff-tree')) fingerprinted.push(args.findLast((arg) => /^[a-f0-9]{40}$/.test(arg))!)
    return script.run(executable, args, options)
  }
  let notify = () => {}
  const nextScan = () => new Promise<void>((resolve) => { notify = resolve })
  const plane = new ProvenancePlane({ evidence: { store } as EvidencePlane, stateDir: repo.stateDir,
    projects: () => [repo.dir], reader: { run }, now: () => firstOpened, log: () => {},
    push: (notice) => {
      if (notice.method === 'provenance/changed' && notice.params.health.state === 'healthy' && notice.params.health.pending === 0) notify()
    },
  })
  t.after(() => plane.close())
  const ready = nextScan()
  await plane.start()
  await ready
  const ids = [sha(440), sha(400)]
  const excluded = nextScan()
  assert.ok((await plane.read(repo.dir, ids)).commits.every((commit) => commit.state === 'pending'))
  await excluded
  assert.ok((await plane.read(repo.dir, ids)).commits.every((commit) => commit.reason === 'not-observed'))
  assert.ok(!fingerprinted.includes(sha(440)))
  const opening: Omit<SeatRecord, 'closed'> = {
    id: 'earlier-seat', agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: 'Recorded Seat', passedOver: [],
    standing: { kind: 'permission', permission: 'read' }, ceiling: null,
    checkout: { cwd: repo.dir, project: repo.dir, branch: 'topic', head: null },
    session: { runtime: 'fixture', sessionId: 'session-earlier' }, board: null, role: null, openedAt: 430 * DAY,
  }
  await store.append(repo.dir, 'seats', [{ type: 'seat', record: opening }])
  // The evidence wake reads the Seat; the next wake evaluates the wider floor.
  for (let wake = 0; wake < 2; wake += 1) {
    const scanned = nextScan()
    plane.evidenceChanged(repo.dir)
    await scanned
  }
  assert.equal((readCheckpoint((await new ProvenanceJournal(file).read()).entries) as WorkerCheckpoint).historyFloor, 429 * DAY)
  const retried = nextScan()
  assert.equal((await plane.read(repo.dir, [sha(440)])).commits[0]!.state, 'pending', 'an old exclusion must not suppress the now-eligible request')
  await retried
  assert.ok(fingerprinted.includes(sha(440)))
  assert.equal((await plane.read(repo.dir, [sha(440)])).commits[0]!.reason, 'no-seat-evidence')
  const stillOld = nextScan()
  assert.equal((await plane.read(repo.dir, [sha(400)])).commits[0]!.state, 'pending')
  await stillOld
  assert.equal((await plane.read(repo.dir, [sha(400)])).commits[0]!.reason, 'not-observed')
  assert.ok(!fingerprinted.includes(sha(400)))
  assert.equal((await plane.status(repo.dir))[0]!.state, 'healthy')
})

test('a 500-commit repository opened at 450 captures the recent window and stops at its floor', async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const f = history()
  const options = { git: f.git, journal, changed: () => {}, problem: () => {}, pollMs: 0, watch: noWatch, now: () => firstOpened,
    openedAt: firstOpened, historyFloor: () => firstOpened - DAY, outsideWindow: (id: string) => f.excluded.push(id) }
  const observer = new RefObserver(options)
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  assert.equal(f.fingerprinted.length, 52, '449 through 500, including the one-day margin')
  assert.ok(f.fingerprinted.every((id) => Number.parseInt(id, 16) >= 449))
  assert.ok(f.excluded.includes(sha(448)))
  const read = await journal.read()
  assert.equal(read.entries.filter((entry) => entry.kind === 'commit').length, 52)
  const checkpoint = readCheckpoint(read.entries) as WorkerCheckpoint
  assert.deepEqual(checkpoint.frontier, [])
  assert.equal(captureHealth({ project: '/work/project', enabled: true, fatal: false, issues: [], checkedAt: checkpoint.scanStartedAt,
    lastCapturedAt: checkpoint.capturedThrough, pending: checkpoint.frontier.length, gaps: 0, revision: 1 }).state, 'healthy')
  const count = f.fingerprinted.length
  observer.request([sha(100)])
  await observer.idle()
  assert.equal(f.fingerprinted.length, count, 'an explicit old History request also respects the floor')
  assert.ok(f.excluded.includes(sha(100)), 'the caller can clear its pending read')
})

test('an earlier Seat extends the floor and a saved opening time survives restart', async (t) => {
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const f = history()
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const options = { git: f.git, journal, changed: () => {}, problem: () => {}, pollMs: 0, watch: noWatch,
    now: () => firstOpened, openedAt: firstOpened, historyFloor: () => 430 * DAY - DAY }
  const observer = new RefObserver(options)
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  assert.equal(f.fingerprinted.length, 72)
  const checkpoint = readCheckpoint((await journal.read()).entries) as WorkerCheckpoint & { openedAt: number; historyFloor: number }
  assert.equal(checkpoint.openedAt, firstOpened)
  assert.equal(checkpoint.historyFloor, 429 * DAY)
  await observer.close()
  const resumedOptions = { git: f.git, journal, changed: () => {}, problem: () => {}, pollMs: 0, watch: noWatch,
    now: () => firstOpened + 100 * DAY, openedAt: firstOpened + 100 * DAY }
  const resumed = new RefObserver(resumedOptions)
  t.after(() => resumed.close())
  await resumed.start(handle, checkpoint)
  resumed.request([sha(420)])
  await resumed.idle()
  assert.equal(f.fingerprinted.length, 72)
})

for (const restart of [false, true]) test(`lowering the floor reseeds unchanged refs ${restart ? 'after restart' : 'on the same observer'}`, async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const f = history()
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  let floor = 449 * DAY
  const options = { git: f.git, journal, changed: () => {}, problem: () => {}, pollMs: 0, watch: noWatch,
    now: () => firstOpened, openedAt: firstOpened, historyFloor: () => floor }
  let observer = new RefObserver(options)
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  assert.equal(f.fingerprinted.length, 52)
  const saved = readCheckpoint((await journal.read()).entries) as WorkerCheckpoint
  assert.deepEqual(saved.frontier, [])
  floor = 429 * DAY
  if (restart) {
    await observer.close()
    observer = new RefObserver({ ...options, openedAt: firstOpened + 100 * DAY })
    await observer.start(handle, saved)
  } else observer.wake()
  await observer.idle()
  assert.equal(f.fingerprinted.length, 72, 'the newly eligible ancestry is captured without any ref move or History request')
  assert.ok(f.fingerprinted.includes(sha(429)))
  const checkpoint = readCheckpoint((await journal.read()).entries) as WorkerCheckpoint
  assert.equal(checkpoint.historyFloor, floor)
  assert.equal(checkpoint.openedAt, firstOpened)
  assert.deepEqual(observer.checkpoint!.frontier, [])
  assert.ok(checkpoint.frontier.every((id) => Number.parseInt(id, 16) * DAY < floor),
    'only disposable below-floor work may remain in the saved cursor')
  observer.wake()
  await observer.idle()
  assert.equal(f.fingerprinted.length, 72, 'unchanged floor does not repeat discovery')
})

for (const mode of ['live', 'restart', 'legacy']) test(`a wider window walks already observed tag-only ancestry: ${mode}`, async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const f = history()
  const tag = sha(900)
  const target = sha(460)
  const git: GitReader = {
    ...f.git,
    snapshot: async () => ({ refs: new Map([['refs/heads/main', sha(500)], ['refs/tags/only-tag', tag]]), heads: new Map(), takenAt: firstOpened }),
    commit: async (id, signal) => id === tag ? null : id === sha(500)
      ? { sha: id, tree: id, parents: [], committedAt: 500 * DAY } : f.git.commit(id, signal),
    ancestors: async () => [target],
    batch: (_signal, work) => work(git),
  }
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  let floor = 449 * DAY
  const options = { git, journal, changed: () => {}, problem: () => {}, watch: noWatch, pollMs: 0,
    now: () => firstOpened, openedAt: firstOpened, historyFloor: () => floor }
  let observer = new RefObserver(options)
  t.after(() => observer.close())
  await observer.start(handle, null)
  await observer.idle()
  assert.ok(f.fingerprinted.includes(target), 'the tag target is already journalled')
  assert.ok(!f.fingerprinted.includes(sha(440)), 'its older parents start outside the window')
  const saved = readCheckpoint((await journal.read()).entries) as WorkerCheckpoint
  floor = 429 * DAY
  if (mode !== 'live') {
    await observer.close()
    const checkpoint = mode === 'legacy' ? { ...saved, openedAt: undefined, historyFloor: undefined } : saved
    await writeCheckpoint(journal, checkpoint)
    observer = new RefObserver(options)
    await observer.start(handle, readCheckpoint((await journal.read()).entries) as WorkerCheckpoint)
  } else observer.wake()
  await observer.idle()
  assert.ok(f.fingerprinted.includes(sha(440)), 'only the tag reaches this newly eligible ancestor')
  assert.ok(f.fingerprinted.includes(sha(429)), 'tag ancestry walks all the way to the wider floor')
  assert.equal(f.fingerprinted.filter((id) => id === target).length, 1, 'the target is walked without fingerprinting it again')
  assert.deepEqual(observer.checkpoint!.frontier, [])
  assert.equal(observer.checkpoint!.historyFloor, floor)
})

for (const restart of [false, true]) test(`two projects with shared commits and different floors drain their own batches${restart ? ' across a restart' : ''}`, async (t) => {
  t.mock.method(performance, 'now', () => 0)
  const f = history()
  const narrow = await makeRepo()
  const wide = await makeRepo()
  const narrowHandle = await admitProject(narrow.dir, narrow.stateDir, [narrow.dir])
  const wideHandle = await admitProject(wide.dir, wide.stateDir, [wide.dir])
  t.after(async () => { await gitReader(narrowHandle).close(); await gitReader(wideHandle).close() })
  const narrowJournal = new ProvenanceJournal(join(narrow.stateDir, 'provenance.ndjson'))
  const wideJournal = new ProvenanceJournal(join(wide.stateDir, 'provenance.ndjson'))
  const problems: string[] = []
  const options = { git: f.git, problem: (_kind: string, reason: string) => problems.push(reason), watch: noWatch, pollMs: 0,
    now: () => firstOpened, openedAt: firstOpened }
  const other = new RefObserver({ ...options, journal: narrowJournal, changed: () => {}, historyFloor: () => 449 * DAY })
  t.after(() => other.close())
  await other.start(narrowHandle, null)
  await other.idle()
  assert.equal((await narrowJournal.read()).entries.filter((entry) => entry.kind === 'commit').length, 52)
  const batches: number[] = []
  let closing: Promise<void> | undefined
  let observer: RefObserver
  const wideOptions = { ...options, journal: wideJournal, historyFloor: () => 249 * DAY,
    changed: () => {
      batches.push(observer.checkpoint!.frontier.length)
      if (restart && batches.length === 1) closing = observer.close()
    },
  }
  observer = new RefObserver(wideOptions)
  t.after(() => observer.close())
  await observer.start(wideHandle, null)
  await observer.idle()
  if (restart) {
    await closing
    const saved = readCheckpoint((await wideJournal.read()).entries) as WorkerCheckpoint
    assert.equal((await wideJournal.read()).entries.filter((entry) => entry.kind === 'commit').length, 200)
    observer = new RefObserver(wideOptions)
    await observer.start(wideHandle, saved)
    await observer.idle()
  }
  assert.equal((await wideJournal.read()).entries.filter((entry) => entry.kind === 'commit').length, 252)
  assert.deepEqual(batches, [1, 0], 'each project makes bounded progress even when another has seen the same IDs')
  assert.deepEqual(problems, [])
  const checkpoint = observer.checkpoint!
  assert.equal(captureHealth({ project: wide.dir, enabled: true, fatal: false, issues: problems, checkedAt: checkpoint.scanStartedAt,
    lastCapturedAt: checkpoint.capturedThrough, pending: checkpoint.frontier.length, gaps: 0, revision: 1 }).state, 'healthy')
})

for (const legacy of [false, true]) test(`a long below-floor frontier drains in one batch without checkpoint churn${legacy ? ' on upgrade' : ''}`, async (t) => {
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  t.after(() => gitReader(handle).close())
  const journal = new ProvenanceJournal(join(repo.stateDir, 'provenance.ndjson'))
  const frontier = Array.from({ length: 350 }, (_, n) => sha(n + 1))
  const saved: WorkerCheckpoint = { generation: 1, refs: [['refs/heads/main', sha(350)]], heads: [], logs: [],
    frontier, openedAt: firstOpened, historyFloor: legacy ? undefined : 449 * DAY, capturedThrough: 0, scanStartedAt: firstOpened,
    baseline: [sha(350)], rangeKeys: Array.from({ length: 13000 }, (_, n) => `range-${n}`), rangePending: [] }
  await writeCheckpoint(journal, saved)
  const checkpointWrites = t.mock.method(journal, 'checkpoint', async () => {})
  const batches: string[][] = []
  const excluded: string[] = []
  let scans = 0
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  const f = history()
  const git = { ...f.git,
    snapshot: async () => ({ refs: new Map(saved.refs), heads: new Map(), takenAt: firstOpened }),
    // Advancing controlled time would allow only one object per old scan.
    commit: async (id: string) => { clock += 100; return f.git.commit(id, new AbortController().signal) },
    commitTimes: async (ids: readonly string[]) => { batches.push([...ids]); return new Map(ids.map((id) => [id, Number.parseInt(id, 16) * DAY])) },
    batch: <T>(_signal: AbortSignal, work: (reader: GitReader) => Promise<T>): Promise<T> => work(git),
  }
  const observer = new RefObserver({ git, journal, changed: () => { scans += 1 }, problem: () => {}, watch: noWatch, pollMs: 0,
    now: () => firstOpened, openedAt: firstOpened, historyFloor: () => 449 * DAY, outsideWindow: (id) => excluded.push(id) })
  t.after(() => observer.close())
  await observer.start(handle, saved)
  await observer.idle()
  assert.equal(scans, 1, 'every below-floor entry is discarded in one scan')
  assert.deepEqual(batches, [frontier])
  assert.deepEqual(excluded, frontier)
  assert.equal(f.fingerprinted.length, 0)
  const writes = legacy ? 1 : 0
  assert.equal(checkpointWrites.mock.callCount(), writes, 'only a newly introduced floor needs one checkpoint')
  if (legacy) assert.deepEqual((checkpointWrites.mock.calls[0]!.arguments[0] as WorkerCheckpoint).frontier, [])
  assert.deepEqual(observer.checkpoint!.frontier, [])
  assert.deepEqual(readCheckpoint((await journal.read()).entries), JSON.parse(JSON.stringify(saved)),
    'the durable cursor safely retains only disposable work')
  observer.wake()
  await observer.idle()
  assert.equal(checkpointWrites.mock.callCount(), writes, 'an unchanged later scan does not write the discarded frontier')
})

test('the Git reader extracts only the commit time needed for the horizon', async (t) => {
  const repo = await makeRepo()
  const tree = await repo.git('mktree')
  const commit = await repo.input(['hash-object', '-t', 'commit', '-w', '--stdin'], `tree ${tree}\nauthor Jane Doe <dev@example.com> 100 +0000\ncommitter Jane Doe <dev@example.com> 200 +0000\n\nfixture\n`)
  const reader = gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]))
  t.after(() => reader.close())
  const value = await reader.commit(commit, new AbortController().signal) as { committedAt?: number }
  assert.equal(value.committedAt, 200000)
  assert.deepEqual(Object.keys(value).sort(), ['committedAt', 'parents', 'sha', 'tree'])
})


test('a legacy desk opens, compacts, preserves decisions and finishes an old unfinished walk', { timeout: 20000 }, async (t) => {
  const repo = await makeRepo()
  await writeFile(join(repo.dir, '.git/refs/heads/main'), `${sha(500)}\n`)
  const store = new EvidenceStore(repo.stateDir)
  await mkdir(store.folderOf(repo.dir), { recursive: true })
  const file = join(store.folderOf(repo.dir), 'provenance.ndjson')
  let seq = 0
  const lines: string[] = []
  const append = (kind: string, value: unknown): number => {
    const body = { version: 1, seq: ++seq, kind, value }
    lines.push(JSON.stringify({ ...body, checksum: digest(body) }))
    return seq
  }
  const commits: CommitObservation[] = Array.from({ length: 100 }, (_, n) => ({
    id: `commit-${n}`, sha: sha(401 + n), tree: sha(n + 1), parents: [sha(400 + n)], firstSeenAt: firstOpened,
    fingerprintVersion: 1, discoveredBy: [], checkoutHints: [repo.dir], window: { from: null, to: firstOpened },
    patch: { stable: sha(6000 + n), exact: sha(6000 + n), files: ['file'] }, files: [{ path: 'file', stable: sha(6000 + n), exact: sha(6000 + n) }], why: null,
  }))
  const links: LinkObservation[] = commits.map((c, n) => ({ id: `link-${n}`, sha: c.sha, seats: [], sourceIds: [], evidenceIds: [], retainedPaths: [], coverage: 'none', via: null, reason: 'no-seat-evidence', at: firstOpened }))
  const ranges: RangeObservation[] = Array.from({ length: 200 }, (_, n) => ({ id: `range-${n}`, from: sha(300), to: commits[n % commits.length]!.sha,
    commits: [commits[n % commits.length]!.sha], patch: { stable: sha(7000 + n), exact: sha(7000 + n), files: ['file'] }, seats: [], ambiguous: true, at: firstOpened }))
  for (const value of commits) append('commit', value)
  for (const value of links) append('link', value)
  for (const value of ranges) append('range', value)
  const offered = rangeCandidates(commits, new Set())
  const rangeKeys = [...offered.ready.map((range) => range.key), ...offered.pending.filter((key) => !key.startsWith('limit:'))]
  const limits = offered.pending.filter((key) => key.startsWith('limit:'))
  for (let generation = 1; generation <= 30; generation += 1) {
    const value = { generation, refs: [['refs/heads/main', sha(500)]], heads: [[repo.dir, sha(500)]], logs: [], frontier: [sha(300)],
      capturedThrough: firstOpened, scanStartedAt: firstOpened, rangeKeys, rangePending: limits, baseline: [sha(500)] }
    const bytes = JSON.stringify(value)
    const hash = digest(value)
    const parts = []
    for (let offset = 0; offset < bytes.length; offset += 12000) parts.push(append('cursor', { id: digest(['part', hash, offset]), type: 'part', bytes: bytes.slice(offset, offset + 12000) }))
    append('cursor', { id: digest(['checkpoint', hash]), type: 'checkpoint', parts, hash })
  }
  await writeFile(file, `${lines.join('\n')}\n`)
  const beforeBytes = (await stat(file)).size
  const input = { commits, priorLinks: links, sources: ranges.map((range) => rangeSource(range, links)), moves: [], now: firstOpened }
  assert.deepEqual(await reconcileProject(input, {} as GitReader, new AbortController().signal), [])
  const script = scriptedGit()
  let fingerprinted = 0
  const run: typeof script.run = async (executable, args, options) => {
    if (args.includes('log')) {
      const ids = options.input!.toString('utf8').trim().split('\n')
      return Buffer.from(`${ids.map((id) => `${id} ${Number.parseInt(id, 16) * DAY / 1000}`).join('\n')}\n`)
    }
    const at = args.indexOf('cat-file')
    if (at >= 0 && args[at + 1] === 'commit') {
      const id = args[at + 2]!
      const n = Number.parseInt(id, 16)
      return Buffer.from(`tree ${id}\nparent ${sha(n - 1)}\ncommitter Jane Doe <dev@example.com> ${n * DAY / 1000} +0000\n\nfixture\n`)
    }
    if (args.includes('diff-tree')) fingerprinted += 1
    return script.run(executable, args, options)
  }
  let settled!: () => void
  const current = new Promise<void>((resolve) => { settled = resolve })
  let notify = settled
  const plane = new ProvenancePlane({ evidence: { store } as EvidencePlane, stateDir: repo.stateDir, projects: () => [repo.dir], reader: { run }, now: () => firstOpened,
    log: () => {}, push: (notice) => { if (notice.method === 'provenance/changed' && (notice.params.health.state === 'healthy' || notice.params.health.pending === limits.length)) notify() } })
  t.after(() => plane.close())
  await plane.start()
  await current
  assert.equal((await plane.status(repo.dir))[0]!.reason, 'Capture is current for the refs Git exposes.')
  assert.equal(fingerprinted, 0, 'the below-floor unfinished walk reads no patches')
  assert.ok((await stat(file)).size < beforeBytes / 4)
  const after = await new ProvenanceJournal(file).read()
  const afterLinks = after.entries.filter((entry) => entry.kind === 'link').map((entry) => entry.value as LinkObservation)
  assert.deepEqual(afterLinks, links)
  assert.deepEqual(await reconcileProject({ ...input, priorLinks: afterLinks }, {} as GitReader, new AbortController().signal), [])
  const checkpoint = readCheckpoint(after.entries) as WorkerCheckpoint
  assert.deepEqual(checkpoint.frontier, [])
  assert.equal(checkpoint.openedAt, firstOpened)
  const again = new Promise<void>((resolve) => { notify = resolve })
  assert.equal((await plane.read(repo.dir, [sha(300)])).commits[0]!.reason, 'not-observed')
  assert.equal((await plane.read(repo.dir, [sha(299)])).commits[0]!.state, 'pending')
  await again
  assert.equal((await plane.read(repo.dir, [sha(299)])).commits[0]!.reason, 'not-observed')
  assert.equal((await plane.status(repo.dir))[0]!.state, 'healthy')
  assert.ok((await readFile(file, 'utf8')).length > 0)
})
