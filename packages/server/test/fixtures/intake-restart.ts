import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_TRIGGER_BUDGET, type AgentEntry, type CeilingLevel, type RuntimeId, type SeatPlan, type SeatRecord,
  type TeamState, type TriggerDefinition, type TriggerFact,
} from '@harnessdesk/protocol'

import { EvidencePlane } from '../../src/evidence/plane.js'
import { ExecutionFiles, FlowExecutions, type FlowExecutionPort } from '../../src/flow-execution.js'
import { FlowPreviews } from '../../src/flow-preview.js'
import { Flows, type FlowPort } from '../../src/flows.js'
import { Serial } from '../../src/goals/assignments.js'
import { migrateDesk } from '../../src/goals/migration.js'
import { GoalPlane, type GoalPlanePort } from '../../src/goals/plane.js'
import { GoalStore } from '../../src/goals/store.js'
import { Admission, type AdmissionStep, type OfferAnswer } from '../../src/intake/admission.js'
import { IntakeEffects, type IntakeTargets } from '../../src/intake/apply.js'
import { TriggerClosures, type ArmBinding, type ArmedTrigger } from '../../src/intake/consent.js'
import { eventKey } from '../../src/intake/keys.js'
import { IntakeStore } from '../../src/intake/store.js'
import { Team, type TeamPort } from '../../src/team.js'

/**
 * The whole intake path on real stores, in one folder: a real Goal store and
 * Goal plane, a real board, a real flow engine and its run journal, a real
 * evidence store, and the real intake journal, admission and effects. Only
 * what reaches outside the desk is faked — a Seat's conversation, an order
 * sent to it — and each of those is appended to `events.log`, in order, so
 * a test can read what was dispatched across process exits.
 *
 * `desk()` builds it in this process. Run as a script, this file builds it in
 * a fresh process over an existing folder, offers facts, and — when asked —
 * exits the process the moment a named step is durable: the crash a restart
 * test recovers from. Nothing here touches a network, a vendor or an account.
 */

export const PROJECT = '/work/project'
export const REPO = 'acme/widgets'
export const sha = (seed: string): string => seed.repeat(40).slice(0, 40)

export const REVIEW_FLOW = `
version: 2
name: Review a pull request
roles:
  reviewer: { kind: agent, uses: reviewer, grant: read }
seed: { role: reviewer, title: Review it }
rules: []
`

export const agentEntry = (id: string): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest: `${id}-digest`, shadows: [], problems: [],
  definition: {
    id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: ['approve', 'request-changes'], produces: [], skills: [],
    prefer: [{ runtime: 'alpha' }], brief: `${id} brief`,
  },
})

export const definition = (over: Partial<TriggerDefinition> = {}): TriggerDefinition => ({
  id: 'review', on: { kind: 'pull-request', events: ['opened', 'pushed'] }, opens: { flow: 'review-pr' },
  goal: ['pr'], again: { role: 'reviewer', title: 'Continue this work', detail: null }, dedupe: ['pr', 'head', 'event'],
  concurrency: 1, forks: 'never', budget: DEFAULT_TRIGGER_BUDGET, ...over,
})

/** A pull-request fact as the monitor normalizes one. */
export const prFact = (pr: number, head: string, action: 'opened' | 'pushed', over: Partial<TriggerFact> = {}): TriggerFact => ({
  source: 'pull-request', project: PROJECT, repository: REPO, subject: String(pr),
  event: eventKey([REPO, pr, action, head]), action, at: 1_000 + pr, head, fork: false,
  title: `Change ${pr}`, body: '', url: `https://github.com/${REPO}/pull/${pr}`, trigger: null, ...over,
})

export type CrashAt = AdmissionStep | 'goal' | 'evidence' | 'round' | null

export interface DeskOptions {
  readonly definition?: TriggerDefinition
  /** Where the process exits (the child) or throws (in-process), the moment that step is durable. */
  readonly crashAt?: CrashAt
  /** Whether the arm still stands when admission reads it again. */
  readonly consent?: () => boolean
  readonly now?: () => number
  /** Held before admission reads the arm again: where a race is staged. */
  readonly beforeBinding?: () => Promise<void>
  /** Held before a firing's round is opened. */
  readonly beforeRound?: () => Promise<void>
  /** Held when a wrap stops the Goal's runs. */
  readonly beforeStop?: () => Promise<void>
  /** The dispatch gate: null lets a firing's round go. */
  readonly gate?: () => Promise<string | null>
}

/** The flow engine's legacy half: this desk runs no old flows. */
const legacy: FlowPort = {
  openLegacySeat: async () => { throw new Error('no old flows here') },
  releaseGoalSeat: async () => {},
  order: async () => {},
  reseat: async () => '',
  retire: async () => {},
  confine: async () => {},
  run: async () => ({ status: 0 }),
  changed: () => {},
  log: () => {},
  recovery: { goal: () => ({ exists: true, writable: true }), seats: () => [] },
}

/** The Goal queue, counting what joins it: how a race test knows a step is queued without waiting on time. */
export class WatchedSerial extends Serial {
  queued = 0
  readonly #waiters: { readonly count: number; readonly resolve: () => void }[] = []
  override run<T>(fn: () => Promise<T>): Promise<T> {
    this.queued += 1
    for (const waiter of this.#waiters.filter((one) => one.count <= this.queued)) {
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
    return super.run(fn)
  }
  /** Resolves once `count` tasks have joined the queue in all. */
  reached(count: number): Promise<void> {
    if (this.queued >= count) return Promise.resolve()
    return new Promise((resolve) => { this.#waiters.push({ count, resolve }) })
  }
}

export class Crashed extends Error {
  constructor(readonly at: string) { super(`crashed at ${at}`) }
}

export const desk = async (home: string, options: DeskOptions = {}) => {
  const trigger = options.definition ?? definition()
  const events = join(home, 'events.log')
  const log = (line: string): void => appendFileSync(events, `${line}\n`)
  const crash = (at: CrashAt): void => {
    if (options.crashAt !== at) return
    log(`crash:${at}`)
    if (process.env['HD_INTAKE_CHILD'] === '1') process.exit(0)
    throw new Crashed(String(at))
  }
  if (!existsSync(join(home, 'goals'))) await migrateDesk(home, async () => {})

  // Seats: what a real desk keeps in its Seat book, here a file, so a fresh process sees the same ones.
  const seatFile = join(home, 'seats.json')
  const seats = new Map<string, SeatRecord>(existsSync(seatFile) ? JSON.parse(readFileSync(seatFile, 'utf8')) as [string, SeatRecord][] : [])
  const keepSeats = (): void => writeFileSync(seatFile, JSON.stringify([...seats.entries()]))

  const goalStore = new GoalStore(home)
  await goalStore.load()
  const goalSerial = new WatchedSerial()
  const teamPort: TeamPort = {
    peers: () => [],
    rootOf: async (cwd) => (cwd.startsWith(PROJECT) ? PROJECT : null),
    send: async () => {},
    steer: async () => {},
    changed: () => {},
    removed: () => {},
    membershipChanged: () => {},
    audit: () => {},
  }
  const team = new Team(join(home, 'team'), teamPort)
  await team.load()
  const boardOf = (id: string): TeamState => {
    const held = team.stateFor(id)
    if (held.root) return held
    const document = goalStore.read(id)
    return {
      ...document.board, id, name: document.goal.sentence, root: document.goal.root, updatedAt: document.goal.updatedAt, members: [],
    } as unknown as TeamState
  }
  let admission: Admission | null = null
  const forbidden = async (): Promise<never> => { throw new Error('This desk does not seat through the Goal plane') }
  const goalPort: GoalPlanePort = {
    seats: { all: () => [...seats.values()], byId: (id) => seats.get(id) ?? null },
    confine: async (input) => ({ root: input.root, cwd: input.cwd ?? input.root }),
    known: async () => null,
    claimable: () => true,
    opening: forbidden,
    board: boardOf,
    evidence: async (id) => ({ room: id, stamp: 1, checks: [], refused: [], unreadable: null, cards: [] }),
    evidenceIds: async () => [],
    flow: () => undefined,
    busy: () => false,
    waits: () => false,
    stranded: () => false,
    held: () => false,
    settledFor: async () => {},
    answer: async () => ({ answer: null, gaps: [] }),
    revision: async () => ({ head: null, dirty: null }),
    changed: (view) => { if (!team.stateFor(view.goal.id).root) team.installProjection(view.board) },
    activity: () => {},
    ready: () => ({ ok: true }),
    seatAgent: forbidden,
    openLegacySeat: forbidden,
    importOpening: forbidden,
    closeId: forbidden,
    claim: forbidden,
    releaseClaim: forbidden,
    refuseMail: forbidden,
    retainLane: forbidden,
    finish: forbidden,
    finishWrap: async (operation) => {
      const document = goalStore.read(operation.goal)
      await goalStore.save({
        ...document, operation: null, receipt: operation.receipt,
        goal: { ...document.goal, state: 'wrapped', receipt: operation.receipt.id, revision: document.goal.revision + 1, updatedAt: Date.now() },
      }, document.goal.revision)
      log(`wrapped:${operation.goal}`)
    },
    wake: () => {},
    stopFlows: async (goal) => {
      await options.beforeStop?.()
      await flows.stopGoal(goal)
    },
    intakeHeld: (goal) => admission?.held(goal) ?? false,
  }
  const goals = new GoalPlane(goalStore, goalPort, goalSerial)
  for (const document of goalStore.list()) {
    if (!team.stateFor(document.goal.id).root) team.installProjection(boardOf(document.goal.id))
  }

  // The flow engine, with a Seat's conversation faked the way the flow rig fakes it.
  let opened = seats.size
  const port: FlowExecutionPort = {
    providerOf: async (runtime) => `vendor-${runtime}`,
    canDispatch: (goal) => goals.canDispatch(goal),
    createGoal: async () => { throw new Error('a trigger’s run never makes its own Goal') },
    goalsOf: () => [],
    seatOf: (id) => seats.get(id) ?? null,
    seatsOn: (goal) => [...seats.values()].filter((seat) => seat.board === goal && seat.closed === null),
    digestOf: async (_goal, agent) => `${agent}-digest`,
    openSeat: (input) => goalSerial.run(async () => {
      opened += 1
      const runtime = input.seats?.[0]?.runtime ?? 'alpha'
      const record: SeatRecord = {
        id: `seat-${opened}`, agent: { id: input.agent, name: input.agent, origin: 'project' }, briefDigest: `${input.agent}-digest`,
        seat: { runtime }, seatLabel: runtime, passedOver: [],
        standing: { kind: 'ceiling', level: input.grant?.kind === 'ceiling' ? input.grant.level : 'read' }, ceiling: null,
        checkout: { cwd: PROJECT, project: PROJECT, branch: null, head: null }, session: { runtime, sessionId: `s${opened}` },
        board: input.goal, role: null, openedAt: opened, closed: null,
      }
      await team.joinRoom(input.goal, runtime as RuntimeId, `s${opened}`)
      seats.set(record.id, record)
      keepSeats()
      log(`open:${record.id}:${input.goal}`)
      if (input.card !== undefined) {
        const state = team.stateFor(input.goal)
        team.installProjection({
          ...state,
          intents: state.intents.map((card) => card.id === input.card
            ? { ...card, state: 'claimed', claim: { runtime: runtime as RuntimeId, sessionId: `s${opened}`, at: Date.now() } }
            : card),
        })
      }
      return record
    }),
    release: async (_goal, id) => { log(`release:${id}`) },
    order: async (seat) => { log(`order:${seat.id}`) },
    busy: () => false,
    laneOf: () => null,
    reseat: async (seat) => seat.seatLabel,
    changed: () => {},
    log: () => {},
    headOf: async () => ({ at: null, dirty: false }),
    runCheck: async (command) => {
      log(`check:${command}`)
      return { result: { exit: 0, timedOut: false, tail: '' }, evidence: null, problem: null }
    },
  }
  const previews = new FlowPreviews({
    confine: async () => {},
    agents: async () => [agentEntry('reviewer')],
    previewAgent: async (_root, id, seatsAsked, grant: CeilingLevel): Promise<SeatPlan> => ({
      id, from: 'prefer', winner: 0, blocked: null, ceiling: { level: grant, hold: 'held' },
      candidates: (seatsAsked.length ? seatsAsked : [{ runtime: 'alpha' }]).map((seat, index) => ({
        seat, label: seat.runtime, runtimeName: seat.runtime, state: index === 0 ? 'taken' : 'untried', reason: null, fix: null,
      })),
    }),
    now: () => 1,
  })
  const closures = new TriggerClosures({
    flowSource: async (_root, id) => {
      if (id !== 'review-pr') throw new Error(`There is no flow called "${id}".`)
      return { source: REVIEW_FLOW, origin: 'project', path: '.harnessdesk/flows/review-pr.yml' }
    },
    preview: (root, source) => previews.freeze(root, source),
  })
  const executions = new FlowExecutions(new ExecutionFiles(join(home, 'flows-v2')), team, port, {
    triggered: {
      freeze: (root, one) => closures.freeze(root, one),
      originOf: (goal) => {
        try {
          return goalStore.read(goal).goal.origin
        } catch {
          return null
        }
      },
    },
  })
  const flows = new Flows(join(home, 'flows'), team, legacy, undefined, executions)
  team.attachFlows(flows)
  await flows.load()

  const evidence = new EvidencePlane({ dir: join(home, 'evidence'), seenFile: join(home, 'commands-seen.json') }, {
    board: (room) => team.stateFor(room), cwdOf: () => null, push: () => {}, log: () => {},
  })
  await evidence.load()

  const closure = await closures.freeze(PROJECT, trigger)
  const binding: ArmBinding = { project: PROJECT, incarnation: 'clone-1', source: 'file-digest', closure: closure.digest, account: 'account-digest', repository: REPO }
  const arm: ArmedTrigger = { project: PROJECT, id: trigger.id, definition: trigger, binding, baseline: 0, armedAt: 0 }

  const targets: IntakeTargets = {
    goals: { ensureTriggerGoal: async (request) => { const view = await goals.ensureTriggerGoal(request); log(`goal:${request.id}`); crash('goal'); return view } },
    evidence: { observeTrigger: async (firing, goal, fact) => { const ids = await evidence.observeTrigger(firing, goal, fact); crash('evidence'); return ids } },
    flows: {
      startTriggered: async (request) => {
        await options.beforeRound?.()
        const run = await flows.startTriggered(request)
        log(`start:${request.id}`)
        crash('round')
        return run
      },
      againTriggered: async (run, key, facts) => {
        await options.beforeRound?.()
        const round = await flows.againTriggered(run, key, facts)
        log(`again:${run}:${round.n}`)
        crash('round')
        return round
      },
      resumeTriggered: async (run) => { log(`release:${run}`); await flows.resumeTriggered(run) },
    },
    gate: async () => (await options.gate?.()) ?? null,
  }
  const store = new IntakeStore(home)
  await store.load()
  admission = new Admission(store, {
    binding: async () => {
      await options.beforeBinding?.()
      return options.consent?.() ?? true ? binding : null
    },
    paused: () => false,
    now: options.now ?? Date.now,
    lifecycle: (goal) => goals.lifecycle(goal),
    claim: (goal, claim) => goals.intakeClaim(goal, claim),
  }, new IntakeEffects(targets), {
    onStep: (step, operation) => {
      log(`${step}:${operation.key.slice(0, 8)}:${operation.mode}`)
      crash(step)
    },
  })
  const settle = async (): Promise<void> => {
    await flows.flush()
    await team.flush()
    await evidence.store.flush()
  }
  return { home, arm, binding, trigger, goals, goalStore, goalSerial, team, flows, executions, evidence, store, admission, events, settle, seats }
}

export type Desk = Awaited<ReturnType<typeof desk>>

// ----------------------------------------------------------- on the disk

/** What a folder holds now, read from its files alone. */
export const onDisk = async (home: string) => {
  const goalFiles = (await readdir(join(home, 'goals')).catch(() => [] as string[])).filter((one) => one !== 'index.json' && one.endsWith('.json'))
  const goals = await Promise.all(goalFiles.map(async (one) => JSON.parse(await readFile(join(home, 'goals', one), 'utf8')) as { goal: { id: string; origin: { kind: string } } }))
  const runFiles = (await readdir(join(home, 'flows-v2')).catch(() => [] as string[])).filter((one) => one.endsWith('.json'))
  const runs = await Promise.all(runFiles.map(async (one) => JSON.parse(await readFile(join(home, 'flows-v2', one), 'utf8')) as {
    id: string; goal: string; state: string; rounds: { n: number; cause: string; cards: number[] }[]; intake?: { dispatchHeld: boolean }
  }))
  const lines = (await readFile(join(home, 'events.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return {
    goals: goals.filter((one) => one.goal.origin.kind === 'trigger').map((one) => one.goal.id).sort(),
    runs,
    rounds: runs.flatMap((run) => run.rounds.map((round) => `${run.id}:${round.n}:${round.cause}`)).sort(),
    events: lines,
  }
}

// ------------------------------------------------------------ the child

/** Runs this file in a fresh Node process over `home`: offers each fact, exits early at `crashAt`. */
export const child = (home: string, facts: readonly TriggerFact[], crashAt: CrashAt = null): Promise<{ readonly answers: readonly OfferAnswer[]; readonly exited: string }> =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify({ home, facts, crashAt })], {
      env: { ...process.env, HD_INTAKE_CHILD: '1' }, timeout: 60_000,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`the child failed: ${error.message}\n${stderr}`))
        return
      }
      const last = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '{"answers":[],"exited":"crash"}'
      resolve(stdout.includes('"answers"') ? JSON.parse(last) as { answers: OfferAnswer[]; exited: string } : { answers: [], exited: 'crash' })
    })
  })

const main = async (): Promise<void> => {
  const { home, facts, crashAt } = JSON.parse(process.argv[2]!) as { home: string; facts: TriggerFact[]; crashAt: CrashAt }
  const built = await desk(home, { crashAt })
  // Startup order: the journal finishes what it began before any source is read.
  await built.admission.recover()
  const answers: OfferAnswer[] = []
  for (const fact of facts) answers.push(await built.admission.offer(built.arm, fact))
  await built.settle()
  process.stdout.write(`${JSON.stringify({ answers, exited: 'done' })}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
