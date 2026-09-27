import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { BoardEvidence, FlowExecution, FlowPreview, GoalView, Intent } from '@harnessdesk/protocol'

import { TAIL_LIMIT } from '../src/evidence/run.js'
import { Host, StateStore } from '../src/index.js'
import { makeRepo, type Repo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * Issue #1082, on the real path: a Seat's own sandbox may refuse a child
 * process a listening socket, so a reviewer could not tell "my change is
 * broken" from "my sandbox will not let me check". `run_check` asks the host
 * to run one of the flow's declared checks in the card's checkout, exactly as
 * a check card runs it. A real `Host`, a real repository; the agents are fakes.
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

const LOUD = `process.stdout.write('x'.repeat(${TAIL_LIMIT * 3}) + '\\nthe end\\n')\n`
const SLOW = 'setTimeout(() => {}, 60_000)\n'
/** Runs until a flag file appears in its folder: what holds a check running while a second call arrives. */
const WAITS = `
import { existsSync, writeFileSync } from 'node:fs'
writeFileSync('started.flag', '')
const tick = () => existsSync('go.flag') ? process.exit(0) : setTimeout(tick, 20)
tick()
`

const FLOW = [
  'version: 2', 'name: Review with checks', 'roles:',
  '  reviewer: { kind: agent, uses: reviewer, grant: read, count: 2 }',
  '  listen: { kind: check, run: "node listen.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  loud: { kind: check, run: "node loud.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  '  slow: { kind: check, run: "node slow.mjs", exits: { "0": pass }, otherwise: fail, timeout: 1 }',
  '  waits: { kind: check, run: "node waits.mjs", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
  'seed: { role: reviewer, title: Review it }', 'rules: []', '',
].join('\n')

interface Desk {
  readonly host: Host
  readonly repo: Repo
  readonly goal: string
  readonly cards: readonly Intent[]
  readonly scopeOf: (card: Intent) => { runtime: string; sessionId: string }
}

const desk = async (t: TestContext, flow: string = FLOW): Promise<Desk> => {
  const repo = await makeRepo('hd-flow-run-check-')
  await writeFile(join(repo.dir, 'listen.mjs'), LISTEN)
  await writeFile(join(repo.dir, 'loud.mjs'), LOUD)
  await writeFile(join(repo.dir, 'slow.mjs'), SLOW)
  await writeFile(join(repo.dir, 'waits.mjs'), WAITS)
  await writeFile(join(repo.dir, '.gitignore'), 'go.flag\nstarted.flag\n')
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'checks')
  const stateDir = await mkdtemp(join(tmpdir(), 'hd-flow-run-check-state-'))
  const builtinAgents = tempDir('hd-flow-run-check-builtins-')
  await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'reviewer', 'AGENT.md'), [
    '---', 'name: reviewer', 'ceiling: read', 'produces: [review]', 'prefer: [fake]', '---', 'Review the work.', '',
  ].join('\n'), 'utf8')
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
  const started = await host.call('flow/start-goal', { root: repo.dir, source: flow, token: preview.token!, sentence: 'Review it' }) as FlowExecution
  const goal = started.goal
  const deadline = Date.now() + 15_000
  let cards = (await host.call('goal/read', { goal }) as GoalView).board.intents
  while (cards.length !== 2 || cards.some((one) => one.state !== 'claimed')) {
    if (Date.now() > deadline) throw new Error(`the cards never claimed: ${JSON.stringify(cards)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    cards = (await host.call('goal/read', { goal }) as GoalView).board.intents
  }
  return { host, repo, goal, cards, scopeOf: (card) => ({ runtime: card.claim!.runtime, sessionId: card.claim!.sessionId }) }
}

test('a declared check that starts a real server passes through run_check, host-side, and is recorded as the card’s check evidence', async (t) => {
  const { host, repo, goal, cards, scopeOf } = await desk(t)
  const card = cards[0]!
  const answer = await host.teamPlane.runCheck(card.id, 'listen', scopeOf(card))
  assert.match(answer, /^listen passed \(exit 0\)/, answer)
  assert.match(answer, /answered pong on a real port/, 'with what it printed')
  const board = await host.call('evidence/board', { room: goal }) as BoardEvidence
  const facts = board.cards.find((one) => one.card === card.id)?.facts ?? []
  const check = facts.map((one) => one.record.fact).find((fact) => fact.kind === 'check')
  assert.ok(check && check.kind === 'check', `a check fact on #${card.id}: ${JSON.stringify(facts)}`)
  assert.equal(check.name, 'listen')
  assert.equal(check.run, 'node listen.mjs', 'the declared command, verbatim')
  assert.equal(check.exit, 0)
  assert.equal(check.at, await repo.git('rev-parse', 'HEAD'), 'bound to the checkout’s commit')
})

test('run_check refuses a name the flow does not declare, and names the ones it does', async (t) => {
  const { host, cards, scopeOf } = await desk(t)
  const answer = await host.teamPlane.runCheck(cards[0]!.id, 'rm -rf .', scopeOf(cards[0]!))
  assert.match(answer, /^Refused: /)
  assert.match(answer, /listen, loud, slow, waits/, answer)
  const unnamed = await host.teamPlane.runCheck(cards[0]!.id, undefined, scopeOf(cards[0]!))
  assert.match(unnamed, /^Refused: .*name one/, 'several checks and no name is refused, not guessed')
})

test('run_check refuses a caller that does not hold the card', async (t) => {
  const { host, cards, scopeOf } = await desk(t)
  const answer = await host.teamPlane.runCheck(cards[0]!.id, 'listen', scopeOf(cards[1]!))
  assert.equal(answer, `Refused: you do not hold #${cards[0]!.id}, so you cannot run a check for it.`)
})

test('run_check refuses in one sentence when the flow declares no check', async (t) => {
  const flow = [
    'version: 2', 'name: Review only', 'roles:',
    '  reviewer: { kind: agent, uses: reviewer, grant: read, count: 2 }',
    'seed: { role: reviewer, title: Review it }', 'rules: []', '',
  ].join('\n')
  const { host, cards, scopeOf } = await desk(t, flow)
  const answer = await host.teamPlane.runCheck(cards[0]!.id, 'listen', scopeOf(cards[0]!))
  assert.equal(answer, 'Refused: this card’s flow declares no check, so there is nothing to run.')
})

test('run_check holds a check to its declared timeout and its output to the evidence cap', async (t) => {
  const { host, cards, scopeOf } = await desk(t)
  const card = cards[0]!
  const slow = await host.teamPlane.runCheck(card.id, 'slow', scopeOf(card))
  assert.match(slow, /^slow ran over its 1 s limit and was stopped/, slow)
  const loud = await host.teamPlane.runCheck(card.id, 'loud', scopeOf(card))
  assert.match(loud, /^loud passed \(exit 0\)/, loud)
  assert.match(loud, /the end/, 'the last of what it printed')
  assert.ok(loud.length < TAIL_LIMIT + 400, `bounded output: ${loud.length} characters`)
})

test('run_check never runs the same check twice at once in one checkout', async (t) => {
  const { host, repo, cards, scopeOf } = await desk(t)
  const first = host.teamPlane.runCheck(cards[0]!.id, 'waits', scopeOf(cards[0]!))
  // The first has started once its command has written its flag, and holds until go.flag exists.
  const deadline = Date.now() + 15_000
  while (!existsSync(join(repo.dir, 'started.flag'))) {
    if (Date.now() > deadline) throw new Error('the first run never started')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const second = await host.teamPlane.runCheck(cards[1]!.id, 'waits', scopeOf(cards[1]!))
  assert.equal(second, 'Refused: waits is already running in this checkout; wait for it, then read its result on the card or run it again.')
  await writeFile(join(repo.dir, 'go.flag'), '')
  assert.match(await first, /^waits passed/)
  assert.match(await host.teamPlane.runCheck(cards[1]!.id, 'waits', scopeOf(cards[1]!)), /^waits passed/, 'and runs once the first is done')
})
