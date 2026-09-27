import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { FlowExecution, FlowPreview, GoalView } from '@harnessdesk/protocol'

import { Host, StateStore } from '../src/index.js'
import { Team, type TeamPeer, type TeamPort } from '../src/team.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * Issue #1049. A flow card whose role can commit (`edit` and above) finished
 * with `complete_claim` while its written file was still uncommitted and
 * untracked: the round closed as a success, its evidence recorded a zero
 * diff, and the work was left outside every branch and outside the ledger,
 * with nothing telling the person. A round producing nothing but prose is
 * legitimate (`docs/flows.md`'s UC5 proposal round) — the defect is work left
 * uncommitted, not a zero diff by itself.
 *
 * A Goal's checkout is shared by default, and most shipped flows are not
 * isolated, so counting the whole working tree would refuse a card for a
 * person's own untracked file or unrelated leftover work nobody on the card
 * touched. `complete_claim` (and a review that finishes a card the same way)
 * instead compares the checkout's dirty paths now against a snapshot taken
 * the moment the card was claimed (`IntentClaim.dirtyPaths`) and refuses only
 * for a path that is newly dirty since. A person finishing a card by hand is
 * never refused this way at all, since they may have decided the leftovers
 * do not matter.
 */

const WRITER_EDIT = `
version: 2
name: One writer
roles:
  author: { kind: agent, uses: writer, grant: edit }
seed: { role: author, title: Write something }
rules: []
`

const WRITER_READ = `
version: 2
name: One reader
roles:
  author: { kind: agent, uses: writer, grant: read }
seed: { role: author, title: Look something up }
rules: []
`

test('a shared checkout already dirty before the claim finishes once the agent commits its own work', async (t) => {
  const rig = await goalRig(t)
  // Pre-existing dirt — a person's own untracked file — already there when the card is claimed.
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env'] })
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  // The agent commits its own work; the pre-existing file is still there, untouched, and still dirty.
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['.env'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test("the same checkout with the agent leaving its own new file uncommitted is refused, counting only the agent's", async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env'] })
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  // The pre-existing file is still dirty, and the agent leaves one new file of its own uncommitted too.
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env', 'notes.md'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^You have 1 uncommitted file from this card's work\. Commit them with commit_work, then finish again\.$/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'claimed', 'not finished')
})

test('a claim with no dirty-paths snapshot is never refused, however dirty its checkout is now', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  // Simulate a claim recorded before this snapshot existed: strip it from the board directly.
  const state = rig.team.stateFor(run.goal)
  rig.team.installProjection({
    ...state,
    intents: state.intents.map((one) =>
      one.id === 1 && one.claim ? { ...one, claim: { ...one.claim, dirtyPaths: undefined } } : one,
    ),
  })
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['leftover.txt'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/, 'a finish with nothing to compare against is never refused for dirt it cannot attribute')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a checkout with more than 500 dirty paths at claim gets a null snapshot, and the finish is never refused', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  /*
   * `revisionAt`'s own cap (DIRTY_PATHS_CAP, see evidence-revision.test.ts)
   * is what turns a real `git status` into `null` past 500 paths, for a
   * checkout with no `.gitignore` entry for something like `node_modules`.
   * Stand in for that already-capped read here, the same way this file's
   * "no snapshot" test stands in for a claim written before dirtyPaths
   * existed: a `null` snapshot, not `undefined`.
   */
  const state = rig.team.stateFor(run.goal)
  rig.team.installProjection({
    ...state,
    intents: state.intents.map((one) =>
      one.id === 1 && one.claim ? { ...one, claim: { ...one.claim, dirtyPaths: null } } : one,
    ),
  })
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['agent-work.txt'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/, 'a capped (null) snapshot fails open, exactly like a missing one')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a clean card with no diff — a prose answer — finishes', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a read-only card is never refused for a dirty checkout — it could not have committed anything', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_READ, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['a.txt', 'b.txt', 'c.txt'] })
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.doesNotMatch(String(answer), /uncommitted/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test("a person's hand-finish is not refused for a dirty checkout", async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-1', dirty: true, dirtyPaths: ['new-work.txt'] })
  await rig.team.intentAction(run.goal, 1, 'done', undefined, 'done')
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
})

test('a failed dirty read does not block the finish', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.headOfFails.add('/repo')
  const answer = await rig.team.complete(1, { outcome: 'done' }, rig.sessionOf('seat-1'))
  assert.match(String(answer), /^Completed #1/)
  assert.equal(rig.board(run.goal).intents.find((one) => one.id === 1)?.state, 'done')
  assert.ok(rig.logs.some((line) => /checkout could not be read/.test(line)), 'the failed read is logged')
})

test("a claim's dirty-paths snapshot survives a restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-team-dirty-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const codex = { runtime: 'codex', sessionId: 'c1' }
  const peers: TeamPeer[] = [
    { runtime: 'codex', sessionId: 'c1', title: null, cwd: '/repo', agent: 'Codex', busy: false, canSteer: false, queuedByUser: 0, here: true } as TeamPeer,
  ]
  const port: TeamPort = {
    peers: () => peers,
    rootOf: async () => '/repo',
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
    startOf: async () => ({ head: 'a'.repeat(40), upstream: null, dirtyPaths: ['dirty-a.txt', 'dirty-b.txt'] }),
  }
  const team = new Team(dir, port)
  const room = (await team.createRoom('/repo', 'repo')).id
  await team.joinRoom(room, 'codex' as TeamPeer['runtime'], 'c1')
  await team.addIntent({ title: 'Do it', files: [] }, codex)
  await team.claim(1, codex)
  await team.flush()

  const reborn = new Team(dir, port)
  await reborn.load()
  assert.deepEqual(reborn.dirtyPathsOf(room, 1), ['dirty-a.txt', 'dirty-b.txt'], 'stored with the claim, so it survives the restart')
  const rebornClaim = reborn.stateFor(room).intents[0]?.claim
  assert.ok(rebornClaim, 'the restored card is still claimed')
  assert.equal('dirtyPaths' in rebornClaim!, false, 'never on the board a renderer reads — team/state strips it')
})

test("a claimed card's dirty-paths snapshot never reaches a board snapshot", async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env'] })
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  const claim = rig.board(run.goal).intents.find((one) => one.id === 1)?.claim
  assert.ok(claim, 'the card is claimed')
  assert.equal('dirtyPaths' in claim!, false, "team/state's board never carries it")
  // The snapshot is still there for the finish check to compare against.
  assert.deepEqual(rig.team.dirtyPathsOf(run.goal, 1), ['.env'])
})

/*
 * `goalRig`'s claim path is a fake Team port standing in for the real one,
 * and its "survives a restart" case above (`Team` alone, over a legacy
 * room) never touches a Goal's own document. A Goal board's save goes
 * `Team#commit`/`goalPlaneWrite` → the host's `mutate` → `#saveTeamProjection`
 * → `#writeGoalBoard`, a different path — one that used to run the wire-safe,
 * stripped projection straight into the document, so a flow card's
 * dirty-paths snapshot never reached disk at all and every such card failed
 * open after a restart. This drives a real flow through a real `Host`, a
 * real git checkout, and a real restart to prove the snapshot is durable on
 * that path too.
 */
test('a flow card claimed with a dirty checkout keeps its dirty-paths snapshot on a Goal board across a restart', async (t) => {
  const repo = await makeRepo('hd-flow-restart-dirty-')
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-flow-restart-state-'))
  const builtinAgents = tempDir('hd-flow-restart-builtins-')
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  await mkdir(join(stateDir, 'agents', 'implementer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'implementer', 'AGENT.md'), [
    '---', 'name: implementer', 'ceiling: edit', 'produces: [diff]', 'prefer: [fake]', '---', 'Do the work.', '',
  ].join('\n'), 'utf8')

  const source = [
    'version: 2', 'name: Solo writer', 'roles:',
    '  writer: { kind: agent, uses: implementer, grant: edit }',
    'seed: { role: writer, title: Write something }', 'rules: []', '',
  ].join('\n')

  const open = async (): Promise<Host> => {
    const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents, catalogRefreshMs: 0 })
    host.register(new FakeRuntime())
    await host.start()
    return host
  }

  const first = await open()
  // A failed assertion before the planned dispose below must not leave this host running and hang the file.
  let firstOpen = true
  t.after(async () => { if (firstOpen) await first.dispose() })
  // Every goal/changed push the renderer would receive, to prove none carries the snapshot.
  const pushed: unknown[] = []
  first.addBroadcaster((notification) => { if (notification.method === 'goal/changed') pushed.push(notification.params) })
  await first.call('workspace/open', { path: repo.dir })
  // Dirt already in the checkout before anything claims a card — a person's own untracked file.
  await writeFile(join(repo.dir, '.env'), 'secret\n')

  const preview = await first.call('flow/preview', { root: repo.dir, source }) as FlowPreview
  assert.ok(preview.token, `the flow previews clean: ${JSON.stringify(preview.problems)}`)
  const started = await first.call('flow/start-goal', {
    root: repo.dir, source, token: preview.token!, sentence: 'Finish the change',
  }) as FlowExecution
  const goal = started.goal

  const readBoard = async (host: Host) => (await host.call('goal/read', { goal }) as GoalView).board
  const deadline = Date.now() + 10_000
  let board = await readBoard(first)
  while (board.intents.length !== 1 || board.intents[0]?.state !== 'claimed') {
    if (Date.now() > deadline) throw new Error(`the seed card never claimed: ${JSON.stringify(board.intents)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    board = await readBoard(first)
  }
  const card = board.intents[0]!.id
  const claim = board.intents[0]!.claim!
  assert.equal('dirtyPaths' in claim, false, "goal/read's board never carries it, even here")
  assert.ok(pushed.length > 0, 'the claim pushed at least one goal/changed')
  assert.equal(JSON.stringify(pushed).includes('dirtyPaths'), false, 'no goal/changed push carries the dirty-paths snapshot')
  const before = first.teamPlane.dirtyPathsOf(goal, card)
  assert.deepEqual(before, ['.env'], "the pre-existing dirt is what the claim snapshotted")

  firstOpen = false
  await first.dispose()
  const second = await open()
  t.after(() => second.dispose())
  await second.call('workspace/open', { path: repo.dir })

  const after = second.teamPlane.dirtyPathsOf(goal, card)
  assert.deepEqual(after, ['.env'], 'the snapshot is durable — read back from the Goal document a fresh host loaded, not carried in memory')
  const rereadClaim = (await readBoard(second)).intents.find((one) => one.id === card)?.claim
  assert.equal('dirtyPaths' in rereadClaim!, false, "goal/read still never carries it, after the restart too")

  // The agent's own new, uncommitted file — dirt that was not there at claim time.
  await writeFile(join(repo.dir, 'left-behind.txt'), 'x\n')
  const answer = await second.teamPlane.complete(card, {}, { runtime: claim.runtime, sessionId: claim.sessionId })
  assert.match(
    String(answer),
    /^You have 1 uncommitted file from this card's work\. Commit them with commit_work, then finish again\.$/,
    'a snapshot that survived the restart is the one this finish is checked against',
  )
})

/*
 * Issue #1074. A Seat whose own environment refuses its commits (a sandbox
 * that keeps `.git` read-only) is refused its finish on every turn, and the
 * run's re-arm breaker then gave up with only "ended its turn 3 times": no
 * hint that the real blocker was work it could not commit. The stall names
 * that reason when the finish was refused for uncommitted work on the turns
 * that tripped it — and only then.
 */
test('a Seat refused its finish for uncommitted work turn after turn stalls saying it could not commit', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['notes.md'] })
  const session = rig.sessionOf('seat-1')
  for (let turn = 0; turn < 4; turn++) {
    const answer = await rig.team.complete(1, { outcome: 'done' }, session)
    assert.match(String(answer), /uncommitted file/)
    await rig.flows.reArm(session.runtime, session.sessionId)
    await rig.flows.flush()
  }
  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.match(String(stalled.reason), /could not commit its work/)
  assert.match(String(stalled.reason), /environment refused writes to the repository and it did not commit with commit_work/)
  assert.doesNotMatch(String(stalled.reason), /^The Seat for card #1 ended its turn/)
})

test('a Seat whose turns simply end stalls with the plain re-arm sentence', async (t) => {
  const rig = await goalRig(t)
  const run = await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  const session = rig.sessionOf('seat-1')
  for (let turn = 0; turn < 4; turn++) {
    await rig.flows.reArm(session.runtime, session.sessionId)
    await rig.flows.flush()
  }
  const stalled = rig.flows.executionsFor(run.goal)[0]!
  assert.match(String(stalled.reason), /^The Seat for card #1 ended its turn 3 times inside the hour/)
  assert.doesNotMatch(String(stalled.reason), /commit/)
})

/*
 * Issue #1074: the host commits a card's own work for its Seat, so an agent
 * whose sandbox keeps `.git` read-only never has to be given it. The engine
 * hands the host the claim's own snapshot, so only what changed since is
 * committed (the git itself is card-commit.test.ts's).
 */
test('commit_work on an edit card has the host commit its checkout, against the snapshot taken at claim', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env'] })
  await rig.start(WRITER_EDIT, [agent('writer', ['done'])])
  await rig.flows.flush()
  rig.heads.set('/repo', { at: 'sha-0', dirty: true, dirtyPaths: ['.env', 'notes.md'] })
  const answer = await rig.team.commitWork(1, 'Answer the question', rig.sessionOf('seat-1'))
  assert.equal(answer, `Committed 1 file as ${'c'.repeat(40)}.`)
  assert.deepEqual(rig.commits, [{ cwd: '/repo', before: ['.env'], message: 'Answer the question' }])
})

test('commit_work on a read-only card is refused, and nothing is committed', async (t) => {
  const rig = await goalRig(t)
  await rig.start(WRITER_READ, [agent('writer', ['done'])])
  await rig.flows.flush()
  const answer = await rig.team.commitWork(1, 'Sneak a change in', rig.sessionOf('seat-1'))
  assert.equal(answer, 'Refused: the Seat for card #1 may only read, so it cannot commit.')
  assert.deepEqual(rig.commits, [])
})


/*
 * Review of #1075: "dirty now and not at my claim" is only a card's own work
 * when nobody else can be writing the same checkout. Two committing cards in
 * one shared checkout cannot tell each other's changes apart, so commit_work
 * refuses there rather than commit one card's work under the other's name —
 * and an isolated pair, each in its own lane, commits as usual.
 */
const PAIR = (isolate: boolean) => `
version: 2
name: Two writers
roles:
  author: { kind: agent, uses: writer, count: 2, grant: edit${isolate ? ', isolate: true' : ''} }
seed: { role: author, title: Write something }
rules: []
`

test('commit_work is refused while another committing card works in the same checkout', async (t) => {
  const rig = await goalRig(t)
  await rig.start(PAIR(false), [agent('writer', ['done'])])
  await rig.flows.flush()
  const answer = await rig.team.commitWork(1, 'Mine', rig.sessionOf('seat-1'))
  assert.equal(answer, "Refused: another card is working in this checkout, so its changes can't be told apart from yours; nothing was committed. Ask the person to commit, or isolate the role.")
  assert.deepEqual(rig.commits, [])
  // Once the other card is finished, the checkout is this card's alone again.
  await rig.team.complete(2, { outcome: 'done' }, rig.sessionOf('seat-2'))
  assert.match(await rig.team.commitWork(1, 'Mine', rig.sessionOf('seat-1')), /^Committed 1 file/)
})

test('an isolated pair commits, each in its own lane', async (t) => {
  const rig = await goalRig(t)
  await rig.start(PAIR(true), [agent('writer', ['done'])])
  await rig.flows.flush()
  assert.match(await rig.team.commitWork(1, 'Mine', rig.sessionOf('seat-1')), /^Committed 1 file/)
  assert.equal(rig.commits.length, 1)
  assert.notEqual(rig.commits[0]!.cwd, '/repo', 'in the lane, not the shared checkout')
})
