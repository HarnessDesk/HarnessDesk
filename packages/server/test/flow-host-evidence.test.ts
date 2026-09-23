import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { BoardEvidence, FlowExecution, FlowPreview, GoalView, Intent } from '@harnessdesk/protocol'

import type { GhInCheckout } from '../src/evidence/forge.js'
import { INDEPENDENT } from '../src/flow-execution.js'
import { builtinFlowRoot } from '../src/host.js'
import { Host, StateStore } from '../src/index.js'
import { makeRepo } from './fixtures/evidence-desk.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'
import { silent } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/*
 * Every shipped flow, run to its end through the real `Host` against a real
 * git repository — real commits, so every head the guards read is one git
 * reported — with every evidence guard those flows name satisfied by a fact
 * the desk itself recorded: a check it ran, a review a Seat recorded through
 * the same Team verb the plugin tool calls, a diff and a pull request it
 * observed. Nothing here writes a fact by hand, and nothing re-implements the
 * host's evidence wiring: a guard that waits here waits in the app.
 *
 * Two fake runtimes stand in for two vendors, so a step that must be
 * independent of an earlier one has somewhere independent to sit.
 */

const exec = promisify(execFile)

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['-C', cwd, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()

const AGENTS: Readonly<Record<string, { ceiling: string; answers?: string; produces?: string; prefer: string }>> = {
  implementer: { ceiling: 'edit', produces: '[diff]', prefer: 'fake' },
  researcher: { ceiling: 'edit', answers: '[gathered]', produces: '[diff]', prefer: 'fake' },
  'requirements-analyst': { ceiling: 'edit', answers: '[agreed, disagree]', produces: '[diff, review]', prefer: 'fake' },
  judge: { ceiling: 'read', answers: '[picked, neither]', produces: '[review]', prefer: 'fake-b' },
  'editing-judge': { ceiling: 'edit', answers: '[picked, neither]', produces: '[review]', prefer: 'fake-b' },
  'code-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'security-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'api-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'test-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
}

/** What the forge says about a checkout: no pull request, unless the test opened one. */
interface Forge {
  readonly open: Set<string>
  readonly gh: GhInCheckout
}

const forge = (): Forge => {
  const open = new Set<string>()
  const gh: GhInCheckout = async (_args, cwd) => {
    const head = await git(cwd, 'rev-parse', 'HEAD').catch(() => '')
    const branch = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
    if (!open.has(branch)) return { stdout: '', stderr: 'no pull requests found for branch', exitCode: 1 }
    return {
      stdout: JSON.stringify({
        number: 41, state: 'OPEN', headRefOid: head, url: null,
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
      stderr: '',
      exitCode: 0,
    }
  }
  return { open, gh }
}

interface Desk {
  readonly host: Host
  readonly root: string
  readonly forge: Forge
  /** Every run this desk started, so a wait that times out can say where each stood. */
  readonly runs: string[]
  readonly runtimes: readonly FakeRuntime[]
  readonly stateDir: string
  /** Resolves on the host's next notification to its windows: something on the desk moved. */
  readonly moved: () => Promise<void>
}

/** The second runtime: another vendor's by default, so a step independent of the first has somewhere to sit. */
interface Second { readonly id: string; readonly provider?: string | null }

/** How the desk is set up beyond its runtimes: where work happens, and how its agents take a second message. */
interface DeskOptions {
  /** Work stays on the project's default branch, as a step that is neither isolated nor told to branch does. */
  readonly onMain?: boolean
  /** Each runtime refuses a message while a turn is running, as a real agent's adapter does. */
  readonly refusesWhileBusy?: boolean
}

const desk = async (t: TestContext, second: Second = { id: 'fake-b', provider: 'vendor-b' }, options: DeskOptions = {}): Promise<Desk> => {
  const repo = await makeRepo('hd-flow-host-')
  // A committed contest script, so the mechanical contest's own command runs as shipped.
  await mkdir(join(repo.dir, 'script'), { recursive: true })
  await writeFile(join(repo.dir, 'script', 'flow-contest.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(repo.dir, 'script', 'flow-contest.sh'), 0o755)
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'contest script')
  // Work happens on a branch, so what an Agent commits is a real diff against `main` — unless the test says it stays there.
  if (!options.onMain) await repo.git('checkout', '-q', '-b', 'work')
  const gh = forge()
  const stateDir = tempDir('hd-flow-host-state-')
  for (const [id, agent] of Object.entries(AGENTS)) {
    await mkdir(join(stateDir, 'agents', id), { recursive: true })
    await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), [
      '---', `name: ${id}`, `ceiling: ${agent.ceiling}`,
      ...(agent.answers ? [`answers: ${agent.answers}`] : []),
      ...(agent.produces ? [`produces: ${agent.produces}`] : []),
      `prefer: [${agent.prefer === 'fake-b' ? second.id : agent.prefer}]`, '---', `Do the ${id} part.`, '',
    ].join('\n'), 'utf8')
  }
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-flow-host-builtins-'),
    catalogRefreshMs: 0,
    evidence: { gh: gh.gh },
  })
  const runtimes = [
    new FakeRuntime({ provider: 'vendor-a' }),
    new FakeRuntime({ id: second.id as never, name: 'Second Fake', ...(second.provider !== undefined ? { provider: second.provider } : {}) }),
  ]
  for (const runtime of runtimes) {
    runtime.refusesWhileBusy = options.refusesWhileBusy ?? false
    host.register(runtime)
  }
  await host.start()
  t.after(() => host.dispose())
  let wake: (() => void) | null = null
  let next = new Promise<void>((resolve) => { wake = resolve })
  host.addBroadcaster(() => {
    const woken = wake
    next = new Promise<void>((resolve) => { wake = resolve })
    woken?.()
  })
  await host.call('workspace/open', { path: repo.dir })
  return { host, root: repo.dir, forge: gh, runs: [], runtimes, stateDir, moved: () => next }
}

/** A shipped flow's own text, read through the catalogue as a person's window reads it. */
const shipped = async (d: Desk, id: string): Promise<string> =>
  await d.host.call('flow/source', { root: d.root, id }) as string

const start = async (d: Desk, source: string, vars: Readonly<Record<string, string>>): Promise<FlowExecution> => {
  const preview = await d.host.call('flow/preview', { root: d.root, source, vars }) as FlowPreview
  assert.ok(preview.token, `the flow previews clean: ${JSON.stringify(preview.problems)}`)
  const run = await d.host.call('flow/start-goal', { root: d.root, source, token: preview.token!, sentence: 'Finish the change', vars }) as FlowExecution
  d.runs.push(run.id)
  return run
}

const board = async (d: Desk, goal: string): Promise<readonly Intent[]> =>
  (await d.host.call('goal/read', { goal }) as GoalView).board.intents

const execution = async (d: Desk, run: string): Promise<FlowExecution> =>
  await d.host.call('flow/execution', { run }) as FlowExecution

/*
 * Waits for a state of the desk, read again each time the host tells its
 * windows something moved — never on a clock. A slow machine only makes the
 * wait longer; what it waits for either arrives or the run is stuck, which
 * the safety deadline (far past any step's own time) and the dump say.
 */
const SAFETY_MS = 180_000
const whenChanged = async <T>(d: Desk, read: () => Promise<T | null> | T | null, what: string): Promise<T> => {
  const deadline = Date.now() + SAFETY_MS
  for (;;) {
    const moved = d.moved()
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`nothing on the desk moved to ${what} in ${SAFETY_MS} ms`)
    // Re-read when the desk moves, and at the latest every second: nothing is read fifty times a second.
    await Promise.race([moved, new Promise((resolve) => setTimeout(resolve, 1_000))])
  }
}

/**
 * The open cards of one role once every one of them is claimed by its Seat
 * and that Seat has been handed its order — the moment an agent starts on
 * its card, and not before: a card is claimed while its Seat is still being
 * journaled, and an agent is never told about it until that is done.
 */
const claimed = async (d: Desk, goal: string, role: string, count: number): Promise<readonly Intent[]> =>
  explained(d, goal, whenChanged(d, async () => {
    const cards = (await board(d, goal)).filter((one) => one.role === role && one.state !== 'done')
    if (cards.length !== count || !cards.every((one) => one.state === 'claimed' && one.claim)) return null
    // Handed: sent, or left for the end of the turn its Seat is already in (its brief's), where it asks for work.
    const ordered = (await Promise.all(d.runs.map((run) => execution(d, run)))).flatMap((run) => run.operations)
      .filter((one) => one.kind === 'turn' && (one.state === 'finished' || one.state === 'prepared'))
    return cards.every((card) => ordered.some((one) => one.card === card.id)) ? cards : null
  }, `${count} claimed ${role} card(s), each handed to its Seat`))

/** A wait that timed out says where the run and its board stood, rather than only that it waited. */
const explained = async <T>(d: Desk, goal: string, waiting: Promise<T>): Promise<T> => {
  try {
    return await waiting
  } catch (error) {
    const cards = (await board(d, goal)).map((one) => `#${one.id} ${one.role} ${one.state} ${one.outcome ?? ''}`)
    const runs = await Promise.all(d.runs.map((run) => execution(d, run)))
    const stood = runs.map((run) => `${run.state} ${run.reason ?? ''} ${run.rounds.map((one) => `${one.role}:${one.state}`).join(',')}`)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${cards.join('\n')}\n${stood.join('\n')}`)
  }
}

const scopeOf = (card: Intent) => ({ runtime: card.claim!.runtime, sessionId: card.claim!.sessionId })

const cwdOf = (d: Desk, card: Intent): string => {
  const record = d.host.registry.get(card.claim!.runtime as never, card.claim!.sessionId as never)
  assert.ok(record, `card #${card.id}'s conversation is held by the desk`)
  return record.session.cwd
}

/** A writer does its work: a real commit in its own checkout, then it finishes its card. */
const write = async (d: Desk, card: Intent, text: string, outcome?: string): Promise<string> => {
  const cwd = cwdOf(d, card)
  await writeFile(join(cwd, 'attempt.txt'), `${text}\n`)
  await git(cwd, 'add', 'attempt.txt')
  await git(cwd, 'commit', '-q', '-m', text)
  const head = await git(cwd, 'rev-parse', 'HEAD')
  const said = await d.host.teamPlane.complete(card.id, outcome ? { outcome } : {}, scopeOf(card))
  assert.doesNotMatch(said, /^Refused/, said)
  return head
}

/** A reviewer judges through the structured review verb, never through words, then finishes its card. */
const review = async (d: Desk, card: Intent, verdict: string, pick?: string): Promise<void> => {
  const scope = scopeOf(card)
  const candidates = await d.host.teamPlane.reviewCandidates(card.id, scope)
  assert.ok(candidates.length > 0, `card #${card.id} is offered something to review`)
  const chosen = pick ? candidates.find((one) => one.at === pick) : candidates[0]
  assert.ok(chosen, `the revision ${pick} is one of the candidates offered`)
  await d.host.teamPlane.recordReview({ intent: card.id, candidate: chosen!.id, verdict }, scope)
  const said = await d.host.teamPlane.complete(card.id, { outcome: verdict }, scope)
  assert.doesNotMatch(said, /^Refused/, said)
}

/** A card with nothing to judge answers directly. */
const answer = async (d: Desk, card: Intent, outcome: string): Promise<void> => {
  const said = await d.host.teamPlane.complete(card.id, { outcome }, scopeOf(card))
  assert.doesNotMatch(said, /^Refused/, said)
}

/** A person's card, answered from the board the way a window answers it. */
const person = async (d: Desk, goal: string, role: string, outcome: string): Promise<Intent> => {
  const card = await explained(d, goal, whenChanged(d, async () => (await board(d, goal)).find((one) => one.role === role && one.state !== 'done') ?? null,
    `the ${role} card`))
  await d.host.call('team/intent', { room: goal, id: card.id, action: 'done', outcome })
  return card
}

const settled = async (d: Desk, run: string): Promise<FlowExecution> =>
  whenChanged(d, async () => {
    const now = await execution(d, run)
    assert.notEqual(now.state, 'stalled', `the run stalled: ${now.reason}`)
    return now.state === 'settled' ? now : null
  }, 'the run to reach its end')

const TASK = { task: 'Make the attempt file say something useful' }

/** The shipped comparison, its check command pointed at this scratch repository's own test: a person's `pnpm verify` is theirs. */
const comparison = async (d: Desk, count: number): Promise<string> => {
  const text = await shipped(d, 'comparison')
  assert.match(text, /run: "pnpm verify"/)
  const pointed = text.replace('run: "pnpm verify"', 'run: "test -s attempt.txt"')
  return count === 1 ? pointed : pointed.replace('    isolate: true\n', `    count: ${count}\n    isolate: true\n`)
}

for (const count of [1, 2]) {
  test(`comparison with ${count} competitor(s): the judge's recorded review carries the picked revision to the merge card`, async (t) => {
    const d = await desk(t)
    const run = await start(d, await comparison(d, count), TASK)
    const competitors = await claimed(d, run.goal, 'competitor', count)
    const heads: string[] = []
    for (const [index, card] of competitors.entries()) heads.push(await write(d, card, `attempt ${index + 1}`))
    assert.equal(new Set(competitors.map((one) => cwdOf(d, one))).size, count, 'each competitor has its own checkout')

    const [judge] = await claimed(d, run.goal, 'judge', 1)
    const verifies = (await board(d, run.goal)).filter((one) => one.role === 'verify')
    assert.equal(verifies.length, count, 'one check card per competitor revision')
    assert.ok(verifies.every((one) => one.outcome === 'pass'))
    const picked = heads.at(-1)!
    await review(d, judge!, 'picked', picked)

    const referee = await person(d, run.goal, 'referee', 'merged')
    assert.match(`${referee.title}\n${referee.detail ?? ''}`, new RegExp(picked), 'the merge card names the exact revision the judge picked')
    const done = await settled(d, run.id)
    const refereeRound = done.rounds.find((one) => one.role === 'referee')!
    assert.ok(refereeRound.evidence.length > 0, 'the merge round keeps the fact ids that authorized it')
  })
}

/*
 * A judge that may change files is still a judge: the revision it is judged
 * on is the one it picked among its predecessors, never its own checkout's
 * head — the same walk its candidates came from.
 */
test('a judge granted edit is judged on the competitor it picked, never on its own checkout', async (t) => {
  const d = await desk(t)
  const text = await comparison(d, 1)
  assert.match(text, /uses: \[judge\]\n    grant: read\n/)
  const run = await start(d, text.replace('uses: [judge]\n    grant: read\n', 'uses: [editing-judge]\n    grant: edit\n'), TASK)
  const [competitor] = await claimed(d, run.goal, 'competitor', 1)
  const picked = await write(d, competitor!, 'attempt 1')
  const [judge] = await claimed(d, run.goal, 'judge', 1)
  assert.notEqual(await git(cwdOf(d, judge!), 'rev-parse', 'HEAD'), picked, 'the judge sits on a head of its own')
  await review(d, judge!, 'picked', picked)
  const referee = await person(d, run.goal, 'referee', 'merged')
  assert.match(referee.detail ?? '', new RegExp(picked))
  await settled(d, run.id)
})

test('investigation: an observed diff of the committed answer opens the close-out, woken by the evidence plane', async (t) => {
  const d = await desk(t)
  // What a window is told: every change to the run's state, pushed whole, not only when it asks.
  const told: FlowExecution[] = []
  d.host.addBroadcaster((notification) => {
    if (notification.method === 'flow/execution-changed') told.push(notification.params.execution)
  })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  await write(d, research!, 'the answer', 'gathered')
  await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  await whenChanged(d, () => (told.findLast((one) => one.id === run.id)?.state === 'settled' ? true : null), 'the settled run pushed to windows')
  assert.ok(told.some((one) => one.id === run.id && one.state === 'running' && one.rounds.length === 1), 'its first round was pushed too')
  const close = done.rounds.find((one) => one.role === 'close')!
  assert.equal(close.evidence.length, 1, 'the close-out round names the diff fact that opened it')
})

/*
 * The shipped Investigation as it runs by default: its researcher is not
 * isolated and is not told to branch, so it commits on the project's own
 * default branch. The diff that guard reads is what was committed since the
 * step began, so the close-out still opens.
 */
test('investigation on the default branch: the answer committed since the step began opens the close-out', async (t) => {
  const d = await desk(t, undefined, { onMain: true })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  assert.equal(await git(cwdOf(d, research!), 'symbolic-ref', '--short', 'HEAD'), 'main', 'the researcher works on the default branch')
  const before = await git(cwdOf(d, research!), 'rev-parse', 'HEAD')
  const head = await write(d, research!, 'the answer', 'gathered')
  await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  const close = done.rounds.find((one) => one.role === 'close')!
  assert.equal(close.evidence.length, 1, 'the close-out round names the diff fact that opened it')
  const facts = await d.host.call('evidence/board', { room: run.goal }) as BoardEvidence
  const diff = facts.cards.flatMap((card) => card.facts).map((one) => one.record.fact).find((fact) => fact.kind === 'diff')
  assert.ok(diff?.kind === 'diff', 'the desk observed a diff')
  assert.deepEqual({ from: diff.from, to: diff.to, files: diff.files }, { from: before, to: head, files: 1 })
})

/*
 * A step that commits nothing has no diff to read. The run neither sits on
 * "running" in silence nor ends without a word: while the desk has not looked
 * yet it says what it waits for, and once it has, it ends saying which rule
 * did not apply and why.
 */
test('investigation with nothing committed ends saying there was no committed change to read', async (t) => {
  const d = await desk(t, undefined, { onMain: true })
  const told: FlowExecution[] = []
  d.host.addBroadcaster((notification) => {
    if (notification.method === 'flow/execution-changed') told.push(notification.params.execution)
  })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  await answer(d, research!, 'gathered')
  const done = await settled(d, run.id)
  assert.match(done.reason!, /to-close did not apply/)
  assert.match(done.reason!, new RegExp(`card #${research!.id}'s checkout has no committed change since its step began`))
  for (const one of told.filter((each) => each.id === run.id && each.rounds.at(-1)?.state === 'waiting-evidence')) {
    assert.match(one.reason ?? '', /^Rule to-close: /, 'a run waiting on evidence says what for')
  }
})

/*
 * A real agent reads its brief in a turn of its own, and a busy agent refuses
 * a second message until that turn ends. An agent that simply gets on with
 * its card inside that first turn — waits for work, finds its card already
 * claimed for it, does it, completes it — is the ordinary case, not a race:
 * the run follows the board, never stalls on "still working", and the
 * completion is on disk.
 */
type Behaviour = (d: Desk, card: Intent) => Promise<void>

/** Every Seat, handed its brief, works its own card inside that same turn, then ends the turn. */
const workInsideTheBrief = (d: Desk, behaviours: Readonly<Record<string, Behaviour>>): void => {
  for (const runtime of d.runtimes) {
    runtime.onSend = (session, text, opts) => {
      if (opts?.recordAs !== 'notice' || !text.startsWith('Do the ')) return
      void (async () => {
        const mine = await whenChanged(d, async () => {
          for (const goal of new Set((await Promise.all(d.runs.map((run) => execution(d, run)))).map((run) => run.goal))) {
            const card = (await board(d, goal)).find((one) => one.state === 'claimed' &&
              one.claim?.runtime === runtime.info.id && one.claim.sessionId === String(session.id))
            if (card) return card
          }
          return null
        }, 'the card claimed for this Seat')
        await behaviours[mine.role ?? '']!(d, mine)
        session.finish()
      })().catch((error: unknown) => { console.error('a working agent failed', error) })
    }
  }
}

test('a Seat that works its card inside its brief turn: the run follows the board and never stalls on "still working"', async (t) => {
  const d = await desk(t, undefined, { refusesWhileBusy: true, onMain: true })
  workInsideTheBrief(d, {
    research: async (desk, card) => { await write(desk, card, 'the answer', 'gathered') },
  })
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const close = await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map((one) => [one.role, one.state]), [['research', 'closed'], ['close', 'closed']])
  const research = (await board(d, run.goal)).find((one) => one.role === 'research')!
  assert.equal(research.state, 'done')
  assert.equal(research.outcome, 'gathered')
  assert.ok(close)
})

test('independent review with every Seat working inside its brief: each completion persists and the specialists open', async (t) => {
  const d = await desk(t, undefined, { refusesWhileBusy: true })
  // A reviewer asks for what it may judge until it is offered something, as an agent working its card does.
  const reviewInside: Behaviour = async (desk, card) => {
    await whenChanged(desk, async () => ((await desk.host.teamPlane.reviewCandidates(card.id, scopeOf(card))).length > 0 ? true : null), 'something to review')
    await review(desk, card, 'approve')
  }
  workInsideTheBrief(d, {
    build: async (desk, card) => { await write(desk, card, 'built') },
    specialists: reviewInside,
  })
  const run = await start(d, await shipped(d, 'independent-review'), TASK)
  await person(d, run.goal, 'ship', 'shipped')
  const done = await settled(d, run.id)
  assert.deepEqual(done.rounds.map((one) => one.role), ['build', 'specialists', 'ship'])
  const cards = await board(d, run.goal)
  assert.deepEqual(cards.map((one) => [one.role, one.state]), [['build', 'done'], ['specialists', 'done'], ['specialists', 'done'], ['ship', 'done']])
  // Nothing re-opened a finished card: no card was handed a second order after it was done.
  const reordered = done.operations.filter((one) => one.kind === 'turn' && one.state !== 'finished' && one.state !== 'prepared')
  assert.deepEqual(reordered, [])
})

/*
 * A Seat that only reads its brief — the ordinary agent, which answers and
 * ends its turn — has its card handed over when that turn is over: the
 * order left for it goes out exactly once, whether the turn ended well or
 * in an error, and the Seat then finishes the card in the turn it started.
 */
for (const ending of ['completes', 'fails'] as const) {
  test(`a brief turn that ${ending} with the card still open is followed by exactly one card order`, async (t) => {
    const d = await desk(t, undefined, { refusesWhileBusy: true })
    const orders: string[] = []
    for (const runtime of d.runtimes) {
      runtime.onSend = (session, text, opts) => {
        if (opts?.recordAs !== 'notice') return
        if (text.startsWith('Do the ')) {
          // Reads its brief, and ends its turn without asking for work — once the run has left its order for that.
          void whenChanged(d, async () => {
            const id = d.runs[0]
            const prepared = id ? (await execution(d, id)).operations.some((one) => one.key === 'turn:1:0' && one.state === 'prepared') : false
            return prepared ? true : null
          }, 'the order left for the end of the brief turn')
            .then(() => (ending === 'completes' ? session.finish() : session.fail('the model is overloaded')))
            .catch((error: unknown) => { console.error('a reading agent failed', error) })
          return
        }
        const card = /^Card #(\d+) on this Goal is yours/.exec(text)
        if (!card) return
        orders.push(card[1]!)
        void (async () => {
          const id = await whenChanged(d, () => d.runs[0] ?? null, 'the run to be started')
          const goal = (await execution(d, id)).goal
          const held = (await board(d, goal)).find((one) => one.id === Number(card[1]))!
          await write(d, held, 'the answer', 'gathered')
          session.finish()
        })().catch((error: unknown) => { console.error('a working agent failed', error) })
      }
    }
    const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
    await person(d, run.goal, 'close', 'closed')
    const done = await settled(d, run.id)
    assert.deepEqual(orders, ['1'], 'the card was handed over once, after the brief turn')
    assert.equal(done.operations.find((one) => one.key === 'turn:1:0')?.state, 'finished')
    assert.deepEqual(done.operations.filter((one) => one.kind === 'turn').map((one) => one.key), ['turn:1:0'])
  })
}

test('a check, green CI and an open pull request, each observed at the build revision, open the ship card together', async (t) => {
  const d = await desk(t)
  const source = [
    'version: 2',
    'name: Guarded ship',
    'inputs:',
    '  task:',
    '    label: Task',
    'roles:',
    '  build: { kind: agent, uses: implementer, grant: edit, isolate: true }',
    '  verify: { kind: check, run: "test -s attempt.txt", exits: { "0": pass }, otherwise: fail, timeout: 60 }',
    '  ship: { kind: person, outcomes: [shipped] }',
    'seed: { role: build, title: "{{task}}" }',
    'rules:',
    '  - { id: to-verify, on: build, then: { role: verify, title: Check it } }',
    '  - id: to-ship',
    '    on: verify',
    '    when: { every: [pass], evidence: [{ check: "test -s attempt.txt" }, { ci: green }, { pr: open }] }',
    '    then: { role: ship, title: "Ship pull request {{evidence.pr.number}} at {{evidence.check.at}}" }',
    'messaging: board-only',
    'wait: 240',
    '',
  ].join('\n')
  const run = await start(d, source, TASK)
  const [build] = await claimed(d, run.goal, 'build', 1)
  d.forge.open.add(await git(cwdOf(d, build!), 'symbolic-ref', '--short', 'HEAD'))
  const head = await write(d, build!, 'the build')
  const ship = await person(d, run.goal, 'ship', 'shipped')
  assert.equal(ship.title, `Ship pull request 41 at ${head}`)
  const done = await settled(d, run.id)
  assert.equal(done.rounds.find((one) => one.role === 'ship')!.evidence.length, 3, 'one fact for each guard')
})

test('the other shipped flows each reach their end', async (t) => {
  await t.test('alignment', async (t) => {
    const d = await desk(t)
    const run = await start(d, await shipped(d, 'alignment'), TASK)
    await answer(d, (await claimed(d, run.goal, 'propose', 1))[0]!, 'agreed')
    await person(d, run.goal, 'align', 'agreed')
    await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
    await settled(d, run.id)
  })
  await t.test('fan-out review', async (t) => {
    const d = await desk(t)
    const run = await start(d, await shipped(d, 'fan-out'), TASK)
    await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
    for (const card of await claimed(d, run.goal, 'review', 3)) await review(d, card, 'approve')
    await person(d, run.goal, 'ship', 'shipped')
    await settled(d, run.id)
  })
  await t.test('independent review', async (t) => {
    const d = await desk(t)
    const run = await start(d, await shipped(d, 'independent-review'), TASK)
    await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
    for (const card of await claimed(d, run.goal, 'specialists', 2)) await review(d, card, 'approve')
    await person(d, run.goal, 'ship', 'shipped')
    await settled(d, run.id)
  })
  await t.test('mechanical contest', async (t) => {
    const d = await desk(t)
    const run = await start(d, await shipped(d, 'mechanical-contest'), TASK)
    const competitors = await claimed(d, run.goal, 'competitor', 2)
    for (const [index, card] of competitors.entries()) await write(d, card, `attempt ${index + 1}`)
    await person(d, run.goal, 'referee', 'merged')
    await settled(d, run.id)
  })
  await t.test('staged relay', async (t) => {
    const d = await desk(t)
    const run = await start(d, await shipped(d, 'staged-relay'), TASK)
    await answer(d, (await claimed(d, run.goal, 'analyze', 1))[0]!, 'agreed')
    await write(d, (await claimed(d, run.goal, 'build', 1))[0]!, 'built')
    await review(d, (await claimed(d, run.goal, 'test_review', 1))[0]!, 'approve')
    await person(d, run.goal, 'ship', 'shipped')
    await settled(d, run.id)
  })
})

/*
 * Independence is read from what each runtime's adapter reports about the
 * vendor behind it. A runtime that cannot rule out an override reports
 * none, and one that says nothing is unknown too — even one whose id names
 * a vendor. Either way the judge is refused a seat, never assumed
 * independent.
 */
const UNKNOWN: readonly (Second & { readonly why: string })[] = [
  { id: 'fake-b', provider: null, why: 'reporting an unknown provider' },
  { id: 'codex', why: 'reporting no provider, named for a vendor' },
]
for (const second of UNKNOWN) {
  test(`a judge on a runtime ${second.why} is never taken for independent`, async (t) => {
    const d = await desk(t, second)
    const run = await start(d, await comparison(d, 1), TASK)
    const [competitor] = await claimed(d, run.goal, 'competitor', 1)
    await write(d, competitor!, 'attempt 1')
    const stalled = await whenChanged(d, async () => {
      const now = await execution(d, run.id)
      return now.state === 'stalled' ? now : null
    }, 'the run to stall at the judge')
    assert.equal(stalled.reason, INDEPENDENT)
    assert.equal((await board(d, run.goal)).find((one) => one.role === 'judge')?.state, 'open', 'no Seat took the judge’s card')
  })
}

test('every flow that ships is one this file runs to its end', async () => {
  const ids = (await readdir(builtinFlowRoot())).filter((one) => one.endsWith('.yml')).map((one) => one.slice(0, -4)).sort()
  assert.deepEqual(ids, ['alignment', 'comparison', 'fan-out', 'independent-review', 'investigation', 'mechanical-contest', 'staged-relay'])
})
