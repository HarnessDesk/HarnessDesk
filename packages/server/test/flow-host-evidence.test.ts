import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { FlowExecution, FlowPreview, GoalView, Intent } from '@harnessdesk/protocol'

import type { GhInCheckout } from '../src/evidence/forge.js'
import { builtinFlowRoot } from '../src/host.js'
import { Host, StateStore } from '../src/index.js'
import { makeRepo, until } from './fixtures/evidence-desk.js'
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
}

const desk = async (t: TestContext): Promise<Desk> => {
  const repo = await makeRepo('hd-flow-host-')
  // A committed contest script, so the mechanical contest's own command runs as shipped.
  await mkdir(join(repo.dir, 'script'), { recursive: true })
  await writeFile(join(repo.dir, 'script', 'flow-contest.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(repo.dir, 'script', 'flow-contest.sh'), 0o755)
  await repo.git('add', '.')
  await repo.git('commit', '-q', '-m', 'contest script')
  // Work happens on a branch, so what an Agent commits is a real diff against `main`.
  await repo.git('checkout', '-q', '-b', 'work')
  const gh = forge()
  const stateDir = tempDir('hd-flow-host-state-')
  for (const [id, agent] of Object.entries(AGENTS)) {
    await mkdir(join(stateDir, 'agents', id), { recursive: true })
    await writeFile(join(stateDir, 'agents', id, 'AGENT.md'), [
      '---', `name: ${id}`, `ceiling: ${agent.ceiling}`,
      ...(agent.answers ? [`answers: ${agent.answers}`] : []),
      ...(agent.produces ? [`produces: ${agent.produces}`] : []),
      `prefer: [${agent.prefer}]`, '---', `Do the ${id} part.`, '',
    ].join('\n'), 'utf8')
  }
  const host = new Host({
    logger: silent,
    state: new StateStore(join(stateDir, 'state.json')),
    builtinAgents: tempDir('hd-flow-host-builtins-'),
    catalogRefreshMs: 0,
    evidence: { gh: gh.gh },
    providers: { fake: 'vendor-a', 'fake-b': 'vendor-b' },
  })
  host.register(new FakeRuntime())
  host.register(new FakeRuntime({ id: 'fake-b' as never, name: 'Second Fake' }))
  await host.start()
  t.after(() => host.dispose())
  await host.call('workspace/open', { path: repo.dir })
  return { host, root: repo.dir, forge: gh, runs: [] }
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

/** The open cards of one role once every one of them is claimed by its Seat. */
const claimed = async (d: Desk, goal: string, role: string, count: number): Promise<readonly Intent[]> =>
  explained(d, goal, until(async () => {
    const cards = (await board(d, goal)).filter((one) => one.role === role && one.state !== 'done')
    return cards.length === count && cards.every((one) => one.state === 'claimed' && one.claim) ? cards : null
  }, `${count} claimed ${role} card(s)`, 20_000))

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
  const card = await explained(d, goal, until(async () => (await board(d, goal)).find((one) => one.role === role && one.state !== 'done') ?? null,
    `the ${role} card`, 20_000))
  await d.host.call('team/intent', { room: goal, id: card.id, action: 'done', outcome })
  return card
}

const settled = async (d: Desk, run: string): Promise<FlowExecution> =>
  until(async () => {
    const now = await execution(d, run)
    assert.notEqual(now.state, 'stalled', `the run stalled: ${now.reason}`)
    return now.state === 'settled' ? now : null
  }, 'the run to reach its end', 20_000)

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

test('investigation: an observed diff of the committed answer opens the close-out, woken by the evidence plane', async (t) => {
  const d = await desk(t)
  const run = await start(d, await shipped(d, 'investigation'), { question: 'Where does the time go?' })
  const [research] = await claimed(d, run.goal, 'research', 1)
  await write(d, research!, 'the answer', 'gathered')
  await person(d, run.goal, 'close', 'closed')
  const done = await settled(d, run.id)
  const close = done.rounds.find((one) => one.role === 'close')!
  assert.equal(close.evidence.length, 1, 'the close-out round names the diff fact that opened it')
})

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

test('every flow that ships is one this file runs to its end', async () => {
  const ids = (await readdir(builtinFlowRoot())).filter((one) => one.endsWith('.yml')).map((one) => one.slice(0, -4)).sort()
  assert.deepEqual(ids, ['alignment', 'comparison', 'fan-out', 'independent-review', 'investigation', 'mechanical-contest', 'staged-relay'])
})
