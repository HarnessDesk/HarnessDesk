import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { BoardEvidence, Evidence, EvidenceRecord, EvidenceView, FlowExecution, FlowPreview, GoalView, Intent } from '@harnessdesk/protocol'

import { EvidenceStore } from '../src/evidence/store.js'
import { recordCheckProcess, recoverCheckProcesses } from '../src/evidence/check-processes.js'
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
  '  listen: { kind: check, onRequest: true, run: "node listen.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  value: { kind: check, onRequest: true, run: "node value.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  loud: { kind: check, onRequest: true, run: "node loud.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  slow: { kind: check, onRequest: true, run: "node slow.mjs", exits: { "0": pass }, otherwise: fail, timeout: 1 }',
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
  // commit_work reads the checkout's own author, never the machine's; a CI runner has none.
  await repo.git('config', 'user.name', 'Jane Doe')
  await repo.git('config', 'user.email', 'dev@example.com')
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
  assert.equal(refused, 'Refused: this card’s flow declares no check a Seat may run named “rm -rf .”; choose from: listen, value, loud, slow.')
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
  assert.equal(await d.host.teamPlane.runCheck(card!.id, { name: 'listen' }, scopeOf(card!)), 'Refused: this card’s flow declares no check a Seat may run, so there is nothing to run.')
})

// ---------------------------------------------------------------- the rig

const REVIEW = `
version: 2
name: Review a change
roles:
  reviewer: { kind: agent, uses: reviewer, grant: read }
  gate: { kind: check, onRequest: true, run: "pnpm test", exits: { "0": pass }, otherwise: fail, timeout: 30 }
seed: { role: reviewer, title: Review it }
rules: []
`

for (const field of ['', ', onRequest: false']) test(`run_check refuses an unoffered landing check (${field || 'field absent'}) without a name or with its name`, async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  const flow = REVIEW.replace(', onRequest: true', '').replace('  gate: { kind: check,', `  land: { kind: check${field},`).replace('pnpm test', 'node land.mjs')
  await rig.start(flow, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  const session = rig.sessionOf('seat-1')
  for (const options of [{}, { name: 'land' }]) {
    assert.equal(await rig.team.runCheck(1, options, session), 'Refused: this card’s flow declares no check a Seat may run, so there is nothing to run.')
  }
  assert.equal(rig.events.some((one) => one.startsWith('checkout:') || one.startsWith('check:')), false, 'neither a checkout nor a command was started')
})

test('run_check selects the only opted-in check and never offers the landing check', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  const flow = REVIEW
    .replace('seed:', '  land: { kind: check, run: "node land.mjs" }\nseed:')
  const run = await rig.start(flow, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  const session = rig.sessionOf('seat-1')
  assert.match(await rig.team.runCheck(1, {}, session), /^gate passed \(exit 0\)/)
  assert.equal(await rig.team.runCheck(1, { name: 'land' }, session), 'Refused: this card’s flow declares no check a Seat may run named “land”; choose from: gate.')
  assert.deepEqual(rig.events.filter((one) => one.startsWith('check:')), ['check:pnpm test'])
  const checkOf = () => {
    const role = rig.flows.executionsFor(run.goal)[0]!.document.flow.roles.find((one) => one.id === 'gate')
    return role?.kind === 'check' ? role.check : null
  }
  const expected = { run: 'pnpm test', onRequest: true, timeout: 30, exits: { 0: 'pass' }, otherwise: 'fail' }
  assert.deepEqual(checkOf(), expected, 'the run freezes the opt-in')
  await rig.restart()
  assert.deepEqual(checkOf(), expected, 'the frozen opt-in survives storage and restart')
})

test('run_check lists only opted-in checks when a name is required', async (t) => {
  const rig = await goalRig(t)
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  const flow = REVIEW
    .replace('seed:', '  build: { kind: check, onRequest: true, run: "pnpm build" }\n  land: { kind: check, run: "node land.mjs" }\nseed:')
  await rig.start(flow, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  const session = rig.sessionOf('seat-1')
  assert.equal(await rig.team.runCheck(1, {}, session), 'Refused: this card’s flow declares several checks a Seat may run, so name one of: gate, build.')
  assert.equal(await rig.team.runCheck(1, { name: 'land' }, session), 'Refused: this card’s flow declares no check a Seat may run named “land”; choose from: gate, build.')
  assert.equal(rig.events.some((one) => one.startsWith('checkout:') || one.startsWith('check:')), false)
})

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

for (const mainExits of [false, true]) test(`startup stops the recorded group, including grandchildren, with the command ${mainExits ? 'finished' : 'still running'}`, async (t) => {
  const stateDir = tempDir('hd-flow-process-restart-')
  const processDir = join(stateDir, 'evidence', 'check-processes')
  const childFile = join(stateDir, 'child.mjs')
  await writeFile(childFile, `import { spawn } from 'node:child_process'; import { existsSync, renameSync, writeFileSync } from 'node:fs';
const child = spawn('sleep', ['30'], { stdio: 'ignore' });
writeFileSync('children.pending', JSON.stringify([process.pid, child.pid])); renameSync('children.pending', 'children.json'); ${mainExits ? "child.unref(); const timer = setInterval(() => { if (existsSync('release-main')) clearInterval(timer) }, 10);" : 'setInterval(() => {}, 1000);'}`)
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', `
import { runCommand } from ${JSON.stringify(new URL('../src/evidence/run.js', import.meta.url).href)};
await runCommand(${JSON.stringify(`${quote(process.execPath)} ${quote(childFile)}`)}, {
 cwd: ${JSON.stringify(stateDir)}, timeoutSec: 30, processDir: ${JSON.stringify(processDir)}, onStarted: () => console.log('started')
});`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const outsider = spawn('sleep', ['30'], { stdio: 'ignore', detached: true })
  let pgid: number | undefined
  t.after(() => {
    launcher.kill('SIGKILL')
    outsider.kill('SIGKILL')
    if (pgid) { try { process.kill(-pgid, 'SIGKILL') } catch { /* Gone. */ } }
  })
  const deadline = Date.now() + 5000
  while (!existsSync(join(stateDir, 'children.json'))) {
    if (Date.now() > deadline) throw new Error('The staged check never started.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const records = await readdir(processDir)
  assert.equal(records.length, 1)
  pgid = (JSON.parse(await readFile(join(processDir, records[0]!), 'utf8')) as { pgid: number }).pgid
  const children = JSON.parse(await readFile(join(stateDir, 'children.json'), 'utf8')) as number[]
  const exited = once(launcher, 'exit')
  launcher.kill('SIGKILL')
  await exited
  if (mainExits) {
    await writeFile(join(stateDir, 'release-main'), 'go')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.doesNotThrow(() => process.kill(pgid!, 0), 'the supervisor retains the recorded identity after the main command exits')
  }
  for (const pid of mainExits ? children.slice(1) : children) assert.doesNotThrow(() => process.kill(pid, 0), 'the old check outlived its host')
  assert.doesNotThrow(() => process.kill(-pgid!, 0))
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-restart-process-agents-'), catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  await host.start()
  for (const pid of children) {
    let status = ''
    try { status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { /* Reaped. */ }
    assert.ok(status === '' || status.startsWith('Z') || status.startsWith('X') || status.includes('E'), `check child ${pid} cannot run again`)
  }
  assert.doesNotThrow(() => process.kill(outsider.pid!, 0), 'an unrelated group was not signalled')
  assert.deepEqual(await readdir(processDir), [], 'recovery durably clears the stopped group')
  await host.dispose()
})

test('startup refuses an unreadable check launch journal before recovering flows', async (t) => {
  const stateDir = tempDir('hd-check-invalid-journal-')
  const processDir = join(stateDir, 'evidence', 'check-processes')
  await mkdir(processDir, { recursive: true })
  await writeFile(join(processDir, 'launch.json'), '{broken')
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-check-invalid-agents-'), catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  let recovered = false
  t.mock.method(host.flowsPlane, 'load', async () => { recovered = true })
  await assert.rejects(host.start(), /JSON/)
  assert.equal(recovered, false)
  assert.equal(await readFile(join(processDir, 'launch.json'), 'utf8'), '{broken', 'uncertain records remain available')
})

test('a live group without its recorded leader is never signalled, keeps its journal, and refuses startup', async (t) => {
  const stateDir = tempDir('hd-check-missing-leader-')
  const processDir = join(stateDir, 'evidence', 'check-processes')
  await mkdir(processDir, { recursive: true })
  const leader = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let child = 0
  t.after(() => { try { process.kill(-leader.pid!, 'SIGKILL') } catch { /* Gone. */ } })
  const [output] = await once(leader.stdout!, 'data') as [Buffer]
  child = Number(output.toString().trim())
  const exited = once(leader, 'exit')
  leader.kill('SIGKILL')
  await exited
  const path = join(processDir, 'launch.json')
  const record = JSON.stringify({ version: 1, pgid: leader.pid, identity: 'a'.repeat(64) })
  await writeFile(path, record)
  await assert.rejects(recoverCheckProcesses(processDir), /identity|identified/)
  assert.doesNotThrow(() => process.kill(child, 0), 'the unrelated surviving child was never killed')
  assert.equal(await readFile(path, 'utf8'), record)
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-check-missing-agents-'), catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  await assert.rejects(host.start(), /identity|identified/)
  assert.doesNotThrow(() => process.kill(child, 0))
})

for (const stopped of [false, true]) test(`an EPERM probe ${stopped ? 'clears a group proven gone' : 'refuses a group with live members'}`, async (t) => {
  const processDir = join(tempDir('hd-check-permission-probe-'), 'processes')
  const leader = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  t.after(() => leader.kill('SIGKILL'))
  await once(leader, 'spawn')
  recordCheckProcess(processDir, leader.pid!)
  const files = await readdir(processDir)
  if (stopped) {
    const exited = once(leader, 'exit')
    leader.kill('SIGKILL')
    await exited
  }
  const kill = process.kill.bind(process)
  let signals = 0
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === -leader.pid!) {
      if (signal === 0) throw Object.assign(new Error('staged permission refusal'), { code: 'EPERM' })
      signals += 1
    }
    return kill(pid, signal)
  })
  if (stopped) {
    await recoverCheckProcesses(processDir)
    assert.deepEqual(await readdir(processDir), [])
  } else {
    await assert.rejects(recoverCheckProcesses(processDir), /staged permission refusal/)
    assert.deepEqual(await readdir(processDir), files, 'uncertain ownership keeps its record')
  }
  assert.equal(signals, 0, 'no signal is authorized by an EPERM probe')
})

test('the real wire retry returns at launch, stays busy through downstream settlement and preserves both outputs', async (t) => {
  const repo = await makeRepo('hd-check-wire-retry-')
  await writeFile(join(repo.dir, 'again.mjs'), `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('attempt')) { writeFileSync('attempt', 'first'); console.log('first answer'); }
else { writeFileSync('started-again', 'yes'); const timer = setInterval(() => { if (existsSync('release')) { clearInterval(timer); console.log('second answer'); } }, 20); }`)
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'staged check')
  const stateDir = tempDir('hd-check-wire-state-')
  const host = new Host({ logger: silent, state: new StateStore(join(stateDir, 'state.json')), builtinAgents: tempDir('hd-check-wire-agents-'), catalogRefreshMs: 0 })
  t.after(() => host.dispose())
  await host.start()
  await host.call('workspace/open', { path: repo.dir })
  const source = 'version: 2\nname: Check again\nroles:\n  gate: { kind: check, run: "node again.mjs", exits: { "0": no-pr }, otherwise: retry, timeout: 30 }\n  person: { kind: person, outcomes: [done] }\nseed: { role: gate, title: Check it }\nrules:\n  - { id: person, on: gate, then: { role: person, title: Decide } }\n'
  const preview = await host.call('flow/preview', { root: repo.dir, source }) as FlowPreview
  assert.ok(preview.token, JSON.stringify(preview.problems))
  const run = await host.call('flow/start-goal', { root: repo.dir, source, token: preview.token!, sentence: 'Staged retry' }) as FlowExecution
  await host.flowsPlane.flush()
  assert.equal(host.flowsPlane.executionOf(run.id)!.state, 'running')
  const card = host.flowsPlane.executionOf(run.id)!.rounds[0]!.cards[0]!
  const goalRoot = (await host.call('goal/read', { goal: run.goal }) as GoalView).goal.root
  const processDir = join(stateDir, 'evidence', 'check-processes')
  const retained = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  t.after(() => retained.kill('SIGKILL'))
  await once(retained, 'spawn')
  recordCheckProcess(processDir, retained.pid!, { board: run.goal, card })
  const refused = await host.call('flow/preview', { root: goalRoot, source, retry: { run: run.id, card } }) as FlowPreview
  assert.equal(refused.token, null, 'retained cleanup refuses fresh consent before a card is reopened')
  assert.match(refused.problems[0]!.text, /cleanup.*before running this card again/i)
  const exited = once(retained, 'exit')
  retained.kill('SIGKILL')
  await exited
  await recoverCheckProcesses(processDir)
  const consent = await host.call('flow/preview', { root: goalRoot, source, retry: { run: run.id, card } }) as FlowPreview
  assert.ok(consent.token, JSON.stringify(consent.problems))
  assert.equal(consent.commands.length, 1)
  const start = Date.now()
  const retried = await host.call('flow/check/retry', { run: run.id, card, token: consent.token! }) as FlowExecution
  assert.ok(Date.now() - start < 2000, 'a 30-second check responds on launch')
  assert.equal(retried.state, 'running')
  assert.equal(retried.operations.find((one) => one.card === card && one.kind === 'check')!.state, 'started')
  assert.equal((await readdir(join(stateDir, 'evidence', 'check-processes'))).length, 1)
  await assert.rejects(host.call('flow/check/retry', { run: run.id, card, token: consent.token! }), /changed/)
  /* The retry is still running and has recorded nothing, so the read lists the one result there is — as it was. */
  const during = await host.call('flow/check/attempts', { run: run.id, card })
  assert.deepEqual(during.attempts.map((one) => [one.n, one.tail]), [[1, 'first answer\n']])
  const person = host.flowsPlane.executionOf(run.id)!.rounds[1]!.cards[0]!
  await assert.rejects(host.call('flow/check/attempts', { run: run.id, card: person }), /Card #\d+ is not a check/)
  await host.call('team/intent', { room: run.goal, id: person, action: 'done', outcome: 'done' })
  await host.flowsPlane.wakeEvidence(run.goal)
  const deadline = Date.now() + 5000
  while (host.flowsPlane.executionOf(run.id)!.state === 'running' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(host.flowsPlane.executionOf(run.id)!.state, 'settled', 'downstream can finish while the earlier retry is live')
  const busy = await host.call('evidence/board', { room: run.goal }) as BoardEvidence
  assert.equal(busy.cards.find((one) => one.card === card)!.running.length, 1, 'the retry is still counted as board work')
  await writeFile(join(repo.dir, 'release'), 'done')
  await host.flowsPlane.flush()
  const goal = await host.call('goal/read', { goal: run.goal }) as GoalView
  assert.equal(goal.board.intents.find((one) => one.id === card)!.state, 'done')
  const saved = await new EvidenceStore(join(stateDir, 'evidence'), () => {}).read(goalRoot, 'evidence')
  const facts = saved.lines.flatMap((one) => one.type === 'evidence' && one.record.fact.kind === 'check' ? [one.record.fact] : [])
  assert.ok(facts.some((one) => one.tail === 'first answer\n'), 'previous output is retained in the durable history')
  assert.ok(facts.some((one) => one.tail === 'second answer\n'), 'fresh output is durably observed')
  /* The wire read returns both, oldest first: the first attempt after the retry is the first attempt before it. */
  const { attempts } = await host.call('flow/check/attempts', { run: run.id, card })
  assert.deepEqual(attempts.map((one) => [one.n, one.exit, one.outcome, one.tail]), [[1, 0, 'no-pr', 'first answer\n'], [2, 0, 'no-pr', 'second answer\n']])
  assert.deepEqual(attempts[0], during.attempts[0], 'the first attempt read while the retry ran is the first attempt read after it')
  assert.ok(attempts[0]!.at <= attempts[1]!.at)
  assert.equal(attempts[0]!.commit, (await repo.git('rev-parse', 'HEAD')).trim())
  await assert.rejects(host.call('flow/check/attempts', { run: 'no-such-run', card }), /There is no flow run no-such-run/)
  assert.equal(host.flowsPlane.executionOf(run.id)!.state, 'settled')
  assert.deepEqual(await readdir(join(stateDir, 'evidence', 'check-processes')), [])
})


for (const action of ['stop', 'pause'] as const) test(`${action} reaches a run_check while its checkout is still being cut (#1348)`, async (t) => {
  let signal: AbortSignal | undefined
  let begun!: () => void
  const started = new Promise<void>((resolve) => { begun = resolve })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const rig = await goalRig(t, { checkoutAt: async (_cwd, _at, options) => {
    signal = options?.signal
    begun()
    await held
    throw new Error('cutting the checkout was stopped')
  } })
  rig.heads.set('/repo', { at: 'a'.repeat(40), dirty: false })
  const run = await rig.start(REVIEW, [agent('reviewer', ['approve'])])
  await rig.flows.flush()
  const asked = rig.team.runCheck(1, { name: 'gate' }, rig.sessionOf('seat-1'))
  await started
  try {
    if (action === 'stop') await rig.executions.stop(run.id)
    else rig.flows.interruptChecks(run.goal)
    assert.equal(signal?.aborted, true, 'the check signal reaches checkout creation')
  } finally { release() }
  assert.match(await asked, /checkout was stopped/)
  assert.equal(rig.checkCwds.length, 0, 'no command launched')
})


test('stopping a Flow reaches its retained base checkout before the check launches (#1348)', async (t) => {
  let id = ''
  let signal: AbortSignal | undefined
  let retained: true | undefined
  let begun!: () => void
  const started = new Promise<void>((resolve) => { begun = resolve })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const rig = await goalRig(t, {
    fetchBase: async (_root, base, run) => { id = run; return { ...base, at: 'a'.repeat(40) } },
    checkoutAt: async (_cwd, _at, options) => {
      retained = options?.retained
      signal = options?.signal
      begun()
      await held
      throw new Error('cutting the checkout was stopped')
    },
  })
  const opening = rig.start(`version: 2\nname: Base checkout\nbase: { remote: origin }\nroles:\n  gate: { kind: check, run: 'pnpm test' }\nseed: { role: gate, title: Check }\nrules: []\n`, [])
  await started
  const stopping = rig.executions.stop(id)
  try {
    assert.equal(retained, true)
    assert.equal(signal?.aborted, true, 'Stop reaches the checkout while planning holds the run queue')
  } finally { release() }
  await opening
  assert.equal((await stopping).state, 'stopped')
  assert.equal(rig.checkCwds.length, 0, 'no command launched')
})
