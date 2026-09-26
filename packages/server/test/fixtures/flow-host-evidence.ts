import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'

import type { FlowExecution, FlowPreview, GoalView, Intent } from '@harnessdesk/protocol'

import type { GhInCheckout } from '../../src/evidence/forge.js'
import { Host, StateStore } from '../../src/index.js'
import { makeRepo } from './evidence-desk.js'
import { FakeRuntime } from './fake-runtime.js'
import { silent } from './harness.js'
import { tempDir } from '../scratch.js'

/*
 * The rig every `flow-host-evidence-*.test.ts` file drives: every shipped
 * flow, run to its end through the real `Host` against a real git
 * repository — real commits, so every head the guards read is one git
 * reported — with every evidence guard those flows name satisfied by a fact
 * the desk itself recorded: a check it ran, a review a Seat recorded through
 * the same Team verb the plugin tool calls, a diff and a pull request it
 * observed. Nothing here writes a fact by hand, and nothing re-implements the
 * host's evidence wiring: a guard that waits here waits in the app.
 *
 * Two fake runtimes stand in for two vendors, so a step that must be
 * independent of an earlier one has somewhere independent to sit.
 *
 * This module holds no `test(...)` of its own — one file's cases, shared so
 * that node can run several files, and their cases, in parallel.
 */

const exec = promisify(execFile)

export const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['-C', cwd, '-c', 'user.email=dev@example.com', '-c', 'user.name=Jane Doe', ...args])).stdout.trim()

const AGENTS: Readonly<Record<string, { ceiling: string; answers?: string; produces?: string; prefer: string }>> = {
  implementer: { ceiling: 'edit', produces: '[diff]', prefer: 'fake' },
  researcher: { ceiling: 'edit', answers: '[gathered]', produces: '[diff]', prefer: 'fake' },
  'requirements-analyst': { ceiling: 'edit', answers: '[agreed, disagree]', produces: '[diff, review]', prefer: 'fake' },
  judge: { ceiling: 'read', answers: '[picked, neither]', produces: '[review]', prefer: 'fake-b' },
  'editing-judge': { ceiling: 'edit', answers: '[picked, neither]', produces: '[review]', prefer: 'fake-b' },
  'code-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'security-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'performance-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'api-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
  'test-reviewer': { ceiling: 'read', answers: '[approve, request-changes]', produces: '[review]', prefer: 'fake-b' },
}

/** What the forge says about a checkout: no pull request, unless the test opened one. */
export interface Forge {
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

export interface Desk {
  readonly host: Host
  readonly root: string
  readonly forge: Forge
  /** Every run this desk started, so a wait that times out can say where each stood. */
  readonly runs: string[]
  readonly runtimes: readonly FakeRuntime[]
  readonly stateDir: string
  /** Resolves on the host's next notification to its windows: something on the desk moved. */
  readonly moved: () => Promise<void>
  /** What went wrong inside a fake agent's own turn, so a wait that times out can say it rather than only stderr. */
  readonly problems: string[]
}

/** The second runtime: another vendor's by default, so a step independent of the first has somewhere to sit. */
export interface Second { readonly id: string; readonly provider?: string | null }

/** How the desk is set up beyond its runtimes: where work happens, and how its agents take a second message. */
export interface DeskOptions {
  /** Work stays on the project's default branch, as a step that is neither isolated nor told to branch does. */
  readonly onMain?: boolean
  /** Each runtime refuses a message while a turn is running, as a real agent's adapter does. */
  readonly refusesWhileBusy?: boolean
}

export const desk = async (t: TestContext, second: Second = { id: 'fake-b', provider: 'vendor-b' }, options: DeskOptions = {}): Promise<Desk> => {
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
  return { host, root: repo.dir, forge: gh, runs: [], runtimes, stateDir, moved: () => next, problems: [] }
}

/** A shipped flow's own text, read through the catalogue as a person's window reads it. */
export const shipped = async (d: Desk, id: string): Promise<string> =>
  await d.host.call('flow/source', { root: d.root, id }) as string

export const start = async (d: Desk, source: string, vars: Readonly<Record<string, string>>): Promise<FlowExecution> => {
  const preview = await d.host.call('flow/preview', { root: d.root, source, vars }) as FlowPreview
  assert.ok(preview.token, `the flow previews clean: ${JSON.stringify(preview.problems)}`)
  const run = await d.host.call('flow/start-goal', { root: d.root, source, token: preview.token!, sentence: 'Finish the change', vars }) as FlowExecution
  d.runs.push(run.id)
  return run
}

export const board = async (d: Desk, goal: string): Promise<readonly Intent[]> =>
  (await d.host.call('goal/read', { goal }) as GoalView).board.intents

export const execution = async (d: Desk, run: string): Promise<FlowExecution> =>
  await d.host.call('flow/execution', { run }) as FlowExecution

/*
 * Waits for a state of the desk, read again the instant the host tells its
 * windows something moved — never on a clock. When nothing moves yet, the
 * fallback re-read is short and backs off while it keeps missing, so a slow
 * or busy run costs at most a fraction of a second of extra latency per
 * step, not a whole second: what it waits for either arrives promptly or the
 * run is stuck, which the safety deadline and the dump say.
 *
 * The deadline sits under each case's own timeout (`E2E`), so a stuck run
 * fails its own case with where the board and the run stood — never the
 * whole file, silently, at whatever the runner's own `--test-timeout` is.
 * That is not node:test's own doing: measured on Node 22, `--test-timeout`
 * is a hard ceiling over the whole invocation, and a case's own longer
 * `E2E` cannot widen it — a run given a *lower* runner default than `E2E`
 * is cut there first, silently, before this deadline or the dump below it
 * ever gets the chance. It holds here only because `script/verify.mjs` and
 * `.github/workflows/ci.yml` are both kept at or above `E2E`. Each case
 * takes a few seconds alone; 32 of these files at once
 * on one machine once took a case up to 85 s, which is what the margin was
 * sized for — but a busier desk than that measurement (several other
 * sessions building and testing at once, load averages of 30-50) has since
 * reached this deadline itself at 92-100 s, so the margin below is wider
 * than that one measurement, not merely equal to it.
 */
export const SAFETY_MS = 200_000
/** Every end-to-end case's own timeout: past the safety deadline, so the dump lands first. */
export const E2E = { timeout: 260_000 } as const
const POLL_FLOOR_MS = 50
const POLL_CEILING_MS = 500
export const whenChanged = async <T>(d: Desk, read: () => Promise<T | null> | T | null, what: string): Promise<T> => {
  const deadline = Date.now() + SAFETY_MS
  let poll = POLL_FLOOR_MS
  for (;;) {
    const moved = d.moved()
    const value = await read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`nothing on the desk moved to ${what} in ${SAFETY_MS} ms`)
    // Re-read the instant the desk moves. Otherwise, poll on a short timer that
    // backs off (floor 50ms, ceiling 500ms) while nothing does, and resets the
    // moment a notification does land — quick right after a step finishes,
    // never busier than twenty times a second once a wait settles in.
    let woken = false
    await Promise.race([moved.then(() => { woken = true }), new Promise((resolve) => setTimeout(resolve, poll))])
    poll = woken ? POLL_FLOOR_MS : Math.min(poll * 2, POLL_CEILING_MS)
  }
}

/**
 * The open cards of one role once every one of them is claimed by its Seat
 * and that Seat has been handed its order — the moment an agent starts on
 * its card, and not before: a card is claimed while its Seat is still being
 * journaled, and an agent is never told about it until that is done.
 */
export const claimed = async (d: Desk, goal: string, role: string, count: number): Promise<readonly Intent[]> =>
  explained(d, goal, whenChanged(d, async () => {
    const cards = (await board(d, goal)).filter((one) => one.role === role && one.state !== 'done')
    if (cards.length !== count || !cards.every((one) => one.state === 'claimed' && one.claim)) return null
    // Handed: sent, or left for the end of the turn its Seat is already in (its brief's), where it asks for work.
    const ordered = (await Promise.all(d.runs.map((run) => execution(d, run)))).flatMap((run) => run.operations)
      .filter((one) => one.kind === 'turn' && (one.state === 'finished' || one.state === 'prepared'))
    return cards.every((card) => ordered.some((one) => one.card === card.id)) ? cards : null
  }, `${count} claimed ${role} card(s), each handed to its Seat`))

/** A wait that timed out says where the run and its board stood, rather than only that it waited. */
export const explained = async <T>(d: Desk, goal: string, waiting: Promise<T>): Promise<T> => {
  try {
    return await waiting
  } catch (error) {
    const cards = (await board(d, goal)).map((one) => `#${one.id} ${one.role} ${one.state} ${one.outcome ?? ''}`)
    const runs = await Promise.all(d.runs.map((run) => execution(d, run)))
    const stood = runs.map((run) => `${run.state} ${run.reason ?? ''} ${run.rounds.map((one) => `${one.role}:${one.state}`).join(',')}`)
    // Which orders went out, and which wait for the end of a turn: a card handed a second order was a card the desk lost.
    const orders = runs.flatMap((run) => run.operations.filter((one) => one.kind === 'turn').map((one) => `${one.key} #${one.card} ${one.state}`))
    throw new Error([
      error instanceof Error ? error.message : String(error), ...cards, ...stood, `orders: ${orders.join(', ')}`,
      ...d.problems.map((one) => `inside an agent's turn: ${one}`),
    ].join('\n'))
  }
}

export const scopeOf = (card: Intent) => ({ runtime: card.claim!.runtime, sessionId: card.claim!.sessionId })

export const cwdOf = (d: Desk, card: Intent): string => {
  const record = d.host.registry.get(card.claim!.runtime as never, card.claim!.sessionId as never)
  assert.ok(record, `card #${card.id}'s conversation is held by the desk`)
  return record.session.cwd
}

/** A writer does its work: a real commit in its own checkout, then it finishes its card. */
export const write = async (d: Desk, card: Intent, text: string, outcome?: string): Promise<string> => {
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
export const review = async (d: Desk, card: Intent, verdict: string, pick?: string): Promise<void> => {
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
export const answer = async (d: Desk, card: Intent, outcome: string): Promise<void> => {
  const said = await d.host.teamPlane.complete(card.id, { outcome }, scopeOf(card))
  assert.doesNotMatch(said, /^Refused/, said)
}

/** A person's card, answered from the board the way a window answers it. */
export const person = async (d: Desk, goal: string, role: string, outcome: string): Promise<Intent> => {
  const card = await explained(d, goal, whenChanged(d, async () => (await board(d, goal)).find((one) => one.role === role && one.state !== 'done') ?? null,
    `the ${role} card`))
  await d.host.call('team/intent', { room: goal, id: card.id, action: 'done', outcome })
  return card
}

export const settled = async (d: Desk, run: string): Promise<FlowExecution> =>
  whenChanged(d, async () => {
    const now = await execution(d, run)
    assert.notEqual(now.state, 'stalled', `the run stalled: ${now.reason}`)
    return now.state === 'settled' ? now : null
  }, 'the run to reach its end')

export const TASK = { task: 'Make the attempt file say something useful' }

/** The shipped comparison, its check command pointed at this scratch repository's own test: a person's `pnpm verify` is theirs. */
export const comparison = async (d: Desk, count: number): Promise<string> => {
  const text = await shipped(d, 'comparison')
  assert.match(text, /run: "pnpm verify"/)
  const pointed = text.replace('run: "pnpm verify"', 'run: "test -s attempt.txt"')
  return count === 1 ? pointed : pointed.replace('    isolate: true\n', `    count: ${count}\n    isolate: true\n`)
}

/*
 * A real agent reads its brief in a turn of its own, and a busy agent refuses
 * a second message until that turn ends. An agent that simply gets on with
 * its card inside that first turn — waits for work, finds its card already
 * claimed for it, does it, completes it — is the ordinary case, not a race:
 * the run follows the board, never stalls on "still working", and the
 * completion is on disk.
 */
export type Behaviour = (d: Desk, card: Intent) => Promise<void>

/** Every Seat, handed its brief, works its own card inside that same turn, then ends the turn. */
export const workInsideTheBrief = (d: Desk, behaviours: Readonly<Record<string, Behaviour>>): void => {
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
      })().catch((error: unknown) => {
        // Said where the test's own wait will report it, not only on stderr.
        d.problems.push(error instanceof Error ? error.message : String(error))
        console.error('a working agent failed', error)
      })
    }
  }
}

/*
 * Independence is read from what each runtime's adapter reports about the
 * vendor behind it. A runtime that cannot rule out an override reports
 * none, and one that says nothing is unknown too — even one whose id names
 * a vendor. Either way the judge is refused a seat, never assumed
 * independent.
 */
export const UNKNOWN: readonly (Second & { readonly why: string })[] = [
  { id: 'fake-b', provider: null, why: 'reporting an unknown provider' },
  { id: 'codex', why: 'reporting no provider, named for a vendor' },
]
