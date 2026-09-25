import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { runtimeId, type BoardEvidence, type GoalView, type Session, type TeamState } from '@harnessdesk/protocol'

import { readPullRequest, type GhInCheckout } from '../src/evidence/forge.js'
import { Observer } from '../src/evidence/observe.js'
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
