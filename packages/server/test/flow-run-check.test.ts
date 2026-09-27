import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { BoardEvidence, Evidence, EvidenceRecord, EvidenceView, FlowExecution, FlowPreview, GoalView, Intent } from '@harnessdesk/protocol'

import { TAIL_LIMIT } from '../src/evidence/run.js'
import { evidenceGuard } from '../src/flow-evidence.js'
import { RUN_CHECK_CLEAN, RUN_CHECK_PER_CARD, RUN_CHECK_PER_TURN } from '../src/flow-execution.js'
import { Host, StateStore } from '../src/index.js'
import { createDetached } from '../src/worktree.js'
import { makeRepo, type Repo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { agent, goalRig } from './fixtures/flow-goal-rig.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * Issue #1082: a Seat's own sandbox may refuse a child process a listening
 * socket, so a reviewer could not tell "my change is broken" from "my sandbox
 * will not let me check". `run_check` asks the host to run one of the flow's
 * declared checks on the committed change the card was handed, in a fresh
 * checkout of its own — only for a Seat that cannot write, a few times a
 * turn, and as advisory evidence no rule counts. The first tests use a real
 * `Host` and a real repository; the caps and the pause use the goal rig.
 */

/** A test that starts a real server in a child process and talks to it — what a sandbox refused. */
const LISTEN = `
import { spawn } from 'node:child_process'
import { get } from 'node:http'
const child = spawn(process.execPath, ['-e', "require('node:http').createServer((q, s) => s.end('pong')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })"])
child.stdout.once('data', (chunk) => {
  const port = Number(String(chunk).trim())
  get({ host: '127.0.0.1', port, path: '/' }, (res) => {
    let body = ''
    res.on('data', (part) => { body += part })
    res.on('end', () => { console.log('answered ' + body + ' on a real port'); child.kill(); process.exit(body === 'pong' ? 0 : 1) })
  })
})
child.on('exit', (code) => { if (code) { console.log('the server could not start'); process.exit(2) } })
`
/** Prints what the checkout's value.txt says, so a test can tell which tree it ran in. */
const VALUE = `import { readFileSync } from 'node:fs'\nconsole.log('value: ' + readFileSync('value.txt', 'utf8').trim())\n`
const LOUD = `process.stdout.write('x'.repeat(${TAIL_LIMIT * 3}) + '\\nthe end\\n')\n`
const SLOW = 'setTimeout(() => {}, 60_000)\n'

const CHECKS = [
  '  listen: { kind: check, run: "node listen.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  value: { kind: check, run: "node value.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  loud: { kind: check, run: "node loud.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  slow: { kind: check, run: "node slow.mjs", exits: { "0": pass }, otherwise: fail, timeout: 1 }',
]

/** A writer in a lane of its own, then a reviewer that only reads; its approval opens `merge` only on a passing `listen`. */
const FLOW = [
  'version: 2', 'name: Write, then review', 'roles:',
  '  writer: { kind: agent, uses: implementer, grant: edit, isolate: true }',
  '  reviewer: { kind: agent, uses: reviewer, grant: read }',
  '  merge: { kind: agent, uses: reviewer, grant: read }',
  ...CHECKS,
  'seed: { role: writer, title: Write it }', 'rules:',
  '  - { id: review, on: writer, when: { every: [done] }, then: { role: reviewer, title: Review it } }',
  '  - { id: merge, on: reviewer, when: { every: [approve], evidence: [{ check: "node listen.mjs" }] }, then: { role: merge, title: Merge it } }',
  '',
].join('\n')

interface Desk {
  readonly host: Host
  readonly repo: Repo
  readonly goal: string
  readonly cards: () => Promise<readonly Intent[]>
  readonly until: (what: string, ok: (cards: readonly Intent[]) => boolean) => Promise<readonly Intent[]>
}

const scopeOf = (card: Intent) => ({ runtime: card.claim!.runtime, sessionId: card.claim!.sessionId })

const desk = async (t: TestContext, flow: string = FLOW): Promise<Desk> => {
  const repo = await makeRepo('hd-flow-run-check-')
  await writeFile(join(repo.dir, 'listen.mjs'), LISTEN)
  await writeFile(join(repo.dir, 'value.mjs'), VALUE)
  await writeFile(join(repo.dir, 'loud.mjs'), LOUD)
  await writeFile(join(repo.dir, 'slow.mjs'), SLOW)
  await writeFile(join(repo.dir, 'value.txt'), 'first\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'checks')
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-flow-run-check-state-'))
  const builtinAgents = tempDir('hd-flow-run-check-builtins-')
  for (const [id, lines] of [
    ['implementer', ['ceiling: edit', 'answers: [done]', 'produces: [diff]']],
    ['reviewer', ['ceiling: read', 'answers: [approve, request-changes]']],
  ] as const) {
    await mkdir(join(stateDir, 'agents', id), { recursive: true })
    await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), ['---', `name: ${id}`, ...lines, 'prefer: [fake]', '---', 'Do the work.', ''].join('\n'), 'utf8')
  }
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents, catalogRefreshMs: 0 })
  host.register(new FakeRuntime())
  t.after(async () => {
    await host.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const preview = await host.call('flow/preview', { root: repo.dir, source: flow }) as FlowPreview
  assert.ok(preview.token, `the flow previews clean: ${JSON.stringify(preview.problems)}`)
  const started = await host.call('flow/start-goal', { root: repo.dir, source: flow, token: preview.token!, sentence: 'Do it' }) as FlowExecution
  const goal = started.goal
  const cards = async () => (await host.call('goal/read', { goal }) as GoalView).board.intents
  const until = async (what: string, ok: (cards: readonly Intent[]) => boolean) => {
    const deadline = Date.now() + 15_000
    for (let now = await cards(); ; now = await cards()) {
      if (ok(now)) return now
      if (Date.now() > deadline) throw new Error(`${what} never happened: ${JSON.stringify(now)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return { host, repo, goal, cards, until }
}

/** The writer commits `value.txt` in its lane and finishes; answers the reviewer's card once it is claimed. */
const toReview = async ({ host, repo, goal, until }: Desk): Promise<{ writer: Intent; reviewer: Intent; lanes: string[] }> => {
  const [writer] = await until('the writer claiming', (all) => all[0]?.state === 'claimed')
  const lanes = (await repo.git('worktree', 'list', '--porcelain'))
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length)).slice(1)
  assert.equal(lanes.length, 1, 'the writer works in a lane of its own')
  await writeFile(join(lanes[0]!, 'value.txt'), 'committed\n')
  assert.match(await host.teamPlane.commitWork(writer!.id, 'The value', scopeOf(writer!)), /^Committed 1 file/)
  // A Seat that can write never has the host run a check for it.
  assert.equal(
    await host.teamPlane.runCheck(writer!.id, { name: 'value' }, scopeOf(writer!)),
    'Refused: run_check is for Seats that only read; a Seat that can write has its work checked by the flow’s own check card.',
  )
  await host.teamPlane.complete(writer!.id, { outcome: 'done' }, scopeOf(writer!))
  const all = await until('the reviewer claiming', (now) => now.some((one) => one.role === 'reviewer' && one.state === 'claimed'))
  const reviewer = all.find((one) => one.role === 'reviewer')!
  // Handed over only once its Seat is journaled, as a real Seat is: before then its card names no Seat yet.
  const deadline = Date.now() + 15_000
  const seated = () => host.flowsPlane.executionsFor(goal)[0]?.operations.some((one) => one.kind === 'seat' && one.card === reviewer.id && one.seat !== null)
  while (!seated()) {
    if (Date.now() > deadline) throw new Error('the reviewer’s Seat was never journaled')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const every = (await repo.git('worktree', 'list', '--porcelain'))
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
  return { writer: writer!, reviewer, lanes: every }
}

const checkFacts = async (host: Host, goal: string, card: number): Promise<Extract<Evidence, { kind: 'check' }>[]> => {
  const board = await host.call('evidence/board', { room: goal }) as BoardEvidence
  return (board.cards.find((one) => one.card === card)?.facts ?? [])
    .map((one) => one.record.fact)
    .filter((fact): fact is Extract<Evidence, { kind: 'check' }> => fact.kind === 'check')
}

test('a read Seat’s run_check runs the committed change — a real server on 127.0.0.1:0 included — in a checkout of its own that is removed after, and records it as advisory', async (t) => {
  const d = await desk(t)
  const { reviewer, lanes } = await toReview(d)
  // Uncommitted edits everywhere: the author's lane, the reviewer's own checkout, the main checkout.
  for (const lane of lanes) await writeFile(join(lane, 'value.txt'), 'dirty\n')
  const before = await d.repo.git('worktree', 'list')

  const value = await d.host.teamPlane.runCheck(reviewer.id, { name: 'value' }, scopeOf(reviewer))
  assert.match(value, /^value passed \(exit 0\)/, value)
  assert.match(value, /value: committed/, 'it ran the committed change')
  assert.doesNotMatch(value, /value: dirty/, 'never anybody’s uncommitted edits')

  const listen = await d.host.teamPlane.runCheck(reviewer.id, { name: 'listen' }, scopeOf(reviewer))
  assert.match(listen, /^listen passed \(exit 0\)/, listen)
  assert.match(listen, /answered pong on a real port/)

  assert.equal(await d.repo.git('worktree', 'list'), before, 'every checkout it cut is gone')
  const facts = await checkFacts(d.host, d.goal, reviewer.id)
  assert.deepEqual(facts.map((one) => [one.name, one.exit, one.counted, one.advisory]).sort(), [['listen', 0, false, true], ['value', 0, false, true]])
  const board = await d.host.call('evidence/board', { room: d.goal }) as BoardEvidence
  for (const view of board.cards.find((one) => one.card === reviewer.id)!.facts.filter((one) => one.record.fact.kind === 'check')) {
    assert.equal(existsSync(view.record.checkout!.cwd), false, 'the folder it ran in was removed')
    assert.equal(view.freshness.state, 'unknown', 'shown apart from counted evidence')
  }

  const refused = await d.host.teamPlane.runCheck(reviewer.id, { name: 'rm -rf .' }, scopeOf(reviewer))
  assert.equal(refused, 'Refused: this card’s flow declares no check named “rm -rf .”; it declares: listen, value, loud, slow.')
})

test('a passing run_check never opens a rule guarded on that check', async (t) => {
  const d = await desk(t)
  const { reviewer } = await toReview(d)
  assert.match(await d.host.teamPlane.runCheck(reviewer.id, { name: 'listen' }, scopeOf(reviewer)), /^listen passed/)
  const finished = await d.host.teamPlane.complete(reviewer.id, { outcome: 'approve' }, scopeOf(reviewer))
  assert.doesNotMatch(finished, /Refused|refused|cannot|needs/, finished)
  await d.until('the review finishing', (all) => all.find((one) => one.id === reviewer.id)?.state === 'done')
  const deadline = Date.now() + 15_000
  let run = d.host.flowsPlane.executionsFor(d.goal)[0]!
  while (run.rounds.find((one) => one.role === 'reviewer')?.state === 'running') {
    if (Date.now() > deadline) throw new Error(`the review round never settled: ${JSON.stringify(run.rounds)}`)
    await d.host.flowsPlane.flush()
    await new Promise((resolve) => setTimeout(resolve, 20))
    run = d.host.flowsPlane.executionsFor(d.goal)[0]!
  }
  assert.equal(run.rounds.find((one) => one.role === 'reviewer')?.state, 'waiting-evidence', 'the rule still waits for a counted check')
  assert.equal(run.rounds.some((one) => one.role === 'merge'), false, 'and merge never opened')
  assert.equal((await d.cards()).some((one) => one.role === 'merge'), false)
})

test('run_check holds a check to its declared timeout and its output to the evidence cap, and refuses a caller that does not hold the card', async (t) => {
  const d = await desk(t)
  const { writer, reviewer } = await toReview(d)
  const slow = await d.host.teamPlane.runCheck(reviewer.id, { name: 'slow' }, scopeOf(reviewer))
  assert.match(slow, /^slow ran over its 1 s limit and was stopped/, slow)
  const loud = await d.host.teamPlane.runCheck(reviewer.id, { name: 'loud' }, scopeOf(reviewer))
  assert.match(loud, /^loud passed \(exit 0\)/, loud)
  assert.match(loud, /the end/, 'the last of what it printed')
  assert.ok(loud.length < TAIL_LIMIT + 600, `bounded output: ${loud.length} characters`)
  const notHeld = await d.host.teamPlane.runCheck(writer.id, { name: 'listen' }, scopeOf(reviewer))
  assert.equal(notHeld, `Refused: you do not hold #${writer.id}, so you cannot run a check for it.`)
})

test('run_check refuses in one sentence when the flow declares no check', async (t) => {
  const flow = ['version: 2', 'name: Review only', 'roles:', '  reviewer: { kind: agent, uses: reviewer, grant: read }', 'seed: { role: reviewer, title: Review it }', 'rules: []', ''].join('\n')
  const d = await desk(t, flow)
  const [card] = await d.until('the reviewer claiming', (all) => all[0]?.state === 'claimed')
  assert.equal(await d.host.teamPlane.runCheck(card!.id, { name: 'listen' }, scopeOf(card!)), 'Refused: this card’s flow declares no check, so there is nothing to run.')
})

// ---------------------------------------------------------------- the rig

const REVIEW = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer, grant: read }
  gate: { kind: check, run: "pnpm test", exits: { "0": pass }, otherwise: fail, timeout: 30 }
seed: { role: reviewer, title: Review it }
rules: []
`

test('run_check allows a few runs a turn and a few more a card, then refuses plainly', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  const run = await rig.start(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  const session = rig.sessionOf('seat-1')
  const ask = () => rig.team.runCheck(1, { name: 'gate' }, session)
  let ran = 0
  for (let turn = 0; ran < RUN_CHECK_PER_CARD; turn += 1) {
    for (let one = 0; one < RUN_CHECK_PER_TURN && ran < RUN_CHECK_PER_CARD; one += 1, ran += 1) {
      assert.match(await ask(), /^gate passed \(exit 0\)/, `run ${ran + 1}, turn ${turn + 1}`)
    }
    if (ran % RUN_CHECK_PER_TURN === 0 && ran < RUN_CHECK_PER_CARD) {
      assert.equal(await ask(), `Refused: card #1 has used its ${RUN_CHECK_PER_TURN} run_check runs for this turn; rely on what they printed.`)
      await rig.flows.reArm(session.runtime, session.sessionId)
      await rig.flows.flush()
    }
  }
  assert.equal(await ask(), `Refused: card #1 has used all ${RUN_CHECK_PER_CARD} of its run_check runs; rely on what they printed and on the check evidence on the board.`)
  assert.equal(rig.events.filter((one) => one === 'check:pnpm test').length, RUN_CHECK_PER_CARD, 'nothing refused ever ran')
  assert.equal(rig.events.filter((one) => one.startsWith('checkout:')).length, rig.events.filter((one) => one.startsWith('checkout-removed:')).length, 'every checkout was removed')
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.state, 'running')
})

test('run_check refuses while its run is paused', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  const run = await rig.startTriggered(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.resumeTriggered(run.id)
  await rig.flows.flush()
  rig.triggerGate = () => ({ reason: 'Every trigger is paused. Resume triggers to continue.', transient: true })
  const session = rig.sessionOf('seat-1')
  await rig.flows.reArm(session.runtime, session.sessionId)
  await rig.flows.flush()
  assert.equal(rig.flows.executionsFor(run.goal)[0]!.intake?.dispatchHeld, true)
  assert.equal(await rig.team.runCheck(1, { name: 'gate' }, session), 'Refused: this card’s flow run is paused or not running, so no check runs for it now.')
  assert.equal(rig.events.some((one) => one.startsWith('check:') || one.startsWith('checkout:')), false, 'nothing ran')
})

test('an advisory check fact neither satisfies nor overturns a rule’s check guard', () => {
  const at = 'b'.repeat(40)
  const subject = { card: 1, round: 1, checkout: { cwd: '/repo', branch: null }, at }
  const fact = (id: string, exit: number, advisory: boolean): EvidenceView => ({
    record: {
      id, card: { board: 'g', id: 2 }, checkout: { cwd: '/repo/.check/x', branch: null }, seat: null, round: 2, observedAt: 1, posted: null,
      fact: { kind: 'check', name: 'gate', run: 'pnpm test', exit, timedOut: false, at, dirty: false, tail: '', ...(advisory ? { counted: false, advisory: true as const } : {}) },
    } as EvidenceRecord,
    freshness: { state: 'fresh' },
    by: null,
  })
  const judge = (facts: readonly EvidenceView[]) => evidenceGuard([{ check: 'pnpm test' }], {
    goal: 'g', finished: { n: 2, role: 'reviewer', cards: [2], seats: [], evidence: [], state: 'running', cause: 'c' },
    subjects: [subject], unsettled: [], cards: [1, 2], reviewers: [], facts, outcomes: ['approve'],
  }).state
  assert.equal(judge([fact('counted-pass', 0, false)]), 'matched', 'the same fact, counted, would open the rule')
  assert.equal(judge([fact('advisory-pass', 0, true)]), 'waiting', 'a passing advisory run never opens it')
  assert.equal(judge([fact('counted-pass', 0, false), fact('advisory-fail', 1, true)]), 'matched', 'nor does a failing one overturn a counted pass')
})

test('run_check checks the commit recorded when the card was claimed, not wherever its shared checkout is now', async (t) => {
  const rig = await goalRig(t)
  const claimed = 'a'.repeat(40)
  rig.heads.set('/repo', { at: claimed, dirty: false })
  await rig.start(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  // A writer sharing the checkout commits after the reviewer's claim.
  const later = 'b'.repeat(40)
  rig.heads.set('/repo', { at: later, dirty: false })
  const answer = await rig.team.runCheck(1, { name: 'gate' }, rig.sessionOf('seat-1'))
  assert.match(answer, new RegExp(`on commit ${claimed}`), answer)
  assert.deepEqual(rig.events.filter((one) => one.startsWith('checkout:')), [`checkout:${claimed}`])
  assert.equal(
    await rig.team.runCheck(1, { name: 'gate', commit: later }, rig.sessionOf('seat-1')),
    `Refused: card #1 was not handed ${later}; it was handed ${claimed}.`,
    'a commit the card was not handed is refused',
  )
})

test('a failing run_check says its checkout is clean, without ignored files, so the failure may not be the change', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  rig.checkOutcomes.set('pnpm test', { exit: 1, timedOut: false, tail: 'Cannot find module' })
  await rig.start(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  const answer = await rig.team.runCheck(1, { name: 'gate' }, rig.sessionOf('seat-1'))
  assert.match(answer, /^gate failed \(exit 1\)/)
  assert.ok(answer.includes(RUN_CHECK_CLEAN), answer)
})

test('a run_check checkout a crash left behind is removed when the desk starts again, and nothing else in that folder is', async (t) => {
  const repo = await makeRepo('hd-flow-run-check-left-')
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-flow-run-check-left-state-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const head = await repo.git('rev-parse', 'HEAD')
  const left = await createDetached(repo.dir, { name: `check-${head.slice(0, 12)}`, at: head, stateDir })
  const other = await createDetached(repo.dir, { name: 'kept', at: head, stateDir })
  assert.ok(existsSync(left) && existsSync(other))
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-flow-run-check-left-builtins-'), catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  await host.start()
  assert.equal(existsSync(left), false, 'the check checkout is gone')
  const listed = await repo.git('worktree', 'list', '--porcelain')
  assert.equal(listed.includes(left.split('/').pop()!), false, 'and git no longer lists it')
  assert.ok(existsSync(other), 'a folder that is not a check checkout is left alone')
})
