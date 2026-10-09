import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'

import type { EvidenceRecord, SeatRecord } from '@harnessdesk/protocol'

import type { EvidencePlane } from '../src/evidence/plane.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { admitProject, gitReader, type GitReader, type ReaderOptions } from '../src/provenance/git.js'
import { ProvenanceJournal, type JournalEntry } from '../src/provenance/journal.js'
import { ProvenancePlane } from '../src/provenance/plane.js'
import { rangeCandidates, type CommitObservation, type LinkObservation, type RangeCandidate } from '../src/provenance/reconcile.js'
import { Reconciler, type Ranges, type Subject } from '../src/provenance/reconciler.js'
import { countingRunner, history, makeRepo, scriptedGit, type Counting, type Repo } from './fixtures/provenance-repo.js'

const signal = () => new AbortController().signal
const NOTHING: Ranges = { rangeKeys: [], rangePending: [] }
const settled = (pass: Ranges): boolean => !pass.rangePending.some((key) => !key.startsWith('limit:'))

const waitUntil = async (condition: () => boolean | Promise<boolean>, name: string): Promise<void> => {
  const deadline = Date.now() + 15000
  while (!await condition()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${name}`)
    await delay(20)
  }
}

/** Journal the observation capture would have made of each commit, with a reader of its own. */
const observe = async (repo: Repo, shas: readonly string[], journal: ProvenanceJournal, firstSeenAt = 100) => {
  const git = gitReader(await admitProject(repo.dir, repo.stateDir, [repo.dir]))
  try {
    let at = firstSeenAt
    for (const sha of shas) {
      const object = await git.commit(sha, signal())
      assert.ok(object)
      const from = object.parents[0] ?? null
      await journal.append('commit', {
        id: `commit-${sha}`, sha, tree: object.tree, parents: object.parents, firstSeenAt: at++,
        fingerprintVersion: 1, discoveredBy: [], checkoutHints: [repo.dir], window: { from: null, to: 1 },
        patch: await git.patch(from, sha, signal()), files: await git.files(from, sha, signal()), why: null,
      } satisfies CommitObservation)
    }
  } finally {
    await git.close()
  }
}

/** A Git object stops being readable: it is moved aside, as pruning would leave it. */
const lose = (repo: Repo, sha: string) =>
  rename(join(repo.dir, '.git/objects', sha.slice(0, 2), sha.slice(2)), join(repo.stateDir, `lost-${sha}`))

const subject = (
  repo: Repo, handle: Subject['handle'], journal: ProvenanceJournal,
  facts: readonly EvidenceRecord[] = [], seats: readonly SeatRecord[] = [],
): Subject => ({ project: repo.dir, handle, journal, facts, seats })

/** Every range a history offers, read the way a worker would: one page at a time. */
const allRanges = (commits: readonly CommitObservation[]): RangeCandidate[] => {
  const seen = new Set<string>()
  const found: RangeCandidate[] = []
  for (;;) {
    const page = rangeCandidates(commits, seen)
    if (!page.ready.length) return found
    for (const candidate of page.ready) {
      seen.add(candidate.key)
      found.push(candidate)
    }
  }
}

/** `length` commits in one first-parent line over a base nothing has seen. Later commits sort first, so a pass meets them first. */
const line = (length: number): CommitObservation[] => {
  const sha = (n: number) => `${String(9999 - n).padStart(4, '0')}${'a'.repeat(36)}`
  return Array.from({ length }, (_, index) => {
    const n = index + 1
    return {
      id: `commit-${n}`, sha: sha(n), tree: sha(n), parents: [n === 1 ? 'b'.repeat(40) : sha(n - 1)],
      firstSeenAt: n, fingerprintVersion: 1, discoveredBy: [], checkoutHints: [], window: { from: null, to: n },
      patch: { stable: sha(n), exact: sha(n), files: ['file'] },
      files: [{ path: 'file', stable: sha(n), exact: sha(n) }], why: null,
    }
  })
}

/** A journal that keeps its entries in memory: a pass over a long history need not wait for a disk to say it wrote them. */
const memoryJournal = () => {
  const entries: JournalEntry[] = []
  return {
    entries,
    append: async (kind: JournalEntry['kind'], value: unknown) => { entries.push({ seq: entries.length + 1, kind, value }); return entries.length },
    read: async () => ({ entries: [...entries], broken: false }),
  } as unknown as ProvenanceJournal & { readonly entries: JournalEntry[] }
}

/** A history that exists only in the journal, read through a reader whose Git is a script that counts. */
const scripted = async (t: TestContext, length: number) => {
  const repo = await makeRepo()
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const git = scriptedGit(5000)
  const reader = gitReader(handle, { run: git.run })
  t.after(() => reader.close())
  const commits = line(length)
  const journal = memoryJournal()
  for (const commit of commits) await journal.append('commit', commit)
  const reconciler = new Reconciler(() => {})
  const pass = async (checkpoint: Ranges, facts: readonly EvidenceRecord[] = []) =>
    reconciler.run(subject(repo, handle, journal, facts), journal.entries, checkpoint, reader, signal())
  return { repo, handle, git, reader, commits, journal, pass, written: () => journal.entries.length }
}
const count = (git: Counting, verb: string): number => git.verbs().filter((one) => one === verb).length

test('one pass reads a bounded number of ranges, however long the history', async (t) => {
  const f = await scripted(t, 40)
  assert.equal(allRanges(f.commits).length, 780, 'forty commits offer 780 contiguous ranges to read')
  const pass = await f.pass(NOTHING)
  const read = pass.rangeKeys.length
  assert.ok(read > 0 && read <= 128, `one pass read ${read} ranges`)
  assert.equal(count(f.git, 'diff-tree'), 2 * read, 'a range costs two diffs, and no more of them')
  assert.equal(count(f.git, 'patch-id'), 2 * read, 'and two patch fingerprints')
  assert.ok(f.git.started <= 5 * 128 + 24, `one pass started ${f.git.started} Git processes`)
  assert.ok(!settled(pass), 'what the pass left must be left for a later pass')
})

test('catching up reads every range in a few bounded passes, and then does nothing', async (t) => {
  const f = await scripted(t, 20)
  let checkpoint: Ranges = NOTHING
  let passes = 0
  let heaviest = 0
  do {
    const before = f.git.started
    checkpoint = await f.pass(checkpoint)
    heaviest = Math.max(heaviest, f.git.started - before)
    passes += 1
  } while (!settled(checkpoint) && passes < 10)
  assert.equal(checkpoint.rangeKeys.length, 190, 'twenty commits offer 190 ranges and every one was read')
  assert.equal(passes, 2)
  assert.ok(heaviest <= 5 * 128 + 24, `the heaviest pass started ${heaviest} Git processes`)
  assert.equal(count(f.git, 'diff-tree'), 2 * 190)
  const processes = f.git.started
  const entries = f.written()
  assert.deepEqual(await f.pass(checkpoint), checkpoint)
  assert.equal(f.git.started, processes, 'with everything read, a pass asks Git nothing')
  assert.equal(f.written(), entries, 'and records nothing')
})

test('ranges across a lost commit never keep the others waiting, and an unchanged journal is not read again for them', async (t) => {
  const f = await scripted(t, 30)
  const lost = f.commits[14]!.sha
  f.git.lose(lost)
  const everything = allRanges(f.commits)
  const unreadable = everything.filter((range) => [range.from, ...range.commits.map((part) => part.sha)].includes(lost))
  assert.ok(unreadable.length > 128, `${unreadable.length} ranges touch the lost commit: more than a pass reads`)
  let checkpoint: Ranges = NOTHING
  let passes = 0
  do {
    checkpoint = await f.pass(checkpoint)
    passes += 1
  } while (!settled(checkpoint) && passes < 8)
  assert.ok(passes <= 5, `${passes} passes`)
  assert.equal(checkpoint.rangeKeys.length, everything.length - unreadable.length, 'every range that can be read was read')
  assert.equal(checkpoint.rangePending.filter((key) => key.startsWith('limit:')).length, unreadable.length, 'and every other is named')
  const processes = f.git.started
  const entries = f.written()
  for (let wake = 0; wake < 3; wake += 1) assert.deepEqual(await f.pass(checkpoint), checkpoint)
  assert.equal(f.git.started, processes, 'ranges that cannot be read start no process while nothing changes')
  assert.equal(f.written(), entries)
})

test('facts whose objects are gone cost one process between them, not one each', async (t) => {
  const f = await scripted(t, 6)
  const [one, two, three, four, five, six] = f.commits.map((commit) => commit.sha) as [string, string, string, string, string, string]
  for (const sha of [four, five, six]) f.git.lose(sha)
  const facts: EvidenceRecord[] = []
  for (const to of [four, five, six]) {
    for (const from of [one, two, three]) {
      facts.push({
        id: `fact-${facts.length}`, seat: 'seat-unknown', checkout: { cwd: f.repo.dir, branch: 'main' }, observedAt: 10,
        fact: { kind: 'diff', files: 1, added: 1, removed: 1, from, to },
      })
    }
  }
  const problems: string[] = []
  const reconciler = new Reconciler((_kind, reason) => problems.push(reason))
  // No commit is observed here, so the pass has no ranges: what it starts is the facts' own.
  const pass = await reconciler.run(subject(f.repo, f.handle, f.journal, facts), [], NOTHING, f.reader, signal())
  assert.equal(f.git.started, 1, `nine facts about lost objects started ${f.git.started} Git processes`)
  assert.ok(problems.includes('history-gap'), 'and the gap is still reported')
  assert.deepEqual(pass, NOTHING)
})

test('a pass over an unchanged journal starts no Git process and writes nothing, even with ranges it cannot read', async (t) => {
  const repo = await makeRepo()
  const { shas } = await history(repo, 6)
  const journal = new ProvenanceJournal(join(repo.stateDir, 'journal.ndjson'))
  await observe(repo, shas, journal)
  await lose(repo, shas[2]!)
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const counted = countingRunner(2000)
  const reader = gitReader(handle, { run: counted.run })
  t.after(() => reader.close())
  // A fact for a span no observed commit matches, whose Seat is unknown: it names no source.
  const fact: EvidenceRecord = {
    id: 'fact-unowned', seat: 'seat-unknown', checkout: { cwd: repo.dir, branch: 'main' }, observedAt: 10,
    fact: { kind: 'diff', files: 1, added: 1, removed: 1, from: shas[0]!, to: shas[1]! },
  }
  const problems: string[] = []
  const reconciler = new Reconciler((_kind, reason) => problems.push(reason))
  const run = async (checkpoint: Ranges) =>
    reconciler.run(subject(repo, handle, journal, [fact]), (await journal.read()).entries, checkpoint, reader, signal())
  const first = await run(NOTHING)
  assert.equal(first.rangeKeys.length, 2, 'two of the fifteen ranges neither contain the lost commit nor start after it')
  assert.equal(first.rangePending.filter((key) => key.startsWith('limit:')).length, 13)
  assert.ok(problems.includes('history-gap'))
  const written = (await journal.read()).entries.length
  const started = counted.started
  const second = await run(first)
  assert.equal(counted.started, started, 'nothing it reads had changed, so it asks Git nothing')
  assert.equal((await journal.read()).entries.length, written, 'and records nothing')
  assert.deepEqual(second, first)
  // A new commit is a change: the pass runs again, and reads only what is new.
  const more = await history(repo, 1, 1, shas.at(-1)!)
  await observe(repo, more.shas, journal, 200)
  const third = await run(second)
  assert.ok(counted.started > started)
  assert.equal(third.rangeKeys.length - first.rangeKeys.length, 2, 'the new tip offers six ranges; four start after or contain the lost commit')
})

const seat = (repo: Repo, id: string): SeatRecord => ({
  id, agent: null, briefDigest: null, seat: { runtime: 'fixture' }, seatLabel: `Recorded ${id}`, passedOver: [],
  standing: { kind: 'permission', permission: 'read' }, ceiling: null,
  checkout: { cwd: repo.dir, project: repo.dir, branch: 'topic', head: null },
  session: { runtime: 'fixture', sessionId: `session-${id}` }, board: null, role: null, openedAt: 1, closed: null,
})

test('a squash is attributed to every Seat whose changes it kept, by the pass that reads its range', async (t) => {
  const repo = await makeRepo()
  const base = await repo.commitTree(null, { one: 'base\n' }, 'base')
  const first = await repo.commitTree(base, { one: 'base\nseat a\n' }, 'first')
  const second = await repo.commitTree(first, { one: 'base\nseat a\n', two: 'seat b\n' }, 'second')
  const squash = await repo.git('commit-tree', `${second}^{tree}`, '-p', base, '-m', 'squash')
  const journal = new ProvenanceJournal(join(repo.stateDir, 'journal.ndjson'))
  await observe(repo, [first, second, squash], journal)
  await journal.append('ref', { id: 'move-squash', ref: 'refs/heads/topic', checkout: null, before: second, after: squash, recordedAt: null })
  const handle = await admitProject(repo.dir, repo.stateDir, [repo.dir])
  const reader = gitReader(handle)
  t.after(() => reader.close())
  const diff = (id: string, owner: string, from: string, to: string): EvidenceRecord => ({
    id, seat: owner, checkout: { cwd: repo.dir, branch: 'topic' }, observedAt: 10,
    fact: { kind: 'diff', files: 1, added: 1, removed: 0, from, to },
  })
  const facts = [diff('fact-a', 'seat-a', base, first), diff('fact-b', 'seat-b', first, second)]
  const seats = [seat(repo, 'seat-a'), seat(repo, 'seat-b')]
  const reconciler = new Reconciler(() => {})
  let checkpoint: Ranges = NOTHING
  do {
    checkpoint = await reconciler.run(subject(repo, handle, journal, facts, seats), (await journal.read()).entries, checkpoint, reader, signal())
  } while (!settled(checkpoint))
  const links = (await journal.read()).entries.filter((entry) => entry.kind === 'link').map((entry) => entry.value as LinkObservation)
  const link = links.filter((one) => one.sha === squash).at(-1)
  assert.deepEqual(link?.seats, ['seat-a', 'seat-b'])
  assert.equal(link?.via, 'squash')
  assert.deepEqual(link?.evidenceIds, ['fact-a', 'fact-b'])
})

test('ranges that could not be read wait behind ranges that have not been tried', () => {
  const commits = line(40)
  const keys = allRanges(commits).map((range) => range.key)
  const failed = new Set(keys.slice(0, 300))
  const candidates = rangeCandidates(commits, new Set(), failed)
  assert.ok(candidates.ready.every((candidate) => !failed.has(candidate.key)), 'a range that failed is never offered as new')
  assert.ok(candidates.retry.length > 0 && candidates.retry.every((candidate) => failed.has(candidate.key)))
  assert.equal(candidates.ready.length, 256, 'ranges that failed take no places from the ones that have not been tried')
  assert.equal(
    candidates.ready.length + candidates.pending.filter((key) => !key.startsWith('limit:')).length,
    keys.length - failed.size,
    'every range that has not been tried is either offered or still pending',
  )
  const done = rangeCandidates(commits, new Set(keys), failed)
  assert.deepEqual([done.ready.length, done.retry.length], [0, 0], 'a range that was read is not retried either')
})

test('a pass yields to the event loop between batches of ranges', async () => {
  const commits = line(30)
  const entries: JournalEntry[] = commits.map((value, n) => ({ seq: n + 1, kind: 'commit', value }))
  // Everything here answers from memory, so the only turns the loop gets are the ones the pass gives it.
  const fake: GitReader = {
    snapshot: async () => { throw new Error('unused') }, reflogs: async () => { throw new Error('unused') },
    commit: async (id) => ({ sha: id, tree: id, parents: [] }),
    kinds: async (ids) => new Map(ids.map((id) => [id, 'commit'])),
    patch: async (from, to) => ({ stable: to, exact: from ?? to, files: ['f'] }),
    files: async () => [], ancestors: async () => [], batch: (_signal, work) => work(fake), close: async () => {},
  }
  const journal = { append: async () => {} } as unknown as ProvenanceJournal
  let turns = 0
  let running = true
  const probe = (async () => { while (running) { await tick(); turns += 1 } })()
  const pass = await new Reconciler(() => {}).run(
    { project: '/project', handle: null, journal, facts: [], seats: [] }, entries, NOTHING, fake, signal(),
  )
  running = false
  await probe
  const read = pass.rangeKeys.length
  assert.ok(read > 8, `${read} ranges were read`)
  assert.ok(turns >= Math.ceil(read / 8) - 1, `the loop got ${turns} turns while ${read} ranges were read in batches of eight`)
})

/** A plane over one project whose journal is already written: nothing is left for it to capture. */
const planeOver = async (repo: Repo, options: ReaderOptions) => {
  const store = new EvidenceStore(join(repo.stateDir, 'evidence'))
  const notices: number[] = []
  const plane = new ProvenancePlane({
    evidence: { store, seats: { byId: () => null } } as unknown as EvidencePlane,
    stateDir: repo.stateDir, projects: () => [repo.dir],
    push: (notice) => { if (notice.method === 'provenance/changed') notices.push(notice.params.health.checkedAt ?? 0) },
    log: () => {}, reader: options,
  })
  return { store, plane, notices }
}

test('waking capture over an unchanged journal starts no Git process and checks the metadata once', async (t: TestContext) => {
  const repo = await makeRepo()
  const { shas } = await history(repo, 6)
  await repo.git('update-ref', 'refs/heads/main', shas.at(-1)!)
  const counted = countingRunner(5000)
  let checks = 0
  const { store, plane, notices } = await planeOver(repo, { run: counted.run, validated: () => { checks += 1 } })
  await observe(repo, shas, new ProvenanceJournal(join(store.folderOf(repo.dir), 'provenance.ndjson')))
  await lose(repo, shas[2]!)
  t.after(() => plane.close())
  await plane.start()
  const checked = async () => (await plane.status(repo.dir).catch(() => []))[0]?.checkedAt ?? null
  await waitUntil(async () => await checked() !== null, 'the first scan')
  await delay(400)
  const baseline = (await checked())!
  let seen = baseline
  const since = notices.length
  const started = counted.started
  const verified = checks
  for (let wake = 1; wake <= 3; wake += 1) {
    await delay(10)
    plane.evidenceChanged(repo.dir)
    await waitUntil(async () => (await checked()) !== seen, `scan ${wake}`)
    seen = (await checked())!
  }
  await delay(50)
  assert.equal(counted.started, started, `idle scans started ${counted.started - started} Git processes: ${counted.verbs().slice(started).join(', ')}`)
  const scans = new Set(notices.slice(since).filter((at) => at > baseline)).size
  assert.ok(scans >= 3)
  assert.equal(checks - verified, scans, 'and each checked the metadata once')
  // Each scan still moved `checkedAt` (the loop above waited for that), though none wrote a checkpoint.
})
