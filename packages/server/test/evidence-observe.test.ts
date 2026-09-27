import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, type BoardEvidence, type GoalView, type Intent, type Session, type TeamState } from '@harnessdesk/protocol'

import { readPullRequest, type GhInCheckout } from '../src/evidence/forge.js'
import { Observer, OBSERVE_EVERY_MS } from '../src/evidence/observe.js'
import { EvidencePlane } from '../src/evidence/plane.js'
import { canonical } from '../src/evidence/revision.js'
import { EvidenceStore } from '../src/evidence/store.js'
import { evidenceDesk, makeRepo, until, writeAgent, type Repo } from './fixtures/evidence-desk.js'
import { tempDir } from './scratch.js'

/*
 * What the desk observes about a card's branch without being asked: its diff,
 * its pull request and the forge's checks on that pull request's head — read
 * by the desk itself, never taken from what an agent said it opened.
 */

/** A forge that answers every `gh pr view` with `answer`, and counts the asks. */
const forge = (answer: { stdout?: string; stderr?: string; exitCode?: number }) => {
  const asked: string[] = []
  const gh: GhInCheckout = async (args, cwd) => {
    asked.push(`${args.join(' ')} @ ${cwd}`)
    return { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', exitCode: answer.exitCode ?? 0 }
  }
  return { gh, asked }
}

/** A repository whose checked-out branch has work on it that `main` does not. */
const branchWithWork = async (): Promise<Repo> => {
  const repo = await makeRepo()
  await repo.git('checkout', '-q', '-b', 'work')
  await writeFile(join(repo.dir, 'work.txt'), 'one\ntwo\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'work')
  return repo
}

const HEAD = 'c'.repeat(40)

test("the forge's answer is read as a pull request and the checks it ran, each in a state a surface can draw", async () => {
  const { gh } = forge({
    stdout: JSON.stringify({
      number: 12,
      state: 'OPEN',
      headRefOid: HEAD.toUpperCase(),
      url: 'https://example.com/pr/12',
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.com/b' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: null },
        { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://example.com/d' },
      ],
    }),
  })
  assert.deepEqual(await readPullRequest('/work/repo', gh), {
    kind: 'found',
    pr: { number: 12, head: HEAD, state: 'open', url: 'https://example.com/pr/12' },
    ci: [
      { name: 'build', url: 'https://example.com/b', state: 'passed' },
      { name: 'lint', url: null, state: 'failed' },
      { name: 'e2e', url: null, state: 'pending' },
      { name: 'docs', url: null, state: 'skipped' },
      { name: 'deploy/preview', url: 'https://example.com/d', state: 'pending' },
    ],
  })
})

test('a branch with no pull request has none, and a forge that cannot be asked says why', async () => {
  assert.deepEqual(
    await readPullRequest('/work/repo', forge({ exitCode: 1, stderr: 'no pull requests found for branch "work"' }).gh),
    { kind: 'none' },
  )
  assert.deepEqual(
    await readPullRequest('/work/repo', forge({ exitCode: 4, stderr: 'You are not logged into any hosts. Run gh auth login to authenticate.' }).gh),
    { kind: 'unreachable', why: 'You are not logged into any hosts. Run gh auth login to authenticate.' },
  )
})

test("a look records the branch's diff, pull request and checks once, and again only what changed", async () => {
  const repo = await branchWithWork()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({
    stdout: JSON.stringify({ number: 3, state: 'OPEN', headRefOid: HEAD, url: null, statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
  })
  const observer = new Observer({ store, gh, log: () => {} })
  const look = { room: 'room-1', card: 4, project, cwd: repo.dir, seat: 'seat-9' }
  const kinds = async (): Promise<string[]> =>
    (await store.read(project, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record.fact.kind] : []))

  assert.equal(await observer.observe(look), true)
  assert.deepEqual(await kinds(), ['diff', 'pr', 'ci'])
  assert.equal(await observer.observe(look), false, 'nothing changed, so nothing new is kept')
  await writeFile(join(repo.dir, 'more.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'more')
  assert.equal(await observer.observe(look), true)
  assert.deepEqual(await kinds(), ['diff', 'pr', 'ci', 'diff'], 'only the diff moved')
  const [first] = (await store.read(project, 'evidence')).lines
  assert.ok(first?.type === 'evidence')
  assert.deepEqual(first.record.checkout, { cwd: repo.dir, branch: 'work' })
  assert.equal(first.record.seat, 'seat-9')
})

test('what a backup brought never stands for what this desk observed: the same facts, restored, are observed again here', async () => {
  const repo = await branchWithWork()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({ stdout: JSON.stringify({ number: 3, state: 'OPEN', headRefOid: HEAD, url: null, statusCheckRollup: [] }) })
  const look = { room: 'room-1', card: 4, project, cwd: repo.dir, seat: null }
  await new Observer({ store, gh, log: () => {} }).observe(look)
  // The same facts as a backup would bring them: marked, and so not this desk's.
  const brought = (await store.read(project, 'evidence')).lines.flatMap((line) =>
    line.type === 'evidence' ? [{ type: 'evidence' as const, record: { ...line.record, id: `${line.record.id}-restored`, restored: { at: 1 } } }] : [],
  )
  const fresh = new EvidenceStore(tempDir('hd-observe-store-'))
  await fresh.append(project, 'evidence', brought)
  assert.equal(await new Observer({ store: fresh, gh, log: () => {} }).observe(look), true)
  const lines = (await fresh.read(project, 'evidence')).lines.flatMap((line) => (line.type === 'evidence' ? [line.record] : []))
  assert.deepEqual(
    lines.map((record) => [record.fact.kind, Boolean(record.restored)]),
    [['diff', true], ['pr', true], ['diff', false], ['pr', false]],
  )
})

test('a fact a backup brought never says where the desk looks', async () => {
  const repo = await branchWithWork()
  const elsewhere = await branchWithWork()
  const project = await canonical(repo.dir)
  const state = tempDir('hd-observe-state-')
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'commands-seen.json') },
    {
      board: (room) =>
        room === 'room-1'
          ? ({ id: 'room-1', root: repo.dir, intents: [{ id: 1, state: 'done', claim: null }, { id: 2, state: 'done', claim: null }] } as unknown as TeamState)
          : null,
      cwdOf: () => null,
      push: () => {},
      log: () => {},
    },
  )
  const at = await repo.git('rev-parse', 'HEAD')
  const fact = (id: string, card: number, cwd: string, restored: boolean) => ({
    type: 'evidence' as const,
    record: {
      id,
      fact: { kind: 'diff' as const, files: 1, added: 2, removed: 0, from: at, to: at },
      card: { board: 'room-1', id: card },
      checkout: { cwd, branch: 'work' },
      observedAt: 1,
      ...(restored ? { restored: { at: 1 } } : {}),
    },
  })
  // Card 1 is known only from a backup, which says it was observed somewhere else; card 2 this desk observed here.
  await plane.store.append(project, 'evidence', [fact('brought', 1, elsewhere.dir, true), fact('kept', 2, repo.dir, false)])
  await plane.board('room-1')
  assert.equal(plane.observer.take('room-1', 1), true, 'nobody went to look where the backup said')
  assert.equal(plane.observer.take('room-1', 2), false, 'where this desk observed it, it looks again')
  await plane.close()
})

test("a checkout outside the room's project is not looked at", async () => {
  const repo = await branchWithWork()
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh, asked } = forge({ exitCode: 1, stderr: 'no pull requests found' })
  const observer = new Observer({ store, gh, log: () => {} })
  assert.equal(await observer.observe({ room: 'room-1', card: 1, project: '/somewhere/else', cwd: repo.dir, seat: null }), false)
  assert.deepEqual(asked, [])
})

test('through the host: a card its holder finishes leaves the diff it was finished at, by its Seat', async (t) => {
  const repo = await branchWithWork()
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found for branch "work"' })
  const { host, stateDir } = await evidenceDesk(t, { evidence: { gh } }, { stateDir: tempDir('hd-observe-state-'), repo })
  await writeAgent(stateDir)
  const room = (await host.call('goal/create', { root: repo.dir, sentence: 'Work' })) as GoalView
  const card = await host.call('team/add', { room: room.goal.id, title: 'Do the work' }) as { id: number }
  const seated = await host.call('goal/seat', { goal: room.goal.id, card: card.id, agent: 'scout' })
  const session = { id: seated.session.sessionId, settings: { seatLabel: seated.seatLabel } }
  const scope = { runtime: 'fake', sessionId: String(session.id) }
  await host.teamPlane.complete(1, { note: 'done — all tests pass' }, scope)

  const board = await until(async () => {
    const read = (await host.call('evidence/board', { room: room.goal.id })) as BoardEvidence
    return read.cards.some((card) => card.facts.some((fact) => fact.record.fact.kind === 'diff')) ? read : null
  }, 'the diff the finished card left')
  const diff = board.cards[0]?.facts.find((fact) => fact.record.fact.kind === 'diff')
  assert.deepEqual(diff?.record.checkout, { cwd: repo.dir, branch: 'work' })
  assert.deepEqual(diff?.by, { agent: 'Scout', seat: session.settings?.seatLabel ?? '' })
  assert.equal(
    board.cards[0]?.facts.some((fact) => fact.record.fact.kind === 'check'),
    false,
    'the holder said the tests pass; the desk observed no check, so there is none',
  )
})

/*
 * Issue #1035: on a shared, non-isolated checkout, `Observer.observe` used to
 * re-diff a finished card from its own `since` to the checkout's HEAD *as it
 * stands now* — so a later card's commits, on the same branch, showed up on
 * an earlier, already-finished card's diff too. A card that has stopped being
 * held is now bounded to `until`, where its own checkout stood the moment it
 * stopped, exactly as `EvidencePlane#lookAround` derives it from that card's
 * own last diff (`plane.ts`).
 */

const diffsOf = async (store: EvidenceStore, project: string, card: number) =>
  (await store.read(project, 'evidence')).lines.flatMap((line) =>
    line.type === 'evidence' && line.record.card?.id === card && line.record.fact.kind === 'diff' ? [line.record.fact] : [],
  )

/*
 * Issue #1049. A shared checkout may already hold dirt nobody on this card
 * made — a person's own untracked file, another card's leftover work.
 * Counting the whole tree at settle time would mark a cleanly finished card
 * stale for that. `Look.sinceDirtyPaths`, the snapshot taken when the card
 * was claimed, is what a look compares against: only a path dirty now that
 * was not dirty then counts.
 */
test('the stale mark on a diff fact is never set by dirt that was already there when the card was claimed', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found for branch "main"' })
  const observer = new Observer({ store, gh, log: () => {} })

  const since = await repo.git('rev-parse', 'HEAD')
  // Pre-existing dirt: already untracked the moment the card was claimed.
  await writeFile(join(repo.dir, 'preexisting.txt'), 'x\n')
  const sinceDirtyPaths = ['preexisting.txt']

  // The card's own work is committed cleanly; the pre-existing file is
  // still there, still dirty, and still nothing to do with this card.
  await writeFile(join(repo.dir, 'work.txt'), 'y\n')
  await repo.git('add', 'work.txt')
  await repo.git('commit', '-q', '-m', 'card work')

  await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since, sinceDirtyPaths })
  const [withSnapshot] = await diffsOf(store, project, 1)
  assert.equal(withSnapshot?.dirty, false, 'the pre-existing file must not mark this finished card stale')

  // Without the snapshot to compare against, the same checkout reads dirty as a whole — the old behaviour.
  await observer.observe({ room: 'room-2', card: 2, project, cwd: repo.dir, seat: null, since })
  const [noSnapshot] = await diffsOf(store, project, 2)
  assert.equal(noSnapshot?.dirty, true, 'with no snapshot to compare against, the whole checkout answers as it always did')
})

test('a card that finished with no commits keeps an empty diff after a later card commits on the same shared checkout', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found for branch "main"' })
  const observer = new Observer({ store, gh, log: () => {} })

  const since = await repo.git('rev-parse', 'HEAD')
  // Card 1 finishes right away, having made no commits: the desk looks once,
  // unbounded — HEAD has not moved from `since` yet.
  await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since })
  assert.deepEqual(await diffsOf(store, project, 1), [{ kind: 'diff', files: 0, added: 0, removed: 0, from: since, to: since, dirty: false }])

  // Card 2 now commits on the very same checkout.
  await writeFile(join(repo.dir, 'work.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'card 2 work')

  // The board reopens and looks at card 1 again — no longer held, bounded to
  // `until`, its own last diff's `to`.
  const [stopped] = await diffsOf(store, project, 1)
  assert.ok(stopped)
  const changed = await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since: stopped.from, until: stopped.to })
  assert.equal(changed, false, 'bounded to where it stopped, so nothing changed')
  assert.deepEqual(await diffsOf(store, project, 1), [{ kind: 'diff', files: 0, added: 0, removed: 0, from: since, to: since, dirty: false }])
})

test('each of two cards finishing in turn on one shared checkout keeps only its own commit', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found for branch "main"' })
  const observer = new Observer({ store, gh, log: () => {} })

  const base = await repo.git('rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'a.txt'), 'a\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'card 1 work')
  const afterCard1 = await repo.git('rev-parse', 'HEAD')
  await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since: base })

  await writeFile(join(repo.dir, 'b.txt'), 'b\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'card 2 work')
  const afterCard2 = await repo.git('rev-parse', 'HEAD')
  await observer.observe({ room: 'room-1', card: 2, project, cwd: repo.dir, seat: null, since: afterCard1 })

  // The board reopens: card 1 is looked at again, bounded to where it stopped.
  const [diff1] = await diffsOf(store, project, 1)
  assert.ok(diff1)
  await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since: diff1.from, until: diff1.to })

  assert.deepEqual(await diffsOf(store, project, 1), [{ kind: 'diff', files: 1, added: 1, removed: 0, from: base, to: afterCard1, dirty: false }])
  assert.deepEqual(await diffsOf(store, project, 2), [{ kind: 'diff', files: 1, added: 1, removed: 0, from: afterCard1, to: afterCard2, dirty: false }])
})

test('a card still held keeps diffing all the way to HEAD as its checkout moves', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const store = new EvidenceStore(tempDir('hd-observe-store-'))
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found for branch "main"' })
  const observer = new Observer({ store, gh, log: () => {} })

  const since = await repo.git('rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'a.txt'), 'a\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'first commit')
  const head1 = await repo.git('rev-parse', 'HEAD')
  // Still held: no `until` is given.
  await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since })
  assert.deepEqual((await diffsOf(store, project, 1)).at(-1), { kind: 'diff', files: 1, added: 1, removed: 0, from: since, to: head1, dirty: false })

  await writeFile(join(repo.dir, 'b.txt'), 'b\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'second commit')
  const head2 = await repo.git('rev-parse', 'HEAD')
  await observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since })
  assert.deepEqual(
    (await diffsOf(store, project, 1)).at(-1),
    { kind: 'diff', files: 2, added: 2, removed: 0, from: since, to: head2, dirty: false },
    'a live card keeps tracking its checkout all the way to HEAD',
  )
})

test('an old finished card with no recorded stop is not re-diffed against later commits, though its pull request is still checked', async () => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const state = tempDir('hd-observe-state-')
  let now = 1_000_000
  let calls = 0
  const gh: GhInCheckout = async () => {
    calls += 1
    return { stdout: '', stderr: 'no pull requests found', exitCode: 1 }
  }
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'commands-seen.json'), gh, now: () => now },
    {
      board: (room) =>
        room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [{ id: 1, state: 'done', claim: null }] } as unknown as TeamState) : null,
      cwdOf: () => repo.dir,
      push: () => {},
      log: () => {},
    },
  )

  const since1 = await repo.git('rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'card1.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'card 1 work')
  // Card 1 finishes: what the desk honestly recorded the moment it stopped.
  await plane.observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since: since1 })

  // A later card commits on the same checkout, and — before this fix shipped
  // — a board reopened and re-diffed card 1 all the way to HEAD as it stood
  // then, recording the later card's file as card 1's own.
  await writeFile(join(repo.dir, 'later.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'a later card, before this fix shipped')
  await plane.observer.observe({ room: 'room-1', card: 1, project, cwd: repo.dir, seat: null, since: since1 })
  const contaminated = (await diffsOf(plane.store, project, 1)).at(-1)
  assert.ok(contaminated)
  assert.equal(contaminated.files, 2, 'already wrong, from before this fix: it counted the later card’s file too')

  // The fix is live now. Yet another card commits, and the board opens again.
  await writeFile(join(repo.dir, 'even-later.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'a later card, after this fix shipped')
  now += OBSERVE_EVERY_MS + 1
  const before = calls
  await plane.board('room-1')
  await until(() => (calls > before ? true : null), 'the re-look after the clock moved')

  assert.deepEqual(
    (await diffsOf(plane.store, project, 1)).at(-1),
    contaminated,
    'the stale diff is kept exactly as it stood — recomputing it against today’s HEAD was the bug',
  )
  await plane.close()
})

test('a card with a pull-request fact but no diff fact is never diffed against today’s HEAD', async () => {
  const repo = await branchWithWork()
  const project = await canonical(repo.dir)
  const state = tempDir('hd-observe-state-')
  let calls = 0
  const gh: GhInCheckout = async () => {
    calls += 1
    return { stdout: JSON.stringify({ number: 5, state: 'OPEN', headRefOid: HEAD, url: null, statusCheckRollup: [] }), stderr: '', exitCode: 0 }
  }
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'commands-seen.json'), gh },
    {
      board: (room) =>
        room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [{ id: 1, state: 'done', claim: null }] } as unknown as TeamState) : null,
      cwdOf: () => repo.dir,
      push: () => {},
      log: () => {},
    },
  )
  // Only a pull-request fact was ever recorded for this card — no diff fact,
  // and the intent itself carries no `until` (never captured, or lost before
  // this existed): review round 2 of issue #1035, the case a `lastDiff.to`
  // derivation could not tell apart from a card safe to diff once, unbounded.
  await plane.store.append(project, 'evidence', [
    {
      type: 'evidence' as const,
      record: {
        id: 'pr-only',
        fact: { kind: 'pr' as const, number: 5, head: HEAD, state: 'open' as const, url: null },
        card: { board: 'room-1', id: 1 },
        checkout: { cwd: repo.dir, branch: 'work' },
        observedAt: 1,
      },
    },
  ])
  await writeFile(join(repo.dir, 'later.txt'), 'x\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'a later card')
  await plane.board('room-1')
  await until(() => (calls > 0 ? true : null), 'the look for the PR-only card')
  assert.deepEqual(
    await diffsOf(plane.store, project, 1),
    [],
    'never diffed unbounded just because it had no diff fact yet — its pull request was still checked',
  )
  await plane.close()
})

test('isolated lanes keep working unchanged: two cards in their own checkouts each settle with their own diff', async (t) => {
  const repo = await makeRepo()
  const project = await canonical(repo.dir)
  const laneB = tempDir('hd-observe-lane-b-')
  await repo.git('worktree', 'add', '-q', '-b', 'lane-b', laneB)
  t.after(() => repo.git('worktree', 'remove', '-f', laneB).catch(() => undefined))
  const gitAt = async (dir: string, ...args: string[]): Promise<string> =>
    (await repo.git('-C', dir, ...args)) // git -C repo.dir -C laneB ...: the last -C wins, so this runs in `dir`.
  const state = tempDir('hd-observe-state-')
  const { gh } = forge({ exitCode: 1, stderr: 'no pull requests found' })
  const cwdBySession: Record<string, string> = { 's-a': repo.dir, 's-b': laneB }
  const plane = new EvidencePlane(
    { dir: join(state, 'evidence'), seenFile: join(state, 'commands-seen.json'), gh },
    {
      board: (room) => (room === 'room-1' ? ({ id: 'room-1', root: repo.dir, intents: [] } as unknown as TeamState) : null),
      cwdOf: (_runtime, sessionId) => cwdBySession[sessionId] ?? null,
      push: () => {},
      log: () => {},
    },
  )

  const sinceA = await repo.git('rev-parse', 'HEAD')
  await writeFile(join(repo.dir, 'a.txt'), 'a\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'card A work')
  const afterA = await repo.git('rev-parse', 'HEAD')
  plane.settled('room-1', { id: 1, state: 'done', claim: { runtime: 'fake', sessionId: 's-a', at: 1, head: sinceA } } as unknown as Intent)

  const sinceB = await gitAt(laneB, 'rev-parse', 'HEAD')
  await writeFile(join(laneB, 'b.txt'), 'b\n')
  await gitAt(laneB, 'add', '.')
  await gitAt(laneB, 'commit', '-q', '-m', 'card B work')
  const afterB = await gitAt(laneB, 'rev-parse', 'HEAD')
  plane.settled('room-1', { id: 2, state: 'done', claim: { runtime: 'fake', sessionId: 's-b', at: 2, head: sinceB } } as unknown as Intent)

  await plane.settledFor('room-1')

  assert.deepEqual(await diffsOf(plane.store, project, 1), [{ kind: 'diff', files: 1, added: 1, removed: 0, from: sinceA, to: afterA, dirty: false }])
  assert.deepEqual(await diffsOf(plane.store, project, 2), [{ kind: 'diff', files: 1, added: 1, removed: 0, from: sinceB, to: afterB, dirty: false }])
  await plane.close()
})
