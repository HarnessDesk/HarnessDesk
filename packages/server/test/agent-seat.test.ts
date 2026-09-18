import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { digestOf } from '@harnessdesk/agent-inventory'
import {
  findOption,
  refuseOptionValue,
  runtimeId,
  sessionId,
  turnId,
  type AgentEvent,
  type AgentSession,
  type ApprovalDecision,
  type ApprovalId,
  type ConfigOption,
  type FlowPermission,
  type FlowRun,
  type FlowSeat,
  type ModelInfo,
  type OptionValue,
  type RuntimeCapabilities,
  type RuntimeHealth,
  type RuntimeId,
  type RuntimeInfo,
  type SeatLeft,
  type SeatPlan,
  type Session,
  type SessionDeletion,
  type SessionId,
  type SessionOptions,
  type SessionSettings,
  type TeamState,
  type TurnId,
  type UsageReport,
  type UserContent,
} from '@harnessdesk/protocol'

import { AcpRegistry } from '../src/acp-registry.js'
import { AgentDirectory, AgentRegistryStore } from '../src/agent-registry.js'
import { chooseSeat, fixOf, reasonAgainst, type SeatOffer, type SeatRunning } from '../src/agent-seating.js'
import { Agents } from '../src/agents.js'
import { GIT_RULES, renderFlowTemplate } from '../src/flow.js'
import type { OpenedSeat } from '../src/host.js'
import { knownAgent } from '../src/installs/known-agents.js'
import { Logger } from '../src/log.js'
import { agentMethods, offerOf, readDesk } from '../src/methods/agents.js'
import type { SeatedAs } from '../src/registry.js'
import { SEAT_READ_DEADLINE_MS } from '../src/seat-reads.js'
import { FAKE_RUNTIME_ID, FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * Seating an Agent: the chosen seat, the brief handed over once, and the
 * refusal that names every candidate — or, once a seat is open, what differed.
 *
 * The seat and the standing order are recorded so a later reader can ask which
 * Agent wrote a change and which version of its brief it was running.
 *
 * Three rigs. The method against a hand-built context, where the desk's every
 * answer — installed, working, signed in, spent, the models it lists, what an
 * opened conversation reports — is the test's to set. The real host over the
 * socket, with a runtime whose controls a seat really sets and reads back. And
 * the flow engine's seat through that same host, pinned first, because the
 * method that opens an Agent's seat is the one that opens a flow's.
 */

/**
 * A point a fake stops at until the test lets it through — and says when
 * something has got there, so the test can act while it waits. Once open, it
 * stays open: whatever reaches it after goes straight through.
 */
const gate = () => {
  let arrive!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    /** Settles when the first caller gets here. */
    reached,
    /** Where the fake stops: says it got here, and waits to be let through. */
    pass: async (): Promise<void> => {
      arrive()
      await opened
    },
    /** Lets everything waiting here, and everything after, through. */
    open: (): void => release(),
  }
}
type Gate = ReturnType<typeof gate>

/**
 * A runtime with the controls a seat puts a conversation on — model, effort,
 * thinking, and the two switches nobody asks for — and the habit that makes
 * reading them back necessary: a pick it has no place for is dropped, not
 * refused, the way a greyed initial pick is dropped at `session/new`.
 *
 * Two models. `big` takes three efforts and thinks or not, as asked; `small`
 * runs at one effort and cannot think, and says so on both controls, greyed,
 * the way a family with nothing to choose declares them.
 */
class SeatFake extends FakeRuntime {
  /** What the last conversation on this agent left switched on, which a new one inherits. */
  inherited: { thinking: boolean; fast: boolean } = { thinking: true, fast: true }
  /**
   * Models that always think, as Cursor's Gemini 3.8 Flash does: thinking is
   * on, and greyed with the reason. None unless a test adds `big`, the one
   * model here that can think at all.
   */
  readonly alwaysThinks = new Set<string>()
  readonly opened: SeatSession[] = []
  /** The next conversation opens, then fails the first time it is asked what it is running. */
  breakNext = false
  /** Called as each conversation is asked for, before it exists. */
  beforeCreate: (() => void) | null = null
  /**
   * Where a test can hold the fake while it acts: naming a conversation (the
   * first thing a seat does once it is open), closing one, deleting one.
   */
  readonly stops: { title?: Gate; close?: Gate; delete?: Gate } = {}
  /**
   * The id the next conversation is given instead of the next in turn — an
   * agent handing back one the desk already holds, as one that numbers its
   * conversations afresh after a restart would.
   */
  mintAs: string | null = null
  /** Asked to delete, it refuses in these words. */
  deleteRefusal: string | null = null
  /** Conversations reopened, each on a handle of its own. */
  readonly reopened: SeatSession[] = []

  constructor(identity: { readonly id?: string; readonly capabilities?: Partial<RuntimeCapabilities> } = {}) {
    super({
      id: runtimeId(identity.id ?? 'seatfake'),
      name: 'Seat Fake',
      ...(identity.capabilities ? { capabilities: identity.capabilities } : {}),
    })
    // The name a label is built from; the base fixture's is fixed.
    const info = this.info
    ;(this as { info: RuntimeInfo }).info = { ...info, presentation: { ...info.presentation, name: 'Seat Fake' } }
  }

  override async listModels(): Promise<readonly ModelInfo[]> {
    return [
      { id: 'big', displayName: 'Big', reasoningLevels: [], supportsImages: false, isDefault: true },
      { id: 'small', displayName: 'Small', reasoningLevels: [], supportsImages: false },
    ]
  }

  override async createSession(options: SessionOptions): Promise<AgentSession> {
    this.beforeCreate?.()
    const id = sessionId(this.mintAs ?? `seat-${this.opened.length + 1}`)
    this.mintAs = null
    const session = new SeatSession(this, id, options.cwd, {
      model: 'big',
      effort: 'medium',
      thinking: this.inherited.thinking,
      fast: this.inherited.fast,
      'max-mode': false,
    })
    // The model first, because it decides what the other controls offer.
    const initial = Object.entries({
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.options ?? {}),
    }).sort(([a], [b]) => (a === 'model' ? -1 : b === 'model' ? 1 : 0))
    for (const [option, value] of initial) {
      const declared = findOption(session.options(), option)
      if (!declared) throw new Error(`Seat Fake has no option ${option}`)
      // A pick this model has no place for is dropped here, as it is at `session/new`.
      if (option !== 'model' && declared.disabled) continue
      await session.setOption(option, value)
    }
    this.opened.push(session)
    this.minted.set(String(id), options.cwd)
    this.emit({ type: 'session/started', session: session.snapshot() })
    if (this.breakNext) {
      this.breakNext = false
      session.broken = true
    }
    return session
  }

  /** Its own conversations, read as its store has them: under its own id, not the base fixture's. */
  override async readSession(id: SessionId): Promise<Session> {
    const held = this.#latest(id)
    if (!held) return super.readSession(id)
    const { options: _options, settings: _settings, ...transcript } = held.snapshot()
    return transcript
  }

  /** Reopened on a handle of its own — a conversation it still has, that is; a deleted one is gone. */
  override async resumeSession(id: SessionId): Promise<AgentSession> {
    this.resumes += 1
    const held = this.#latest(id)
    if (!held) throw new Error(`Seat Fake has no record of conversation ${String(id)}.`)
    const session = new SeatSession(this, held.id, held.settings().cwd, held.values())
    this.reopened.push(session)
    return session
  }

  override async deleteSession(id: SessionId): Promise<SessionDeletion> {
    await this.stops.delete?.pass()
    if (this.deleteRefusal) throw new Error(this.deleteRefusal)
    return super.deleteSession(id)
  }

  /** The newest handle on a conversation it still has, or nothing once it is deleted. */
  #latest(id: SessionId): SeatSession | undefined {
    if (this.deleted.includes(String(id))) return undefined
    return [...this.reopened, ...this.opened].reverse().find((one) => String(one.id) === String(id))
  }
}

type SeatValues = { model: string; effort: string; thinking: boolean; fast: boolean; 'max-mode': boolean }

class SeatSession implements AgentSession {
  readonly runtime: RuntimeId
  /** Every message it was sent, as text. */
  readonly sent: string[] = []
  closed = false
  /** Opened, and then lost: asked what it is running, it fails. */
  broken = false
  title: string | null = null
  #values: SeatValues
  #turns = 0

  constructor(
    private readonly owner: SeatFake,
    readonly id: SessionId,
    private readonly cwd: string,
    values: SeatValues,
  ) {
    this.runtime = owner.info.id
    this.#values = this.#fit(values)
  }

  /** What `small` cannot do is off, and a model that always thinks is thinking, whatever was asked of it. */
  #fit(values: SeatValues): SeatValues {
    if (values.model === 'small') return { ...values, effort: 'medium', thinking: false, fast: false }
    return this.owner.alwaysThinks.has(values.model) ? { ...values, thinking: true } : values
  }

  values(): SeatValues {
    return this.#values
  }

  settings(): SessionSettings {
    return { cwd: this.cwd, model: this.#values.model }
  }

  options(): readonly ConfigOption[] {
    if (this.broken) throw new Error('Seat Fake lost this conversation part-way through opening it')
    const small = this.#values.model === 'small'
    const always = this.owner.alwaysThinks.has(this.#values.model)
    return [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        label: 'Model',
        currentValue: this.#values.model,
        choices: [
          { value: 'big', label: 'Big' },
          { value: 'small', label: 'Small' },
        ],
      },
      {
        type: 'select',
        id: 'effort',
        category: 'thought_level',
        label: 'Effort',
        currentValue: this.#values.effort,
        choices: small
          ? [{ value: 'medium', label: 'Medium' }]
          : [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
        ...(small ? { disabled: 'Small runs at one level of effort; there is nothing to choose.' } : {}),
      },
      {
        type: 'boolean',
        id: 'thinking',
        category: 'thought_level',
        label: 'Thinking',
        currentValue: this.#values.thinking,
        ...(small
          ? { disabled: 'Small has no thinking mode.' }
          : always
            ? { disabled: 'Big always thinks.' }
            : {}),
      },
      {
        type: 'boolean',
        id: 'fast',
        label: 'Fast',
        currentValue: this.#values.fast,
        ...(small ? { disabled: 'Small has no fast lane.' } : {}),
      },
      { type: 'boolean', id: 'max-mode', label: 'Max mode', currentValue: this.#values['max-mode'] },
    ]
  }

  async setOption(id: string, value: OptionValue): Promise<void> {
    const option = findOption(this.options(), id)
    if (!option) throw new Error(`Seat Fake has no option ${id}`)
    const refusal = refuseOptionValue(option, value)
    if (refusal) throw new Error(refusal)
    this.#values = this.#fit({ ...this.#values, [id]: value })
    if (id === 'model') {
      this.owner.emit({ type: 'session/settings', sessionId: this.id, settings: this.settings() })
    }
    this.owner.emit({ type: 'session/options', sessionId: this.id, options: this.options() })
  }

  snapshot(): Session {
    return {
      id: this.id,
      runtime: this.runtime,
      title: this.title,
      cwd: this.cwd,
      status: { type: 'idle' },
      createdAt: 0,
      updatedAt: 0,
      settings: this.settings(),
      options: this.options(),
      turns: [],
      itemsLoaded: true,
    }
  }

  async send(input: readonly UserContent[]): Promise<TurnId> {
    this.sent.push(input.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    this.#turns += 1
    const id = turnId(`seat-turn-${this.#turns}`)
    this.owner.emit({ type: 'turn/started', sessionId: this.id, turn: { id, items: [], status: 'inProgress' } })
    return id
  }

  async steer(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async respondToApproval(_id: ApprovalId, _decision: ApprovalDecision): Promise<void> {}
  async updateSettings(patch: Partial<SessionSettings>): Promise<void> {
    if (patch.model !== undefined) await this.setOption('model', patch.model)
  }
  async setTitle(title: string): Promise<void> {
    await this.owner.stops.title?.pass()
    this.title = title
    this.owner.emit({ type: 'session/title', sessionId: this.id, title })
  }
  async close(): Promise<void> {
    await this.owner.stops.close?.pass()
    this.closed = true
    this.owner.emit({ type: 'session/closed', sessionId: this.id })
  }
}

/** A logger that keeps what was said at `warn`, in order, across every child it makes. */
class Heard extends Logger {
  constructor(readonly said: string[] = []) {
    super('test', { level: 'error', console: false })
  }
  override child(): Logger {
    return new Heard(this.said)
  }
  override warn(message: string): void {
    this.said.push(message)
  }
}

/** A host on the real socket with the seat fake beside the plain one, and a folder open. */
const desk = async (t: TestContext) => {
  const heard = new Heard()
  const harness = await start({ logger: heard })
  t.after(() => stop(harness))
  const seats = new SeatFake()
  harness.host.register(seats)
  await seats.start()
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  const work = tempDir('hd-agent-seat-work-')
  await client.call('workspace/open', { path: work })
  return { harness, seats, client, work, heard }
}

/*
 * The flow engine's seat, through the real host.
 *
 * `flows.test.ts` drives the round engine against a fake port, so nothing there
 * reaches the host's own `seat`: the one that opens the conversation, applies
 * the picks, turns off the switches nobody asked for, and reads back what is
 * running. These pin what a flow sees of that — the label, the switches, the
 * order, and that a pick a runtime drops is reported and not refused — so a
 * change to the host's seating that a flow could notice is a change these
 * notice first.
 */

const FLOW = (seat: string) => `
name: Seat check
roles:
  worker:
    kind: agent
    seat: ${seat}
    permission: read
    outcomes: [done]
    order: Do the one thing.
seed:
  role: worker
  title: The one thing
`

const runFlow = async (client: Client, work: string, seat: string): Promise<FlowRun> => {
  const room = (await client.call('team/room/create', { root: work, name: 'Seat room' })) as TeamState
  const run = (await client.call('flow/start', { room: room.id, source: FLOW(seat) })) as FlowRun
  await client.call('flow/stop', { run: run.id })
  return run
}

test("a flow's seat is opened on its picks, the switches nobody asked for are turned off, and it is labelled for what runs", async (t) => {
  const { seats, client, work, heard } = await desk(t)
  const run = await runFlow(client, work, 'seatfake=big/high')

  assert.deepEqual(
    run.seats.map((one) => [one.runtime, one.seat]),
    [['seatfake', 'Seat Fake · Big · High']],
  )
  assert.deepEqual(
    run.record.filter((event) => event.kind === 'seated').map((event) => event.seat),
    ['Seat Fake · Big · High'],
  )
  const opened = seats.opened[0]
  assert.ok(opened)
  // Inherited on, turned off: nobody wrote `+thinking`, and fast was never a pick.
  assert.deepEqual(opened.values(), { model: 'big', effort: 'high', thinking: false, fast: false, 'max-mode': false })
  assert.equal(opened.title, 'worker · Seat room · Seat check')
  assert.equal(opened.sent.length, 1, 'one standing order')
  assert.match(opened.sent[0] ?? '', /Do the one thing\./)
  assert.deepEqual(heard.said.filter((line) => /flow seat/.test(line)), [])
})

test('a pick the runtime drops is reported in the label and logged, and the flow still seats', async (t) => {
  const { seats, client, work, heard } = await desk(t)
  const run = await runFlow(client, work, 'seatfake=small/high+thinking')

  // What runs, not what was asked: small runs at medium, and cannot think.
  assert.deepEqual(
    run.seats.map((one) => [one.seat, one.spec]),
    [['Seat Fake · Small · Medium', { runtime: 'seatfake', model: 'small', effort: 'high', thinking: true }]],
  )
  assert.deepEqual(seats.opened[0]?.values(), {
    model: 'small',
    effort: 'medium',
    thinking: false,
    fast: false,
    'max-mode': false,
  })
  assert.equal(seats.opened[0]?.closed, false, 'a flow keeps the seat it opened')
  assert.deepEqual(
    heard.said.filter((line) => /flow seat/.test(line)),
    ['a flow seat could not take a pick', 'a flow seat could not take a pick'],
  )
})

/*
 * The flow's one use of the retire it shares with an Agent: a start that cannot
 * seat every role closes the seats it had opened. They are let go by the host as
 * well as closed — a closed handle the host kept holding was a conversation it
 * would still route turns to, and over ACP, where closing is no call at all, a
 * seat that was never really put down.
 */
test('a flow that cannot seat every role closes the seats it opened, and the host lets them go', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  const room = (await client.call('team/room/create', { root: work, name: 'Seat room' })) as TeamState
  const source = `
name: Two seats
roles:
  first:
    kind: agent
    seat: seatfake=big/high
    permission: read
    outcomes: [done]
    order: Do the first thing.
  second:
    kind: agent
    seat: seatfake=huge
    permission: read
    outcomes: [done]
    order: Do the second thing.
seed:
  role: first
  title: The first thing
`
  await assert.rejects(client.call('flow/start', { room: room.id, source }), /"huge" is not one of the values Model offers/)
  const [first] = seats.opened
  assert.ok(first && seats.opened.length === 1)
  assert.equal(first.closed, true)
  assert.deepEqual(first.sent, [], 'no order went to a seat of a run that never started')
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), first.id)?.live ?? null, null)
  assert.deepEqual(await client.call('flow/runs', { room: room.id }), [])
})

// ------------------------------------------------------ the method, by itself

/** An Agent file as a person writes one, with the candidates it prefers and its ceiling. */
const agentFile = (prefer: string, permission: FlowPermission = 'read'): string =>
  `---\nname: Reviewer\npermission: ${permission}\nprefer: [${prefer}]\n---\nRead the diff.\n`

/**
 * What a seat on this Agent is handed, working in `cwd`: the brief as written,
 * then the rule of the permission it holds — the flow's own sentence for it,
 * `GIT_RULES`, filled in as a flow seat's is.
 */
const orderFor = (permission: FlowPermission, cwd: string): string =>
  `Read the diff.\n\n${renderFlowTemplate(GIT_RULES[permission], { repo: cwd })}`

/** What one runtime on the pretend desk says about itself. Honest and ready unless a test says otherwise. */
interface Pretend {
  /** What the desk calls it. Its id unless a test names it. */
  readonly name?: string
  /** The models it answers with, labels and all; built from `models` when absent. */
  readonly catalogue?: readonly ModelInfo[]
  readonly models?: readonly string[]
  /** The model list will not load. */
  readonly modelsFail?: boolean
  /**
   * Set, the runtime answers the picker's question with whatever it has — an
   * empty list when it never managed to learn one, as the ACP adapter does —
   * and says separately whether it knows (`knownModels`): true, it never
   * learned them. Unset, it has no such second answer, as Codex has not.
   */
  readonly modelsUnknown?: boolean
  readonly health?: RuntimeHealth
  /** Asked for its health, it throws rather than answering: a read that fails outright, not one that is late. */
  readonly healthThrows?: string
  /** Signed in to nothing. */
  readonly signedOut?: boolean
  /** The account would not answer. */
  readonly accountFails?: boolean
  /** Keeps its own credential, so the desk never asks it to sign in. */
  readonly keepsOwnAccount?: boolean
  /** Asked whether it is signed in, it never answers. */
  readonly accountHangs?: boolean
  /** Asked for its models, it never answers. */
  readonly modelsHang?: boolean
}

const pretendRuntime = (id: string, pretend: Pretend) => {
  const catalogue: readonly ModelInfo[] =
    pretend.catalogue ??
    (pretend.models ?? []).map((one) => ({ id: one, displayName: one, reasoningLevels: [], supportsImages: false }))
  return {
    info: {
      id: runtimeId(id),
      capabilities: { account: pretend.keepsOwnAccount !== true },
      presentation: { name: pretend.name ?? id },
    },
    health: (): RuntimeHealth => {
      if (pretend.healthThrows) throw new Error(pretend.healthThrows)
      return pretend.health ?? { state: 'ready' }
    },
    getAccount: async () => {
      if (pretend.accountHangs) return new Promise<never>(() => {})
      if (pretend.accountFails) throw new Error('the account endpoint timed out')
      return { accounts: pretend.signedOut ? [] : [{ kind: 'apiKey', label: 'key' }], signInMethods: [] }
    },
    listModels: async () => {
      if (pretend.modelsHang) return new Promise<never>(() => {})
      if (pretend.modelsFail) throw new Error('the catalogue did not load')
      return pretend.modelsUnknown ? [] : catalogue
    },
    ...(pretend.modelsUnknown !== undefined
      ? {
          knownModels: async () => {
            if (pretend.modelsHang) return new Promise<never>(() => {})
            return pretend.modelsUnknown ? null : catalogue
          },
        }
      : {}),
  }
}

/**
 * The method against a context the test builds: a roster on disk, a pretend
 * desk, and a seat verb that records what it was asked to open and reports
 * whatever the test says the conversation came back running — by default
 * exactly what was asked, as an honest runtime would.
 */
const rig = async (
  prefer: string,
  desk: Readonly<Record<string, Pretend>> = { claude: { models: ['opus-5'] } },
  options: {
    readonly reports?: readonly UsageReport[]
    readonly comesBackAs?: (seat: FlowSeat) => Partial<SeatRunning>
    /** Why opening this seat fails, or null when it opens. */
    readonly openFails?: (seat: FlowSeat) => string | null
    readonly orderFails?: string
    /** The Agent's ceiling, as its file declares it. */
    readonly permission?: FlowPermission
    /** Asked for usage, the desk never answers. */
    readonly usageHangs?: boolean
    /** Asked for usage, the desk fails outright rather than staying silent. */
    readonly usageFails?: boolean
    /** The last readings the desk already holds, by runtime. */
    readonly cached?: readonly UsageReport[]
    /** How long each read before choosing may take. A second unless a test says otherwise. */
    readonly deadlineMs?: number
    /** Runtime ids whose usage the person has switched off — left out of `ctx.runtimes.metered()`. */
    readonly unmetered?: readonly string[]
    /** What a discarded seat leaves behind, per runtime; nothing unless a test says so. */
    readonly leaves?: (runtime: string) => SeatLeft | null
    /** The desk's writable agent registry, with the public registry behind it; none unless a test gives one. */
    readonly directory?: AgentDirectory
  } = {},
) => {
  const root = tempDir('hd-agent-seat-')
  const user = join(root, 'user')
  const source = agentFile(prefer, options.permission)
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(join(user, 'reviewer', 'AGENT.md'), source, 'utf8')
  const roster = new Agents({ user, builtin: join(root, 'builtin') })

  const created: { runtime: string; model?: string; cwd: string }[] = []
  /* What the host logged, with the details beside each line: a detail left
     out is as much a regression as a line left out. */
  const warned: [string, unknown][] = []
  const titles: string[] = []
  const ordered: string[] = []
  const retired: string[] = []
  const discarded: string[] = []
  const recorded: SeatedAs[] = []
  const asked: (string | undefined)[] = []
  /* Seats this call has open right now, and every moment a second was opened
     beside one. Letting a seat go takes a turn of the event loop here, so a
     retire that is not waited for is a retire still in flight when the next
     seat opens. */
  let alive = 0
  const overlaps: string[] = []
  const runtimes = new Map(Object.entries(desk).map(([id, pretend]) => [id, pretendRuntime(id, pretend)]))

  const ctx = {
    agents: {
      list: (project?: string) => roster.list(project),
      read: (id: string, project?: string) => {
        asked.push(project)
        return roster.read(id, project)
      },
    },
    workspaces: {
      confineGitRoot: async (project: string) => {
        throw new Error(`${project} is outside every open workspace. Open its folder first to read from it.`)
      },
    },
    runtimes: {
      get: (id: string) => runtimes.get(id),
      infoOf: (runtime: { info: unknown }) => runtime.info,
      metered: () => [...runtimes.values()].filter((runtime) => !(options.unmetered ?? []).includes(String(runtime.info.id))),
    },
    options: { seatReadDeadlineMs: options.deadlineMs ?? 1_000, ...(options.directory ? { agents: options.directory } : {}) },
    logger: { warn: (message: string, details?: unknown) => warned.push([message, details]) },
    usage: () => ({
      reports: async () => {
        if (options.usageHangs) return new Promise<never>(() => {})
        if (options.usageFails) throw new Error('the usage endpoint timed out')
        return options.reports ?? []
      },
      cached: (id: string) => (options.cached ?? []).find((one) => String(one.runtime) === id) ?? null,
    }),
    seats: {
      open: async (seat: FlowSeat, where: { cwd: string; title: string }): Promise<OpenedSeat> => {
        const fails = options.openFails?.(seat)
        if (fails) throw new Error(fails)
        if (alive > 0) overlaps.push(`${seat.runtime} opened while ${alive} other seat(s) were still open`)
        alive += 1
        created.push({ runtime: seat.runtime, ...(seat.model ? { model: seat.model } : {}), cwd: where.cwd })
        titles.push(where.title)
        const honest: SeatRunning = {
          model: seat.model ?? 'its-default',
          effort: seat.effort ?? null,
          thinking: seat.thinking === true,
          thinkingFixed: null,
        }
        return {
          runtime: seat.runtime,
          sessionId: `s${created.length}`,
          running: { ...honest, ...options.comesBackAs?.(seat) },
          label: seat.runtime,
        }
      },
      order: async (_runtime: string, _sessionId: string, text: string) => {
        if (options.orderFails) throw new Error(options.orderFails)
        ordered.push(text)
      },
      retire: async (runtime: string, id: string) => {
        await new Promise((resolve) => setImmediate(resolve))
        alive -= 1
        retired.push(`${runtime} ${id}`)
      },
      discard: async (runtime: string, id: string): Promise<SeatLeft | null> => {
        await new Promise((resolve) => setImmediate(resolve))
        alive -= 1
        retired.push(`${runtime} ${id}`)
        discarded.push(`${runtime} ${id}`)
        return options.leaves?.(runtime) ?? null
      },
      recordAgent: (runtime: string, id: string, seated: SeatedAs): Session => {
        recorded.push(seated)
        return {
          id: sessionId(id),
          runtime: runtimeId(runtime),
          cwd: '/tmp/x',
          status: { type: 'idle' },
          createdAt: 0,
          updatedAt: 0,
          settings: { cwd: '/tmp/x', model: 'opus-5', ...seated },
          turns: [],
          itemsLoaded: true,
        }
      },
    },
  } as never
  return {
    ctx,
    source,
    created,
    titles,
    ordered,
    retired,
    discarded,
    recorded,
    asked,
    root,
    overlaps,
    warned,
    alive: () => alive,
  }
}

/** Nothing was opened, handed a brief, closed or recorded. */
const untouched = (seen: { created: unknown[]; ordered: unknown[]; retired: unknown[]; recorded: unknown[] }) => {
  assert.deepEqual(seen.created, [], 'nothing opened')
  assert.deepEqual(seen.ordered, [], 'no brief handed over')
  assert.deepEqual(seen.retired, [], 'nothing to close')
  assert.deepEqual(seen.recorded, [], 'nothing recorded')
}

test('it seats the first candidate this machine can offer', async () => {
  const { ctx, created, titles } = await rig('cursor=gemini-3.8-flash/high, claude=opus-5/high')
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  assert.deepEqual(titles, ['Reviewer'], 'the conversation is named for the Agent')
})

test('the brief is handed over as the standing order, once, with the rule of the permission it holds', async () => {
  const { ctx, ordered } = await rig('claude=opus-5/high')
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.equal(ordered.length, 1)
  assert.match(ordered[0] ?? '', /^Read the diff\.\n\n/, 'the brief as written, first')
  // The flow's own sentence for `read`, filled with where the seat works — not
  // a second wording of it.
  assert.match(ordered[0] ?? '', /- Stay inside \/tmp\/x\. .*never push, never merge/)
  assert.equal(ordered[0], orderFor('read', '/tmp/x'))
})

test("the seat is told the narrower of the Agent's ceiling and the seating's grant, in the flow's words, and it is recorded", async () => {
  const cases: readonly (readonly [FlowPermission, FlowPermission | undefined, FlowPermission])[] = [
    ['read', undefined, 'read'],
    // No step, so no grant but the one the call makes: read, whatever the ceiling.
    ['merge', undefined, 'read'],
    // A grant never reaches past the ceiling…
    ['read', 'merge', 'read'],
    ['publish', 'merge', 'publish'],
    // …and a ceiling never widens a grant.
    ['merge', 'publish', 'publish'],
    ['merge', 'merge', 'merge'],
  ]
  for (const [ceiling, grant, held] of cases) {
    const said = `a ${ceiling} Agent seated with ${grant ?? 'no'} grant`
    const seen = await rig('claude=opus-5/high', undefined, { permission: ceiling })
    const session = await agentMethods['agent/seat'](seen.ctx, {
      id: 'reviewer',
      cwd: '/tmp/x',
      ...(grant ? { permission: grant } : {}),
    })
    assert.deepEqual(seen.ordered, [orderFor(held, '/tmp/x')], said)
    assert.deepEqual(seen.recorded, [{ agent: 'reviewer', briefDigest: digestOf(seen.source), permission: held }], said)
    assert.equal(session.settings?.permission, held, said)
  }
})

test('the session records the Agent and the brief it ran', async () => {
  const { ctx, source } = await rig('claude=opus-5/high')
  const session = await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.equal(session.settings?.agent, 'reviewer')
  // Asserted as the digest of the real file, not merely as a non-empty string:
  // the defect this guards is a hash and prose being swapped — or the prose
  // alone being hashed — and a length check can see neither. The digest is the
  // roster's own, `AgentEntry.digest`, which is taken of the whole file.
  assert.equal(session.settings?.briefDigest, digestOf(source))
})

test('nothing seatable refuses, names every candidate, and opens nothing', async () => {
  const seen = await rig('cursor=gemini-3.8-flash/high, codex=gpt-5.3/xhigh')
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => /cursor/.test(error.message) && /codex/.test(error.message) && /not installed/.test(error.message),
  )
  untouched(seen)
})

test('an Agent nobody defined refuses by name', async () => {
  const seen = await rig('claude=opus-5/high')
  await assert.rejects(() => agentMethods['agent/seat'](seen.ctx, { id: 'ghost', cwd: '/tmp/x' }), /ghost/)
  untouched(seen)
})

test('a model list that could not be read refuses as unread, never as "does not offer", and opens nothing', async () => {
  const seen = await rig('cursor=gemini-3.8-flash/high', { cursor: { modelsFail: true } })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  cursor=gemini-3.8-flash/high — cannot tell whether cursor offers gemini-3.8-flash: its model list could not be read',
      )
      return true
    },
  )
  untouched(seen)
})

test('a runtime that draws an unread model list as empty is still refused as unread', async () => {
  // The ACP adapter's picker answer: what it has, which is nothing when it
  // never managed to ask. Taken at its word, that is "does not offer".
  const unread = await rig('cursor=gemini-3.8-flash/high', { cursor: { modelsUnknown: true } })
  await assert.rejects(
    () => agentMethods['agent/seat'](unread.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  cursor=gemini-3.8-flash/high — cannot tell whether cursor offers gemini-3.8-flash: its model list could not be read',
      )
      return true
    },
  )
  untouched(unread)
  // The control: a list it did learn, empty or not, is the answer.
  const none = await rig('cursor=gemini-3.8-flash/high', { cursor: { models: [], modelsUnknown: false } })
  await assert.rejects(
    () => agentMethods['agent/seat'](none.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /cursor=gemini-3\.8-flash\/high — cursor does not offer gemini-3\.8-flash$/,
  )
  const offered = await rig('cursor=gemini-3.8-flash/high', { cursor: { models: ['gemini-3.8-flash'], modelsUnknown: false } })
  await agentMethods['agent/seat'](offered.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(offered.created, [{ runtime: 'cursor', model: 'gemini-3.8-flash', cwd: '/tmp/x' }])
})

test('an effort nothing can list before seating is let through, and the seat is kept when it runs at it', async () => {
  // No runtime lists its efforts before a session exists. Taken for "offers
  // none", every candidate that names an effort would be refused.
  const { ctx, created, ordered } = await rig('claude=opus-5/xhigh')
  const session = await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  assert.equal(ordered.length, 1)
  assert.equal(session.settings?.agent, 'reviewer')
})

test('a seat that comes back on another effort is closed, and with no other candidate the call is refused and no brief sent', async () => {
  const seen = await rig('claude=opus-5/high', undefined, { comesBackAs: () => ({ effort: 'medium' }) })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  claude=opus-5/high — claude runs it at medium effort, not high',
      )
      return true
    },
  )
  assert.equal(seen.created.length, 1, 'it was opened, which is how the difference was found')
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.ordered, [])
  assert.deepEqual(seen.recorded, [])
})

test('a +thinking seat that comes back without thinking is closed and passed over, in the runtime\'s words', async () => {
  const seen = await rig('claude=opus-5/high+thinking', undefined, {
    comesBackAs: () => ({ thinking: false, thinkingFixed: 'Opus 5 has no thinking mode here.' }),
  })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  claude=opus-5/high+thinking — claude runs it without thinking, which was asked for (Opus 5 has no thinking mode here)',
      )
      return true
    },
  )
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.ordered, [])
  assert.deepEqual(seen.recorded, [])
})

test('a seat that comes back on another model is closed and passed over, the candidates above it named too', async () => {
  const seen = await rig('cursor=gemini-3.8-flash/high, claude=opus-5/high', undefined, {
    comesBackAs: () => ({ model: 'sonnet-5' }),
  })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  cursor=gemini-3.8-flash/high — cursor is not installed\n' +
          '  claude=opus-5/high — claude runs it on model sonnet-5, not opus-5',
      )
      return true
    },
  )
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.ordered, [])
})

test('a project outside the open folders is refused before anything is read or opened', async () => {
  const seen = await rig('claude=opus-5/high')
  // A raw path that no open folder admits: the host's confinement is asked, and refuses.
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x', project: seen.root }),
    /outside every open workspace/,
  )
  // Nor a relative one, which the host would resolve against wherever it was started.
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x', project: 'elsewhere' }),
    /not an absolute path/,
  )
  assert.deepEqual(seen.asked, [], 'the roster was never asked about it')
  untouched(seen)
})

test('a folder that is not absolute is refused before anything is read or opened', async () => {
  const seen = await rig('claude=opus-5/high')
  await assert.rejects(() => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: 'work' }), /not an absolute path/)
  assert.deepEqual(seen.asked, [])
  untouched(seen)
})

test('an Agent whose file will not parse is refused with its problem, and nothing is opened', async () => {
  const seen = await rig('claude=opus-5/high')
  await mkdir(join(seen.root, 'user', 'broken'), { recursive: true })
  await writeFile(join(seen.root, 'user', 'broken', 'AGENT.md'), '---\npermission: admin\n---\nx\n', 'utf8')
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'broken', cwd: '/tmp/x' }),
    /broken[/\\]AGENT\.md cannot be used: permission — "admin" is not a permission/,
  )
  untouched(seen)
})

test("a conversation that could not be opened is refused in the runtime's words", async () => {
  const seen = await rig('claude=opus-5/high', undefined, { openFails: () => 'The agent is not running.' })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  claude=opus-5/high — claude could not open a conversation: The agent is not running.',
      )
      return true
    },
  )
  untouched(seen)
})

test('a brief that could not be handed over closes the conversation, and nothing is recorded', async () => {
  const seen = await rig('claude=opus-5/high', undefined, { orderFails: 'Claude is not running.' })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /Reviewer was seated on claude=opus-5\/high, and its brief could not be handed over, so the conversation was closed: Claude is not running\./,
  )
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.recorded, [])
})

test('a brief that could not be handed over stops the seating there: no later seat is opened', async () => {
  // The handing-over failed, but the brief may still have reached that
  // conversation; a second seat could leave two at work on one brief.
  const seen = await rig('claude=opus-5/high, claude=sonnet-5/high', { claude: { models: ['opus-5', 'sonnet-5'] } }, {
    orderFails: 'Claude is not running.',
  })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /Reviewer was seated on claude=opus-5\/high, and its brief could not be handed over, so the conversation was closed: Claude is not running\./,
  )
  assert.equal(seen.created.length, 1)
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.recorded, [])
  assert.equal(seen.alive(), 0)
})

/** One account's standing, a weekly lane for each figure given — the account's own, or one model's. */
const reportFor = (runtime: string, lanes: readonly { usedPercent: number; scope?: string }[]): UsageReport => ({
  runtime: runtimeId(runtime),
  account: null,
  plan: null,
  lanes: lanes.map((lane) => ({
    id: lane.scope ? `weekly:${lane.scope}` : 'weekly',
    label: 'Weekly',
    usedPercent: lane.usedPercent,
    windowMinutes: 10_080,
    resetsAt: null,
    ...(lane.scope ? { scope: lane.scope } : {}),
  })),
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'runtime', label: 'from its own API' },
  fetchedAt: 0,
  staleAfterMs: 60_000,
  error: null,
})

test('each thing the desk knows before opening is its own reason, read from the desk', async () => {
  const seen = await rig(
    'devin=m, gone=m, old=m, starting=m, mute=m, out=m, spent=m',
    {
      gone: { models: ['m'], health: { state: 'unavailable', reason: 'notInstalled', message: 'Gone is not installed on this machine.' } },
      old: {
        models: ['m'],
        health: {
          state: 'unavailable',
          reason: 'versionTooOld',
          message: 'Old 0.1 is too old:\n1.0 or newer is needed.',
          remediation: 'Update it with `old update`.',
        },
      },
      starting: { models: ['m'], health: { state: 'starting' } },
      mute: { models: ['m'], accountFails: true },
      out: { models: ['m'], signedOut: true },
      spent: { models: ['m'] },
    },
    { reports: [reportFor('spent', [{ usedPercent: 100 }])] },
  )
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          'No seat could be opened for this Agent:',
          // `devin` names a runtime this desk knows of (`known-agents.ts`) but
          // has not added — the "nobody added it" flavour of not installed,
          // as opposed to `gone`'s "added, and its program is missing".
          '  devin=m — devin is not installed',
          '  gone=m — gone is not installed',
          '  old=m — old is unavailable: Old 0.1 is too old: 1.0 or newer is needed. Update it with `old update`',
          '  starting=m — starting is unavailable: it is still starting',
          '  mute=m — mute is unavailable: its account could not be read — the account endpoint timed out',
          '  out=m — out is signed out',
          "  spent=m — spent's window is spent",
        ].join('\n'),
      )
      return true
    },
  )
  untouched(seen)
})

/*
 * `readDesk` decides, for every candidate id this desk has not added, which
 * fix a refusal can honestly offer: *Add* it, when the id is one the desk
 * could add — an agent it knows how to run (`known-agents.ts`), or one the
 * public registry lists in the copy the desk last fetched — or send the
 * reader back to the seats themselves, when neither lists it: the
 * `prefer: [claude]` mistake, where the id is `claude-code`.
 */

test('readDesk tells an id nothing could add apart from one the desk could still add', async () => {
  const { ctx } = await rig('cursor=m1', {})
  const { offers } = await readDesk(ctx, [
    { runtime: 'cursor', thinking: false }, // a real runtime (known-agents.ts) — just not added to this desk
    { runtime: 'claude', thinking: false }, // the spec's own spelling; the id is claude-code
  ])
  // The known-but-unadded id gets no offer at all, and only the id nothing
  // could add gets one, marked apart.
  assert.deepEqual(offers, [
    { runtime: 'claude', unknownRuntime: true, models: null, efforts: null, signedIn: false, spent: false },
  ])
  assert.deepEqual(reasonAgainst({ runtime: 'cursor', thinking: false }, offers), { kind: 'notInstalled', added: false })
  assert.deepEqual(fixOf('cursor', { kind: 'notInstalled', added: false }), { kind: 'add', runtime: 'cursor' })
  assert.deepEqual(reasonAgainst({ runtime: 'claude', thinking: false }, offers), { kind: 'unknownRuntime' })
  assert.deepEqual(fixOf('claude', { kind: 'unknownRuntime' }), { kind: 'seats' })
})

/** Each candidate passed over, with its reason and what removes it. */
const fixesFor = (candidates: readonly FlowSeat[], offers: readonly SeatOffer[]) =>
  chooseSeat(candidates, offers).passed.map((one) => [one.seat.runtime, one.reason, fixOf(one.seat.runtime, one.reason)])

test('beside a runtime this desk has, an id nothing could add is still its own reason — the path a real desk takes', async () => {
  // A real desk always has a runtime added — Codex, by the wiring — so a
  // seating there reads offers for it, and the ids nothing could add are
  // answered beside them, not instead of them as on the empty desk above.
  const seen = await rig('claude=opus-5, codex=gpt-5.5', { codex: { models: ['gpt-5.5'], signedOut: true } })
  const candidates: FlowSeat[] = [
    { runtime: 'claude', model: 'opus-5', thinking: false },
    { runtime: 'codex', model: 'gpt-5.5', thinking: false },
  ]
  const { offers } = await readDesk(seen.ctx, candidates)
  assert.deepEqual(offers, [
    { runtime: 'codex', models: ['gpt-5.5'], efforts: null, signedIn: false, spent: false },
    { runtime: 'claude', unknownRuntime: true, models: null, efforts: null, signedIn: false, spent: false },
  ])
  assert.deepEqual(fixesFor(candidates, offers), [
    ['claude', { kind: 'unknownRuntime' }, { kind: 'seats' }],
    ['codex', { kind: 'signedOut' }, { kind: 'signIn', runtime: 'codex' }],
  ])
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          'No seat could be opened for this Agent:',
          '  claude=opus-5 — claude is not a runtime on this desk, nor one it knows how to add',
          '  codex=gpt-5.5 — codex is signed out',
        ].join('\n'),
      )
      return true
    },
  )
  untouched(seen)
})

/**
 * The desk's agent registry, and the public registry behind it as a desk
 * holds it: the document it last fetched, listing these ids, cached under the
 * state directory — or nothing cached at all. The cached copy is stale to the
 * registry the seating is given, so anything that asked it for its document
 * would go to the network; the network fails, and every time it is asked is
 * counted.
 */
const withRegistry = async (listed: readonly string[] | null) => {
  const stateDir = tempDir('hd-agent-seat-registry-')
  if (listed) {
    // Fetched once, as listing the registry in Settings › Runtimes fetches it, and cached.
    const agents = listed.map((id) => ({ id, name: id, version: '1.0.0', distribution: { npx: { package: `${id}@1.0.0` } } }))
    await new AcpRegistry({ stateDir, fetchJson: async () => ({ agents }), which: () => null }).catalog(() => false)
  }
  const fetched: string[] = []
  const registry = new AcpRegistry({
    stateDir,
    freshMs: 0,
    fetchJson: async (url) => {
      fetched.push(url)
      throw new Error('the network is not there')
    },
    which: () => null,
  })
  const directory = new AgentDirectory({
    store: new AgentRegistryStore(join(stateDir, 'agents.json')),
    build: () => {
      throw new Error('nothing is added in these tests')
    },
    usageFor: () => null,
    registry,
  })
  return { directory, fetched }
}

test('an id only the public registry lists is one the desk could add, read from its cached copy — and never fetched', async () => {
  const { directory, fetched } = await withRegistry(['listed'])
  const seen = await rig('listed=m1, praxis=m1, codex=gpt-5.5', { codex: { models: ['gpt-5.5'], signedOut: true } }, { directory })
  // Not an agent this desk knows how to run; only the registry's document names it.
  assert.equal(knownAgent('listed'), undefined)
  const candidates: FlowSeat[] = [
    { runtime: 'listed', model: 'm1', thinking: false },
    { runtime: 'praxis', model: 'm1', thinking: false },
    { runtime: 'codex', model: 'gpt-5.5', thinking: false },
  ]
  const { offers } = await readDesk(seen.ctx, candidates)
  assert.deepEqual(fixesFor(candidates, offers), [
    ['listed', { kind: 'notInstalled', added: false }, { kind: 'add', runtime: 'listed' }],
    ['praxis', { kind: 'unknownRuntime' }, { kind: 'seats' }],
    ['codex', { kind: 'signedOut' }, { kind: 'signIn', runtime: 'codex' }],
  ])
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          'No seat could be opened for this Agent:',
          '  listed=m1 — listed is not installed',
          '  praxis=m1 — praxis is not a runtime on this desk, nor one it knows how to add',
          '  codex=gpt-5.5 — codex is signed out',
        ].join('\n'),
      )
      return true
    },
  )
  untouched(seen)
  // The cached copy is long stale, so asking the registry for its document
  // would have gone to the network. Read for the offers and again for the
  // seating, and nothing did.
  assert.deepEqual(fetched, [])
})

test('with nothing cached from the registry, the agents the desk knows decide alone — and still nothing is fetched', async () => {
  const { directory, fetched } = await withRegistry(null)
  const seen = await rig('listed=m1, devin=m1, codex=gpt-5.5', { codex: { models: ['gpt-5.5'] } }, { directory })
  const candidates: FlowSeat[] = [
    { runtime: 'listed', model: 'm1', thinking: false },
    { runtime: 'devin', model: 'm1', thinking: false },
    { runtime: 'codex', model: 'gpt-5.5', thinking: false },
  ]
  assert.deepEqual(fixesFor(candidates, (await readDesk(seen.ctx, candidates)).offers), [
    ['listed', { kind: 'unknownRuntime' }, { kind: 'seats' }],
    ['devin', { kind: 'notInstalled', added: false }, { kind: 'add', runtime: 'devin' }],
  ])
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(seen.created, [{ runtime: 'codex', model: 'gpt-5.5', cwd: '/tmp/x' }])
  assert.deepEqual(fetched, [])
})

/*
 * Only `offerOf`'s own "added, and its program is missing" branch produces
 * `notInstalled: added: true` — and until now nothing exercised it through
 * the real health read, so a return to the old "drop it" behaviour read the
 * same "not installed" sentence and no test noticed.
 */

test('a registered runtime whose program is missing is offered with that said, fixed by installing it — not dropped as though nobody added it', async () => {
  const { ctx } = await rig('gone=m', {
    gone: {
      models: ['m'],
      health: { state: 'unavailable', reason: 'notInstalled', message: 'Gone is not installed on this machine.' },
    },
  })
  const runtime = pretendRuntime('gone', {
    models: ['m'],
    health: { state: 'unavailable', reason: 'notInstalled', message: 'Gone is not installed on this machine.' },
  })
  const { offer } = await offerOf(ctx, runtime as never, Promise.resolve([]), 1_000)
  assert.deepEqual(offer, { runtime: 'gone', notInstalled: true, models: null, efforts: null, signedIn: false, spent: false })
  assert.deepEqual(reasonAgainst({ runtime: 'gone', thinking: false }, [offer]), { kind: 'notInstalled', added: true })
  assert.deepEqual(fixOf('gone', { kind: 'notInstalled', added: true }), { kind: 'install', runtime: 'gone' })
})

test("one model's spent window does not spend the runtime, and an agent that keeps its own account needs no sign-in", async () => {
  const { ctx, created } = await rig(
    'claude=opus-5/high',
    { claude: { models: ['opus-5'], keepsOwnAccount: true, signedOut: true } },
    // The shape every source reports: the account's own window with room left,
    // beside one model's that is spent. Switch models and the work continues.
    { reports: [reportFor('claude', [{ usedPercent: 21 }, { usedPercent: 100, scope: 'Fable only' }])] },
  )
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
})

test("seats named for one seating override the Agent's own preference", async () => {
  const { ctx, created } = await rig('cursor=gemini-3.8-flash/high')
  await agentMethods['agent/seat'](ctx, {
    id: 'reviewer',
    cwd: '/tmp/x',
    seats: [{ runtime: 'claude', model: 'opus-5' }],
  })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
})

// ------------------------------------------------------ the method, through the host

/** An Agent in the host's own roster, this machine's tier. */
const writeReviewer = async (stateDir: string, prefer: string): Promise<string> => {
  const source = agentFile(prefer)
  await mkdir(join(stateDir, 'agents', 'reviewer'), { recursive: true })
  await writeFile(join(stateDir, 'agents', 'reviewer', 'AGENT.md'), source, 'utf8')
  return source
}

/** The last settings every window was told this conversation has. */
const settingsSeen = (client: Client, id: string): SessionSettings | undefined =>
  client.events
    .filter((event): event is Extract<AgentEvent, { type: 'session/settings' }> => event.type === 'session/settings')
    .filter((event) => String(event.sessionId) === id)
    .at(-1)?.settings

/** How many times this window was told to drop one conversation. */
const removedFor = (client: Client, id: SessionId | string): number =>
  client.notifications.filter(
    (one) => 'method' in one && one.method === 'session/removed' && String(one.params.sessionId) === String(id),
  ).length

/** The name the desk keeps for a conversation, as `names.json` has it, or null. */
const nameOn = async (stateDir: string, runtime: string, id: SessionId | string): Promise<string | null> => {
  const raw = await readFile(join(stateDir, 'names.json'), 'utf8').catch(() => null)
  if (raw === null) return null
  const { entries } = JSON.parse(raw) as { entries: { runtime: string; sessionId: string; name: string }[] }
  return entries.find((one) => one.runtime === runtime && one.sessionId === String(id))?.name ?? null
}

/** The desk's own archive marks, as `archive.json` has them: `[runtime, id]` each. */
const archivedOn = async (stateDir: string): Promise<[string, string][]> => {
  const raw = await readFile(join(stateDir, 'archive.json'), 'utf8').catch(() => null)
  if (raw === null) return []
  const { entries } = JSON.parse(raw) as { entries: { runtime: string; sessionId: string }[] }
  return entries.map((one) => [one.runtime, one.sessionId])
}

test('through the host: seated on its picks, handed the brief once, and recorded — a record the runtime cannot take away', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  const source = await writeReviewer(harness.stateDir, 'seatfake=big/high')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal(session.settings?.agent, 'reviewer')
  assert.equal(session.settings?.briefDigest, digestOf(source))
  assert.equal(session.settings?.permission, 'read')

  const opened = seats.opened[0]
  assert.ok(opened)
  assert.equal(String(opened.id), String(session.id))
  assert.deepEqual(opened.sent, [orderFor('read', work)], 'the brief, once, and the rule it works under')
  // The same seating a flow's seat gets: the picks in, the inherited switches off.
  assert.deepEqual(opened.values(), { model: 'big', effort: 'high', thinking: false, fast: false, 'max-mode': false })
  assert.equal(opened.title, 'Reviewer')
  assert.equal(opened.closed, false)
  assert.equal(settingsSeen(client, String(session.id))?.agent, 'reviewer', 'every window is told')
  assert.equal(settingsSeen(client, String(session.id))?.permission, 'read')

  // The runtime re-announces its settings whole — a model change does — and
  // has never heard of the Agent. The record stands, in the host and in what
  // every window is sent.
  await client.call('session/options/set', {
    runtime: 'seatfake',
    sessionId: session.id,
    optionId: 'model',
    value: 'small',
  })
  await client.until(() => settingsSeen(client, String(session.id))?.model === 'small', 5_000, 'the model change')
  assert.equal(settingsSeen(client, String(session.id))?.agent, 'reviewer')
  assert.equal(settingsSeen(client, String(session.id))?.briefDigest, digestOf(source))
  assert.equal(settingsSeen(client, String(session.id))?.permission, 'read')
  const held = harness.host.registry.get(runtimeId('seatfake'), session.id)?.session.settings
  assert.equal(held?.model, 'small')
  assert.equal(held?.agent, 'reviewer')
  assert.equal(held?.briefDigest, digestOf(source))
  assert.equal(held?.permission, 'read')
})

test('through the host: a seat the runtime opens on something else is closed, passed over, and never handed the brief', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high+thinking')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        '  seatfake=small/high+thinking — seatfake runs it at medium effort, not high, and without thinking, which was asked for (Small has no thinking mode)',
    )
    return true
  })
  const opened = seats.opened[0]
  assert.ok(opened)
  assert.equal(opened.closed, true)
  assert.deepEqual(opened.sent, [])
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), opened.id)?.session.settings?.agent, undefined)
})

test('the wire refuses a seating that names no Agent or no folder', async (t) => {
  const { client } = await desk(t)
  const badRequest = (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'badRequest')
    return true
  }
  await assert.rejects(client.call('agent/seat', { id: '', cwd: '/w' }), badRequest)
  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: ' ' }), badRequest)
  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: '/w', seats: [{ model: 'm' }] }), badRequest)
})

test('a renderer cannot make a conversation wear an Agent the host never seated it as', async (t) => {
  const { harness, client } = await desk(t)
  const session = (await client.call('session/create', {
    runtime: FAKE_RUNTIME_ID,
    options: { cwd: '/w', agent: 'forged', briefDigest: 'forged', permission: 'merge' },
  })) as Session
  assert.equal(session.settings?.agent, undefined)
  // The plain fake echoes a patch back into its settings, the way a runtime might.
  await client.call('session/settings', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    patch: { agent: 'forged', briefDigest: 'forged', permission: 'merge' },
  })
  await client.until(() => settingsSeen(client, String(session.id)) !== undefined, 5_000, 'the echoed settings')
  assert.equal(settingsSeen(client, String(session.id))?.agent, undefined)
  assert.equal(settingsSeen(client, String(session.id))?.briefDigest, undefined)
  // Least of all what it may do: a permission a renderer could write is a permission anybody could.
  assert.equal(settingsSeen(client, String(session.id))?.permission, undefined)
  const held = harness.host.registry.get(FAKE_RUNTIME_ID, session.id)?.session.settings
  assert.equal(held?.agent, undefined)
  assert.equal(held?.permission, undefined)
})

test('the wire refuses a grant that is no permission, and more seats than an Agent may prefer', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=big/high')
  const badRequest = (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'badRequest')
    return true
  }
  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work, permission: 'admin' }), badRequest)
  // Every seat that opens and is passed over costs a conversation, so the list is capped.
  const nine = Array.from({ length: 9 }, () => ({ runtime: 'seatfake', model: 'big', effort: 'high' }))
  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work, seats: nine }), badRequest)
  assert.deepEqual(seats.opened, [], 'nothing was opened for either')
  // Eight is allowed, and so is a grant that is a permission — narrowed to the ceiling on the way in.
  const session = (await client.call('agent/seat', {
    id: 'reviewer',
    cwd: work,
    seats: nine.slice(1),
    permission: 'merge',
  })) as Session
  assert.equal(session.settings?.permission, 'read')
})

// ------------------------------------------------------ down the preference list

/*
 * A seat that opens on something other than it asked for is passed over like
 * any other candidate, and the next one the Agent named is tried. The next one
 * is something the Agent asked for, so trying it substitutes nothing — and a
 * fact found after opening must not end a seating that the same fact, found
 * before, would only have moved past. One seat at a time: whatever was opened
 * and not kept is closed, and let go, before the next is opened.
 */

test('a seat that runs another effort than asked is closed, and the next candidate the Agent named is seated', async () => {
  const seen = await rig('claude=opus-5/high, claude=sonnet-5/high', { claude: { models: ['opus-5', 'sonnet-5'] } }, {
    comesBackAs: (seat) => (seat.model === 'opus-5' ? { effort: 'medium' } : {}),
  })
  const session = await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(seen.created, [
    { runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' },
    { runtime: 'claude', model: 'sonnet-5', cwd: '/tmp/x' },
  ])
  assert.deepEqual(seen.retired, ['claude s1'], 'the first was closed')
  assert.equal(String(session.id), 's2')
  assert.deepEqual(seen.ordered, [orderFor('read', '/tmp/x')], 'the brief went once, to the seat that was kept')
  assert.deepEqual(seen.recorded, [{ agent: 'reviewer', briefDigest: digestOf(seen.source), permission: 'read' }])
  assert.deepEqual(seen.overlaps, [], 'never two seats at once')
  assert.equal(seen.alive(), 1, 'the seat kept is the only one left')
})

test('when every candidate fails, before opening or after, the refusal names each with its own reason and nothing is left open', async () => {
  const seen = await rig(
    'cursor=gemini-3.8-flash/high, claude=opus-5/high, codex=gpt-5.3/xhigh, claude=opus-5/high+thinking, claude=sonnet-5/high',
    { claude: { models: ['opus-5', 'sonnet-5'] }, codex: { models: ['gpt-5.3'], signedOut: true } },
    {
      comesBackAs: (seat) =>
        seat.thinking ? { thinking: false, thinkingFixed: 'Opus 5 has no thinking mode here.' } : { effort: 'medium' },
      openFails: (seat) => (seat.model === 'sonnet-5' ? 'The agent is not running.' : null),
    },
  )
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        [
          'No seat could be opened for this Agent:',
          '  cursor=gemini-3.8-flash/high — cursor is not installed',
          '  claude=opus-5/high — claude runs it at medium effort, not high',
          '  codex=gpt-5.3/xhigh — codex is signed out',
          '  claude=opus-5/high+thinking — claude runs it without thinking, which was asked for (Opus 5 has no thinking mode here)',
          '  claude=sonnet-5/high — claude could not open a conversation: The agent is not running.',
        ].join('\n'),
      )
      return true
    },
  )
  assert.equal(seen.created.length, 2, 'the two that opened')
  assert.deepEqual(seen.retired, ['claude s1', 'claude s2'], 'and both were closed')
  assert.deepEqual(seen.ordered, [])
  assert.deepEqual(seen.recorded, [])
  assert.deepEqual(seen.overlaps, [])
  assert.equal(seen.alive(), 0, 'no seat is left open')
})

test('through the host: one seat at a time — each that fails is closed and let go before the next is opened', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  const source = await writeReviewer(harness.stateDir, 'seatfake=big/high, seatfake=small/high, seatfake=big/low')
  const held = (one: SeatSession) => harness.host.registry.get(runtimeId('seatfake'), one.id)?.live ?? null
  const overlaps: string[] = []
  seats.beforeCreate = () => {
    for (const one of seats.opened) {
      if (!one.closed) overlaps.push(`${String(one.id)} was still open`)
      if (held(one) !== null) overlaps.push(`${String(one.id)} was still held by the host`)
    }
  }
  // The first opens, then is lost part-way through being put on its picks.
  seats.breakNext = true

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.deepEqual(overlaps, [], 'never two seats at once')
  const [lost, other, kept] = seats.opened
  assert.ok(lost && other && kept && seats.opened.length === 3)
  assert.deepEqual([lost.closed, other.closed, kept.closed], [true, true, false])
  assert.deepEqual([held(lost), held(other)], [null, null], 'the host holds only the seat it kept')
  assert.ok(held(kept))
  assert.equal(String(kept.id), String(session.id))
  assert.deepEqual([lost.sent, other.sent, kept.sent], [[], [], [orderFor('read', work)]])
  assert.deepEqual(kept.values(), { model: 'big', effort: 'low', thinking: false, fast: false, 'max-mode': false })
  assert.equal(session.settings?.agent, 'reviewer')
  assert.equal(session.settings?.briefDigest, digestOf(source))
  // Discarded, not merely closed — the one lost part-way through opening too,
  // by the failure path a flow's seats share: deleted where the runtime keeps
  // it, out of the host's records, and out of every window.
  assert.deepEqual(seats.deleted, [String(lost.id), String(other.id)])
  for (const one of [lost, other]) {
    assert.equal(harness.host.registry.get(runtimeId('seatfake'), one.id), undefined, `no record of ${String(one.id)}`)
    await client.until(() => removedFor(client, one.id) === 1, 2_000, `session/removed for ${String(one.id)}`)
  }
})

test('through the host: when every candidate fails the refusal names each, and no conversation is left open', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'devin=m1, seatfake=small/high, seatfake=small/medium+thinking')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      [
        'No seat could be opened for this Agent:',
        // `devin` is a real, known runtime (`known-agents.ts`) nobody added to
        // this real host — unlike a made-up id, which would read differently.
        '  devin=m1 — devin is not installed',
        '  seatfake=small/high — seatfake runs it at medium effort, not high',
        '  seatfake=small/medium+thinking — seatfake runs it without thinking, which was asked for (Small has no thinking mode)',
      ].join('\n'),
    )
    return true
  })
  assert.equal(seats.opened.length, 2)
  for (const one of seats.opened) {
    assert.equal(one.closed, true)
    assert.deepEqual(one.sent, [])
    assert.equal(harness.host.registry.get(runtimeId('seatfake'), one.id)?.live ?? null, null)
    assert.equal(harness.host.registry.get(runtimeId('seatfake'), one.id)?.session.settings?.agent, undefined)
  }
})

// ------------------------------------------------------ thinking asked to be off

test('through the host: thinking asked to be off is held to it, even on a model that always thinks', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  seats.alwaysThinks.add('big')
  await writeReviewer(harness.stateDir, 'seatfake=big/high')

  // A seat that says nothing of thinking, on a model that always thinks, is the model it asked for.
  const kept = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal(kept.settings?.agent, 'reviewer')
  assert.equal(seats.opened[0]?.values().thinking, true)

  // One that asks for it off, through the wire's override, is not: the allowance is for silence only.
  await assert.rejects(
    client.call('agent/seat', {
      id: 'reviewer',
      cwd: work,
      seats: [{ runtime: 'seatfake', model: 'big', effort: 'high', thinking: false }],
    }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  seatfake=big/high — seatfake runs it with thinking on, which was asked to be off (Big always thinks)',
      )
      return true
    },
  )
  const refused = seats.opened[1]
  assert.ok(refused && seats.opened.length === 2)
  assert.equal(refused.closed, true)
  assert.deepEqual(refused.sent, [], 'never handed the brief')
})

// ------------------------------------------------------ over ACP, where a pick settles where the agent puts it

/*
 * The seat fake above drops a pick it has no place for. An ACP agent can do
 * something quieter: take the pick, settle it on the nearest thing it has, and
 * answer the call without an error — Cursor's bridge does it by design. So these
 * run the real ACP adapter against a scripted agent that does exactly that (the
 * adapter's own fixture, `variant-acp-agent.mjs`: variants (high, no thinking)
 * and (medium, thinking), nothing else), and ask the agent itself what it ran
 * the brief on.
 */

const ACP_FIXTURES = new URL('../../../adapter-acp/dist/test/fixtures/', import.meta.url)

/** A desk with one ACP agent on it, spawned from the adapter's own fixtures. */
const acpDesk = async (t: TestContext, fixture: string, id: string, env: Record<string, string>) => {
  const { harness, client, work } = await desk(t)
  const runtime = new AcpRuntime({
    id,
    name: id === 'variant' ? 'Variant' : 'Acp Fake',
    command: process.execPath,
    args: [fileURLToPath(new URL(fixture, ACP_FIXTURES))],
    env,
  })
  harness.host.register(runtime)
  await runtime.start()
  t.after(() => runtime.dispose())
  return { harness, client, work }
}

/** What the agent ran each prompt on, one line per prompt, as it wrote it down. */
const ranOn = async (truth: string) =>
  (await readFile(truth, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { session: string; model: string; effort: string; thinking: boolean })

for (const [answer, how] of [
  ['announce', 'announced before an empty answer, as the Cursor bridge does'],
  ['reply', 'said in its answer, as ACP has it'],
] as const) {
  test(`over ACP: a seat the agent settles on another variant is passed over — the settling ${how}`, async (t) => {
    const truth = join(tempDir('hd-variant-truth-'), 'truth.jsonl')
    const { harness, client, work } = await acpDesk(t, 'variant-acp-agent.mjs', 'variant', {
      VARIANT_ANSWER: answer,
      VARIANT_TRUTH: truth,
    })
    await writeReviewer(harness.stateDir, 'variant=fam/high+thinking, variant=fam/medium')

    // Neither candidate's runtime can delete what it opened — a bare ACP
    // agent, `variant` declares no `_harnessdesk/session/delete` — so each is
    // archived here instead, and the refusal says so on its own line.
    const archived =
      "the conversation it opened may stay in variant's own history, which the desk cannot delete from; it is archived here"
    await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
      assert.equal(
        error.message,
        [
          'No seat could be opened for this Agent:',
          // High has no thinking variant: asked for, thinking is settled off.
          `  variant=fam/high+thinking — variant runs it without thinking, which was asked for (${archived})`,
          // Medium comes with thinking, and turning it off is declined.
          `  variant=fam/medium — variant runs it with thinking on, which was not asked for and would not turn off (${archived})`,
        ].join('\n'),
      )
      return true
    })
    assert.deepEqual(await ranOn(truth), [], 'no variant was handed the brief')
  })
}

test('over ACP: the next candidate that runs what it asked for is seated, and the agent runs the brief on it', async (t) => {
  const truth = join(tempDir('hd-variant-truth-'), 'truth.jsonl')
  const { harness, client, work } = await acpDesk(t, 'variant-acp-agent.mjs', 'variant', { VARIANT_TRUTH: truth })
  await writeReviewer(harness.stateDir, 'variant=fam/high+thinking, variant=fam/medium+thinking')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  assert.equal(session.settings?.agent, 'reviewer')
  // The brief is a turn; the agent writes down what it ran it on when it runs it.
  const deadline = Date.now() + 5_000
  while ((await ranOn(truth)).length === 0 && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 20))
  assert.deepEqual(await ranOn(truth), [{ session: String(session.id), model: 'fam', effort: 'medium', thinking: true }])
})

test("over ACP: a flow seat's label says what the agent settled on, not what the flow asked for", async (t) => {
  // The flow still seats — a flow says a difference, it does not refuse one —
  // but what it says is now what runs: medium comes with thinking.
  const { client, work } = await acpDesk(t, 'variant-acp-agent.mjs', 'variant', {})
  const run = await runFlow(client, work, 'variant=fam/medium')
  assert.deepEqual(
    run.seats.map((one) => one.seat),
    ['Variant · Fam · Medium · thinking'],
  )
})

test('over ACP: an agent whose model list could not be read is refused as unread, never as not offering the model', async (t) => {
  // Every conversation this agent is asked to open fails, the draft probe that
  // would have read its models included.
  const { harness, client, work } = await acpDesk(t, 'fake-acp-agent.mjs', 'acpfake', { FAKE_ACP_SERVER_ERROR: '1' })
  await writeReviewer(harness.stateDir, 'acpfake=small')
  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        '  acpfake=small — cannot tell whether acpfake offers small: its model list could not be read',
    )
    return true
  })
})

// ------------------------------------------------------ over Codex, where an effort lands where Codex puts it

/*
 * Codex answers a settings change with `{}` and says where it landed only in
 * `thread/settings/updated`, which reaches the desk after the answer — a
 * millisecond after, from 0.149.0 — or in the same read as it. So these run
 * the real Codex adapter against its own fake, set to settle an effort asked
 * for as high on low, and check the seat is read back from what Codex said
 * whichever way the two arrive.
 */

const CODEX_FAKE = fileURLToPath(new URL('../../../adapter-codex/dist/test/fixtures/fake-codex.mjs', import.meta.url))

/** A desk with the real Codex adapter on it, over the adapter's own fake. */
const codexDesk = async (t: TestContext, env: Record<string, string>) => {
  const { harness, client, work } = await desk(t)
  const runtime = new CodexRuntime({ binaryPath: CODEX_FAKE, clientName: 'harnessdesk-test', env })
  harness.host.register(runtime)
  await runtime.start()
  t.after(() => runtime.dispose())
  return { harness, client, work }
}

for (const [order, how] of [
  ['answer-first', 'said after the answer, as 0.149.0 says it'],
  ['one-chunk', 'said in the same read as the answer'],
] as const) {
  test(`over Codex: a seat whose effort Codex settles elsewhere is passed over — ${how}`, async (t) => {
    const { harness, client, work } = await codexDesk(t, {
      FAKE_CODEX_EFFORT_SETTLES: 'high:low',
      FAKE_CODEX_SETTINGS_ORDER: order,
    })
    await writeReviewer(harness.stateDir, 'codex=gpt-5.5/high')

    await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' + '  codex=gpt-5.5/high — codex runs it at low effort, not high',
      )
      return true
    })
  })

  test(`over Codex: the next candidate, running what it asked for, is the one seated — ${how}`, async (t) => {
    const { harness, client, work } = await codexDesk(t, {
      FAKE_CODEX_EFFORT_SETTLES: 'high:low',
      FAKE_CODEX_SETTINGS_ORDER: order,
    })
    await writeReviewer(harness.stateDir, 'codex=gpt-5.5/high, codex=gpt-5.5/low')

    const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
    // The fake numbers its threads: the first went to the candidate passed over.
    assert.equal(String(session.id), 'thread-e2e-2')
    assert.equal(session.settings?.agent, 'reviewer')
    assert.equal(session.options?.find((option) => option.id === 'effort')?.currentValue, 'low')
    assert.equal(harness.host.registry.get(runtimeId('codex'), sessionId('thread-e2e'))?.live ?? null, null, 'the first is let go')
  })
}

/*
 * The reads a seating makes before it chooses, each held to a deadline. A
 * runtime that never answers would otherwise hold the seating — and every menu
 * drawn from a dry run — open for ever.
 */

test('a runtime that never says whether it is signed in is passed over, and the next candidate is seated', async () => {
  const seen = await rig(
    'mute=m1, claude=opus-5',
    { mute: { models: ['m1'], accountHangs: true }, claude: { models: ['opus-5'] } },
    { deadlineMs: 30 },
  )
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(seen.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  // Not merely "some other candidate was seated" — `mute` specifically was
  // passed over for staying silent, not for some other, accidental reason
  // (the deadline that let `agent/seat` above proceed at all is deterministic
  // proof of this on its own, but a real-clock bound on that is redundant and
  // was flaky; this checks the reason itself instead).
  const muted = pretendRuntime('mute', { models: ['m1'], accountHangs: true })
  const { offer } = await offerOf(seen.ctx, muted as never, Promise.resolve([]), 30)
  assert.deepEqual(reasonAgainst({ runtime: 'mute', thinking: false }, [offer]), { kind: 'noAnswer', after: 30 })
})

test('when the only candidate never answers, the refusal says so and nothing is opened', async () => {
  const seen = await rig('mute=m1', { mute: { models: ['m1'], accountHangs: true } }, { deadlineMs: 30 })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  mute=m1 — mute did not answer within 30 ms when asked whether it is signed in',
      )
      return true
    },
  )
  untouched(seen)
})

/** Every promise already able to settle has, and whatever it set off after itself has run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('usage and the per-runtime reads run concurrently: one deadline settles both, not one after the other', async (t) => {
  // Usage and mute's own account read both hang to their deadline. Run at
  // once, both timers start together and one deadline settles the call.
  // Stacked, the account read's timer would not even start until usage had
  // settled, and the call would still be waiting when the first ran out.
  const seen = await rig('mute=m1', { mute: { models: ['m1'], accountHangs: true } }, { deadlineMs: 150, usageHangs: true })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let answered: readonly SeatOffer[] | undefined
  void readDesk(seen.ctx, [{ runtime: 'mute', model: 'm1', thinking: false }]).then((desk) => {
    answered = desk.offers
  })
  t.mock.timers.tick(150)
  await flush()
  assert.deepEqual(
    answered,
    [{ runtime: 'mute', silent: 150, models: null, efforts: null, signedIn: false, spent: false }],
    'one deadline in, the call has answered',
  )
})

test('a read that throws does not answer the call while the others still run behind it', async (t) => {
  // `broken` fails at once; mute's account read and the usage read are still
  // out, each on a timer. Answering now would leave both running behind a
  // call that had already returned.
  const seen = await rig(
    'broken=m1, mute=m1',
    { broken: { models: ['m1'], healthThrows: 'the bridge went away' }, mute: { models: ['m1'], accountHangs: true } },
    { deadlineMs: 150, usageHangs: true },
  )
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let outcome = 'pending'
  void readDesk(seen.ctx, [
    { runtime: 'broken', model: 'm1', thinking: false },
    { runtime: 'mute', model: 'm1', thinking: false },
  ]).then(
    () => {
      outcome = 'answered'
    },
    (error: Error) => {
      outcome = `failed: ${error.message}`
    },
  )
  await flush()
  assert.equal(outcome, 'pending', 'broken has failed, and the other reads are still out')
  t.mock.timers.tick(150)
  await flush()
  // The failure is still the answer, once everything it set off has settled —
  // the usage read included, which said so before the call answered.
  assert.equal(outcome, 'failed: the bridge went away')
  assert.deepEqual(seen.warned, [
    ['a seating read no usage within its deadline, so the last readings stand in', { afterMs: 150 }],
  ])
})

test('a seatReadDeadlineMs that is not a real deadline falls back to the ten-second default', async (t) => {
  // -5 is neither finite-and-positive nor left unset, so `?? SEAT_READ_DEADLINE_MS`
  // alone would pass it straight through to a real timer.
  const seen = await rig('mute=m1', { mute: { models: ['m1'], accountHangs: true } }, { deadlineMs: -5 })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Read once the clock has moved, not awaited: a call still waiting then is
  // a failure to report, not a test to hang on.
  let answered: readonly SeatOffer[] | undefined
  void readDesk(seen.ctx, [{ runtime: 'mute', model: 'm1', thinking: false }]).then((desk) => {
    answered = desk.offers
  })
  t.mock.timers.tick(SEAT_READ_DEADLINE_MS)
  await flush()
  assert.deepEqual(answered, [
    { runtime: 'mute', silent: SEAT_READ_DEADLINE_MS, models: null, efforts: null, signedIn: false, spent: false },
  ])
})

test('a model list that never arrives is unread, and a candidate that names no model is still seated', async () => {
  const named = await rig('slow=m1', { slow: { models: ['m1'], modelsHang: true } }, { deadlineMs: 30 })
  await assert.rejects(
    () => agentMethods['agent/seat'](named.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /slow=m1 — cannot tell whether slow offers m1: its model list could not be read$/,
  )
  untouched(named)
  const bare = await rig('slow', { slow: { models: ['m1'], modelsHang: true } }, { deadlineMs: 30 })
  await agentMethods['agent/seat'](bare.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(bare.created, [{ runtime: 'slow', cwd: '/tmp/x' }])
})

test('usage that never arrives holds no seating: the last reading stands in, and the log says so', async () => {
  const seen = await rig(
    'spent=m1, claude=opus-5',
    { spent: { models: ['m1'] }, claude: { models: ['opus-5'] } },
    { deadlineMs: 30, usageHangs: true, cached: [reportFor('spent', [{ usedPercent: 100 }])] },
  )
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  // Spent by the last reading, so passed over; claude has no reading, so is not known to be spent.
  assert.deepEqual(seen.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  assert.deepEqual(seen.warned, [
    ['a seating read no usage within its deadline, so the last readings stand in', { afterMs: 30 }],
  ])
})

test('usage that fails outright holds no seating either: the last reading stands in, and the log names the failure', async () => {
  const seen = await rig(
    'spent=m1, claude=opus-5',
    { spent: { models: ['m1'] }, claude: { models: ['opus-5'] } },
    { deadlineMs: 30, usageFails: true, cached: [reportFor('spent', [{ usedPercent: 100 }])] },
  )
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(seen.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  // A distinct message from the "late" branch above, naming the failure: this one failed outright.
  assert.deepEqual(seen.warned, [
    ['a seating could not read usage, so the last readings stand in', { error: 'Error: the usage endpoint timed out' }],
  ])
})

test('a runtime whose usage is switched off is not passed over as spent from an old reading', async () => {
  const seen = await rig(
    'silenced=m1, claude=opus-5',
    { silenced: { models: ['m1'] }, claude: { models: ['opus-5'] } },
    {
      deadlineMs: 30,
      usageHangs: true,
      unmetered: ['silenced'],
      cached: [reportFor('silenced', [{ usedPercent: 100 }])],
    },
  )
  await agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  // `silenced` is first in `prefer`: were its old 100% reading consulted, it
  // would be passed over as spent and `claude` seated instead.
  assert.deepEqual(seen.created, [{ runtime: 'silenced', model: 'm1', cwd: '/tmp/x' }])
})

/*
 * A seat passed over leaves nothing behind: not in the runtime's history, not
 * in the desk's records, not as a row in any window. What a runtime cannot
 * remove is said, on the candidate's own line.
 */

test('a seat passed over once open is discarded, not merely closed; one whose brief may have arrived is only closed', async () => {
  const passed = await rig('claude=opus-5/high, claude=sonnet-5/high', { claude: { models: ['opus-5', 'sonnet-5'] } }, {
    comesBackAs: (seat) => (seat.model === 'opus-5' ? { effort: 'medium' } : {}),
  })
  await agentMethods['agent/seat'](passed.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(passed.discarded, ['claude s1'])

  const ordered = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, { orderFails: 'Claude is not running.' })
  await assert.rejects(() => agentMethods['agent/seat'](ordered.ctx, { id: 'reviewer', cwd: '/tmp/x' }))
  assert.deepEqual(ordered.retired, ['claude s1'])
  assert.deepEqual(ordered.discarded, [], 'a brief may have reached it, so it is not the desk’s to delete')
})

/*
 * What each passed-over conversation was left as, on its own line — no more
 * than the desk knows: a runtime with no delete *may* keep it, "archived here"
 * only when the desk's archive took it, and the runtime's own words for a
 * refused delete, quoted because the clause goes on after them.
 */
for (const [left, words] of [
  [
    { kind: 'kept', archived: 'here' },
    "the conversation it opened may stay in claude's own history, which the desk cannot delete from; it is archived here",
  ],
  [
    { kind: 'kept', archived: 'runtime' },
    "the conversation it opened may stay in claude's own history, which the desk cannot delete from; it is in claude's own archive",
  ],
  [
    { kind: 'kept', archived: 'failed' },
    "the conversation it opened may stay in claude's own history, which the desk cannot delete from; archiving it failed, so it may still be listed",
  ],
  [
    { kind: 'undeleted', detail: 'The thread is locked.', archived: 'here' },
    'the conversation it opened could not be deleted: “The thread is locked”; it is archived here',
  ],
  [
    { kind: 'undeleted', detail: 'The thread is locked.', archived: 'failed' },
    'the conversation it opened could not be deleted: “The thread is locked”; archiving it failed, so it may still be listed',
  ],
  [{ kind: 'inUse' }, 'the conversation it opened was used meanwhile, so it was left as it is'],
  [{ kind: 'alreadyHeld' }, 'the conversation it opened is one the desk already held, so it was left as it is'],
  [
    { kind: 'unasked' },
    'claude was gone before it could be asked to delete the conversation it opened, which may stay in its history',
  ],
] as const satisfies readonly (readonly [SeatLeft, string])[]) {
  const said = 'archived' in left ? `${left.kind}, ${left.archived}` : left.kind
  test(`what a passed-over seat was left as is said on its own line of the refusal — ${said}`, async () => {
    const seen = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, {
      comesBackAs: () => ({ effort: 'medium' }),
      leaves: () => left,
    })
    await assert.rejects(
      () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
      (error: Error) => {
        assert.equal(
          error.message,
          'No seat could be opened for this Agent:\n' +
            `  claude=opus-5/high — claude runs it at medium effort, not high (${words})`,
        )
        return true
      },
    )
  })
}

test('through the host: a seat passed over is deleted where its runtime keeps it, forgotten by the desk, and dropped from every window', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high, seatfake=big/high')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const [passed, kept] = seats.opened
  assert.ok(passed && kept && seats.opened.length === 2)
  assert.equal(String(kept.id), String(session.id))
  // Where the runtime keeps it…
  assert.deepEqual(seats.deleted, [String(passed.id)])
  // …and everything the desk held: its record, and the name it was given.
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), passed.id), undefined)
  const names = await readFile(join(harness.stateDir, 'names.json'), 'utf8').catch(() => '')
  assert.equal(names.includes(String(passed.id)), false, 'the name the seat was given is gone')
  // …and every window, which took it in from its session/started.
  await client.until(
    () =>
      client.notifications.some(
        (one) => 'method' in one && one.method === 'session/removed' && String(one.params.sessionId) === String(passed.id),
      ),
    2_000,
    'session/removed for the seat passed over',
  )
  // The kept seat is untouched.
  assert.ok(harness.host.registry.get(runtimeId('seatfake'), kept.id))
})

test('through the host: a runtime that cannot delete keeps what it keeps, archived, and the refusal says so', async (t) => {
  const { harness, client, work } = await desk(t)
  const keeper = new SeatFake({ id: 'keeper', capabilities: { deleteHistory: false, archiveHistory: false } })
  harness.host.register(keeper)
  await keeper.start()
  await writeReviewer(harness.stateDir, 'keeper=small/high')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        "  keeper=small/high — keeper runs it at medium effort, not high (the conversation it opened may stay in keeper's own history, which the desk cannot delete from; it is archived here)",
    )
    return true
  })
  const [opened] = keeper.opened
  assert.ok(opened)
  assert.deepEqual(keeper.deleted, [], 'nothing was asked of a runtime that cannot delete')
  assert.deepEqual(await archivedOn(harness.stateDir), [['keeper', String(opened.id)]])
  // It may still be listed in the agent's history, so it keeps its name: hidden, and explained.
  assert.equal(await nameOn(harness.stateDir, 'keeper', opened.id), 'Reviewer')
  assert.equal(harness.host.registry.get(runtimeId('keeper'), opened.id), undefined)
})

/*
 * Never a conversation somebody used. A candidate is a row in every window
 * from its `session/started`, titled with the Agent's name, until the seating
 * decides about it — across the title, the name, every pick and the read-back —
 * and a person can open that row and write in it. The desk deletes only what
 * its seating opened and nobody else touched; anything else is closed and left
 * as it is, and its line says so.
 */

/** The candidate a seating on `seatfake=small/high` opens, held at its naming while the test acts. */
const heldAtNaming = async (t: TestContext) => {
  const rigged = await desk(t)
  await writeReviewer(rigged.harness.stateDir, 'seatfake=small/high')
  const naming = gate()
  rigged.seats.stops.title = naming
  const seating = rigged.client.call('agent/seat', { id: 'reviewer', cwd: rigged.work })
  await naming.reached
  const [candidate] = rigged.seats.opened
  assert.ok(candidate)
  return { ...rigged, seating, candidate, naming }
}

/** The refusal of a seating whose one candidate, `seatfake=small/high`, was left as it is for `words`. */
const refusedLeaving = (words: string) => (error: Error) => {
  assert.equal(
    error.message,
    'No seat could be opened for this Agent:\n' +
      `  seatfake=small/high — seatfake runs it at medium effort, not high (${words})`,
  )
  return true
}

const USED = 'the conversation it opened was used meanwhile, so it was left as it is'

test('through the host: a message a person sends the candidate before it is read back keeps it — nothing deleted, and its line says so', async (t) => {
  const { harness, seats, client, seating, candidate, naming } = await heldAtNaming(t)
  // The row every window drew from its session/started: a person opens it and writes.
  await client.call('turn/queue', {
    runtime: 'seatfake',
    sessionId: candidate.id,
    input: [{ type: 'text', text: 'Is anyone there?' }],
  })
  naming.open()
  const refused = await seating.then(
    () => assert.fail('the seating was expected to be refused'),
    (error: Error) => error,
  )

  assert.deepEqual(candidate.sent, ['Is anyone there?'], 'the message reached it')
  assert.deepEqual(seats.deleted, [], 'nothing was deleted')
  assert.deepEqual([...seats.archived], [], 'or archived')
  const record = harness.host.registry.get(runtimeId('seatfake'), candidate.id)
  assert.ok(record, 'its record stays')
  assert.equal(record.session.turns.length, 1)
  assert.equal(await nameOn(harness.stateDir, 'seatfake', candidate.id), 'Reviewer', 'and its name')
  assert.equal(removedFor(client, candidate.id), 0, 'and its row in every window')
  assert.equal(candidate.closed, true, 'the seating closed the handle it opened, as a retired seat is')
  refusedLeaving(USED)(refused)
})

test('through the host: a reopen that lands while the seat is being let go keeps its handle, and nothing is removed', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high')
  const closing = gate()
  seats.stops.close = closing
  const seating = client.call('agent/seat', { id: 'reviewer', cwd: work })
  await closing.reached
  const [candidate] = seats.opened
  assert.ok(candidate)
  // Passed over, and being let go — and a person opens its row meanwhile.
  await client.call('session/resume', { runtime: 'seatfake', sessionId: candidate.id })
  const [reopened] = seats.reopened
  assert.ok(reopened && seats.reopened.length === 1)
  closing.open()
  const refused = await seating.then(
    () => assert.fail('the seating was expected to be refused'),
    (error: Error) => error,
  )

  assert.deepEqual(seats.deleted, [], 'nothing was deleted')
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), candidate.id)?.live, reopened, 'the host still holds the reopen')
  assert.equal(reopened.closed, false, 'which is open')
  assert.equal(candidate.closed, true, 'and only the handle the seating opened was closed')
  assert.equal(removedFor(client, candidate.id), 0, 'no window was told to drop it')
  refusedLeaving(USED)(refused)
})

test('through the host: a reopen before the read-back keeps its own handle — the seating closes only the one it opened', async (t) => {
  const { harness, seats, client, seating, candidate, naming } = await heldAtNaming(t)
  await client.call('session/resume', { runtime: 'seatfake', sessionId: candidate.id })
  const [reopened] = seats.reopened
  assert.ok(reopened)
  naming.open()

  await assert.rejects(seating, refusedLeaving(USED))
  assert.equal(candidate.closed, true, 'the seating closed the handle it opened')
  assert.equal(reopened.closed, false, 'and left the person’s alone')
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), candidate.id)?.live, reopened)
})

test('through the host: a window that only opened the candidate keeps it — a person looking at a conversation is about to use it', async (t) => {
  const { harness, seats, client, seating, candidate, naming } = await heldAtNaming(t)
  // A read leaves no turn, no queued message and no handle of its own: only the ask itself says it happened.
  await client.call('session/read', { runtime: 'seatfake', sessionId: candidate.id })
  naming.open()

  await assert.rejects(seating, refusedLeaving(USED))
  assert.deepEqual(seats.deleted, [])
  assert.ok(harness.host.registry.get(runtimeId('seatfake'), candidate.id))
  assert.equal(removedFor(client, candidate.id), 0)
})

test('through the host: a turn that starts on the candidate any other way — a room’s post, say — keeps it too', async (t) => {
  const { harness, seats, client, seating, candidate, naming } = await heldAtNaming(t)
  // No window asked anything of it; the agent reports a turn starting all the same.
  seats.emit({
    type: 'turn/started',
    sessionId: candidate.id,
    turn: { id: turnId('from-elsewhere'), items: [], status: 'inProgress' },
  })
  naming.open()

  await assert.rejects(seating, refusedLeaving(USED))
  assert.deepEqual(seats.deleted, [])
  assert.ok(harness.host.registry.get(runtimeId('seatfake'), candidate.id))
  assert.equal(removedFor(client, candidate.id), 0)
})

test('through the host: once the candidate is being deleted, a window that asks for it is refused, and nothing comes back', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high')
  const deleting = gate()
  seats.stops.delete = deleting
  const seating = client.call('agent/seat', { id: 'reviewer', cwd: work })
  await deleting.reached
  const [candidate] = seats.opened
  assert.ok(candidate)
  // Past the point of no return: a reopen now would be a live handle on a conversation about to be erased.
  await assert.rejects(
    client.call('session/resume', { runtime: 'seatfake', sessionId: candidate.id }),
    (error: Error & { code?: unknown }) => {
      assert.equal(error.code, 'sessionGone')
      assert.equal(error.message, 'This conversation was opened for a seat that was passed over, and it is being removed.')
      return true
    },
  )
  deleting.open()

  await assert.rejects(seating, (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n  seatfake=small/high — seatfake runs it at medium effort, not high',
    )
    return true
  })
  assert.deepEqual(seats.deleted, [String(candidate.id)])
  assert.deepEqual(seats.reopened, [], 'no handle was opened on it')
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), candidate.id), undefined, 'and no record came back')
  await client.until(() => removedFor(client, candidate.id) === 1, 2_000, 'session/removed for the candidate')
})

test('through the host: a runtime that hands back a conversation the desk already holds keeps it — it was never the seating’s', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  // A conversation somebody started on this agent, which the desk holds.
  const theirs = (await client.call('session/create', { runtime: 'seatfake', options: { cwd: work } })) as Session
  await writeReviewer(harness.stateDir, 'seatfake=small/high')
  // Asked for a new one, the agent answers with that same id.
  seats.mintAs = String(theirs.id)

  await assert.rejects(
    client.call('agent/seat', { id: 'reviewer', cwd: work }),
    refusedLeaving('the conversation it opened is one the desk already held, so it was left as it is'),
  )
  assert.deepEqual(seats.deleted, [])
  assert.ok(harness.host.registry.get(runtimeId('seatfake'), theirs.id), 'its record stays')
  assert.equal(removedFor(client, theirs.id), 0)
})

/*
 * What could not be deleted is archived and keeps its name, and its line says
 * where it went — in the runtime's own words when the runtime refused.
 */

for (const [archiveHistory, where] of [
  [true, "it is in refuser's own archive"],
  [false, 'it is archived here'],
] as const) {
  test(`through the host: a delete the runtime refuses is archived and named, and said in its words — ${where}`, async (t) => {
    const { harness, client, work } = await desk(t)
    const refuser = new SeatFake({ id: 'refuser', capabilities: { archiveHistory } })
    refuser.deleteRefusal = 'The thread is locked by another writer.'
    harness.host.register(refuser)
    await refuser.start()
    await writeReviewer(harness.stateDir, 'refuser=small/high')

    await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          `  refuser=small/high — refuser runs it at medium effort, not high (the conversation it opened could not be deleted: “The thread is locked by another writer”; ${where})`,
      )
      return true
    })
    const [opened] = refuser.opened
    assert.ok(opened)
    assert.deepEqual(refuser.deleted, [])
    // Out of the list: in the runtime's own archive when it keeps one, the desk's when it does not — never both.
    assert.deepEqual([...refuser.archived], archiveHistory ? [String(opened.id)] : [])
    assert.deepEqual(await archivedOn(harness.stateDir), archiveHistory ? [] : [['refuser', String(opened.id)]])
    // And explained, if it is ever listed.
    assert.equal(await nameOn(harness.stateDir, 'refuser', opened.id), 'Reviewer')
    assert.equal(harness.host.registry.get(runtimeId('refuser'), opened.id), undefined)
    await client.until(() => removedFor(client, opened.id) === 1, 2_000, 'session/removed for it')
  })
}

test("through the host: a runtime that cannot delete but keeps an archive has it put there, not in the desk's", async (t) => {
  const { harness, client, work } = await desk(t)
  const keeper = new SeatFake({ id: 'keeper', capabilities: { deleteHistory: false, archiveHistory: true } })
  harness.host.register(keeper)
  await keeper.start()
  await writeReviewer(harness.stateDir, 'keeper=small/high')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        "  keeper=small/high — keeper runs it at medium effort, not high (the conversation it opened may stay in keeper's own history, which the desk cannot delete from; it is in keeper's own archive)",
    )
    return true
  })
  const [opened] = keeper.opened
  assert.ok(opened)
  assert.deepEqual([...keeper.archived], [String(opened.id)])
  assert.deepEqual(await archivedOn(harness.stateDir), [], 'nothing written down here for a runtime with its own')
  assert.deepEqual(keeper.deleted, [])
})

test('through the host: when archiving fails as well, the line says so rather than claiming it is archived', async (t) => {
  const { harness, client, work, heard } = await desk(t)
  const keeper = new SeatFake({ id: 'keeper', capabilities: { deleteHistory: false, archiveHistory: false } })
  harness.host.register(keeper)
  await keeper.start()
  await writeReviewer(harness.stateDir, 'keeper=small/high')
  // The desk's archive cannot be written: a directory stands where its file goes.
  await mkdir(join(harness.stateDir, 'archive.json'))

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        "  keeper=small/high — keeper runs it at medium effort, not high (the conversation it opened may stay in keeper's own history, which the desk cannot delete from; archiving it failed, so it may still be listed)",
    )
    return true
  })
  assert.ok(heard.said.includes('a seat passed over could not be archived'))
})

test('through the host: a seat lost part-way through opening says what it was left as, too', async (t) => {
  const { harness, client, work } = await desk(t)
  const keeper = new SeatFake({ id: 'keeper', capabilities: { deleteHistory: false, archiveHistory: false } })
  keeper.breakNext = true
  harness.host.register(keeper)
  await keeper.start()
  await writeReviewer(harness.stateDir, 'keeper=big/high')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        "  keeper=big/high — keeper could not open a conversation: Seat Fake lost this conversation part-way through opening it (the conversation it opened may stay in keeper's own history, which the desk cannot delete from; it is archived here)",
    )
    return true
  })
  const [lost] = keeper.opened
  assert.ok(lost)
  assert.deepEqual(await archivedOn(harness.stateDir), [['keeper', String(lost.id)]])
})

test('through the host: a runtime gone before its seat could be deleted is said to be, not taken for one that left nothing', async (t) => {
  const { harness, seats, client, seating, candidate, naming } = await heldAtNaming(t)
  // Taken off the desk while its seat is being opened.
  await harness.host.unregister(runtimeId('seatfake'))
  naming.open()

  await assert.rejects(
    seating,
    refusedLeaving(
      'seatfake was gone before it could be asked to delete the conversation it opened, which may stay in its history',
    ),
  )
  assert.deepEqual(seats.deleted, [], 'nothing could be asked of it')
  // Nothing can open it from here, so the row goes — but its name stays, for if the runtime comes back.
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), candidate.id), undefined)
  await client.until(() => removedFor(client, candidate.id) === 1, 2_000, 'session/removed for it')
  assert.equal(await nameOn(harness.stateDir, 'seatfake', candidate.id), 'Reviewer')
})

test('through the host: a name file that will not write neither keeps a passed-over seat on screen nor ends the seating', async (t) => {
  const { harness, seats, client, work, heard } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high, seatfake=big/high')
  const names = join(harness.stateDir, 'names.json')
  const closing = gate()
  seats.stops.close = closing
  const seating = client.call('agent/seat', { id: 'reviewer', cwd: work })
  await closing.reached
  // The first candidate is passed over and named already; its name file now cannot be written.
  rmSync(names, { force: true })
  mkdirSync(names)
  // Put right before the next candidate is named, so only the forgetting meets it.
  seats.beforeCreate = () => rmSync(names, { recursive: true, force: true })
  closing.open()

  const session = (await seating) as Session
  const [passed, kept] = seats.opened
  assert.ok(passed && kept && seats.opened.length === 2)
  assert.equal(String(session.id), String(kept.id), 'the seating went on to the next candidate')
  assert.deepEqual(seats.deleted, [String(passed.id)])
  assert.equal(harness.host.registry.get(runtimeId('seatfake'), passed.id), undefined)
  await client.until(() => removedFor(client, passed.id) === 1, 2_000, 'session/removed for the seat passed over')
  assert.ok(heard.said.includes('a seat passed over could not be forgotten everywhere'))
})

/*
 * The dry run: which seat would win here and why not the ones above it —
 * the reads a seating makes, and nothing it opens.
 */

test('the dry run says which seat would win here and why not the ones above it, and opens nothing', async () => {
  const seen = await rig('cursor=gemini-3.8-flash/high, claude=opus-5/high, codex/high', {
    cursor: { name: 'Cursor', models: ['gemini-3.8-flash'], signedOut: true },
    claude: {
      name: 'Claude',
      catalogue: [
        { id: 'opus-5', displayName: 'Opus 5', reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: true },
      ],
    },
  })
  const plans = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.deepEqual(plans, [
    {
      id: 'reviewer',
      from: 'prefer',
      winner: 1,
      blocked: null,
      candidates: [
        {
          seat: { runtime: 'cursor', model: 'gemini-3.8-flash', effort: 'high' },
          label: 'Cursor · gemini-3.8-flash · High',
          runtimeName: 'Cursor',
          state: 'passed',
          reason: { kind: 'signedOut' },
          fix: { kind: 'signIn', runtime: 'cursor' },
        },
        {
          seat: { runtime: 'claude', model: 'opus-5', effort: 'high' },
          label: 'Claude · Opus 5 · High',
          runtimeName: 'Claude',
          state: 'taken',
          reason: null,
          fix: null,
        },
        {
          // Nothing by this id is added and the desk knows no name for it, so its id is the last word left.
          seat: { runtime: 'codex', effort: 'high' },
          label: 'codex · High',
          runtimeName: 'codex',
          state: 'untried',
          reason: null,
          fix: null,
        },
      ],
    },
  ])
  untouched(seen)
})

test('no ids is every Agent in force; one that cannot be weighed says why; one nobody defined is named', async () => {
  const seen = await rig('claude=opus-5', { claude: { name: 'Claude', models: ['opus-5'] } })
  const brokenFile = join(seen.root, 'user', 'broken', 'AGENT.md')
  await mkdir(join(seen.root, 'user', 'broken'), { recursive: true })
  await writeFile(brokenFile, '---\npermission: admin\n---\nx\n', 'utf8')

  const plans = await agentMethods['agent/seat/dry'](seen.ctx, {})
  assert.deepEqual(
    plans.map((one) => [one.id, one.winner, one.blocked]),
    [
      ['broken', null, `${brokenFile} cannot be used: permission — "admin" is not a permission — it is read, publish or merge`],
      ['reviewer', 0, null],
    ],
  )
  assert.deepEqual(await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['ghost'] }), [
    { id: 'ghost', from: 'prefer', candidates: [], winner: null, blocked: 'No Agent called “ghost”.' },
  ])
  untouched(seen)
})

test('through the host: a dry run opens nothing, and says each seat in the words the desk uses', async (t) => {
  const { harness, seats, client } = await desk(t)
  await writeReviewer(harness.stateDir, 'ghost=m1, seatfake=big/high')
  const plans = (await client.call('agent/seat/dry', { ids: ['reviewer'] })) as SeatPlan[]
  assert.equal(seats.opened.length, 0, 'nothing was opened')
  assert.deepEqual(
    plans[0]?.candidates.map((one) => [one.label, one.state, one.fix?.kind ?? null]),
    [
      // No `AgentDirectory` is wired into this harness and `ghost` is not a
      // known agent either, so nothing here could add it — the same "not a
      // runtime on this desk, nor one it knows how to add" a seating itself
      // would say, fixed by editing the seats rather than by *Add*.
      ['ghost · m1', 'passed', 'seats'],
      ['Seat Fake · Big · High', 'taken', null],
    ],
  )
})

/*
 * A runtime this desk has not added is named by what it can still find of it:
 * the desk's own name for a runtime it has added and knows; failing that, the
 * name the public registry gave it in the document it last fetched; and only
 * once neither names it, its bare id.
 */

test('a runtime this desk has not added, and does not know, is named as the public registry names it — its id only when nothing does', async () => {
  const stateDir = tempDir('hd-agent-seat-registry-name-')
  const agents = [
    { id: 'listed', name: 'Listed Agent', version: '1.0.0', distribution: { npx: { package: 'listed@1.0.0' } } },
  ]
  // Fetched once while the network was there, and cached — exactly as listing
  // the registry in Settings › Runtimes fetches and caches it.
  await new AcpRegistry({ stateDir, fetchJson: async () => ({ agents }), which: () => null }).catalog(() => false)
  const registry = new AcpRegistry({
    stateDir,
    freshMs: 0,
    fetchJson: async () => {
      throw new Error('the network is not there')
    },
    which: () => null,
  })
  const directory = new AgentDirectory({
    store: new AgentRegistryStore(join(stateDir, 'agents.json')),
    build: () => {
      throw new Error('nothing is added in these tests')
    },
    usageFor: () => null,
    registry,
  })
  const seen = await rig('listed=m1, praxis=m1', {}, { directory })
  const plans = await agentMethods['agent/seat/dry'](seen.ctx, { ids: ['reviewer'] })
  assert.deepEqual(
    plans[0]?.candidates.map((one) => [one.seat.runtime, one.runtimeName]),
    [
      ['listed', 'Listed Agent'],
      ['praxis', 'praxis'],
    ],
  )
})
