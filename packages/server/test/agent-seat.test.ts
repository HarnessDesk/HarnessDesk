import assert from 'node:assert/strict'
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
  type CommandApproval,
  type ConfigOption,
  type FlowPermission,
  type FlowRun,
  type FlowSeat,
  type ModelInfo,
  type OptionValue,
  type RuntimeHealth,
  type RuntimeInfo,
  type Session,
  type SessionId,
  type SessionOptions,
  type SessionSettings,
  type TeamState,
  type TurnId,
  type UsageReport,
  type UserContent,
} from '@harnessdesk/protocol'

import type { SeatRunning } from '../src/agent-seating.js'
import { Agents } from '../src/agents.js'
import { GIT_RULES, renderFlowTemplate } from '../src/flow.js'
import { Host, type OpenedSeat } from '../src/host.js'
import { Logger } from '../src/log.js'
import { agentMethods } from '../src/methods/agents.js'
import type { SeatedAs } from '../src/registry.js'
import { StateStore } from '../src/state.js'
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

  constructor() {
    super({ id: runtimeId('seatfake'), name: 'Seat Fake' })
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
    const id = sessionId(`seat-${this.opened.length + 1}`)
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
}

type SeatValues = { model: string; effort: string; thinking: boolean; fast: boolean; 'max-mode': boolean }

class SeatSession implements AgentSession {
  readonly runtime = runtimeId('seatfake')
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
    this.title = title
    this.owner.emit({ type: 'session/title', sessionId: this.id, title })
  }
  async close(): Promise<void> {
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
  /** Signed in to nothing. */
  readonly signedOut?: boolean
  /** The account would not answer. */
  readonly accountFails?: boolean
  /** Keeps its own credential, so the desk never asks it to sign in. */
  readonly keepsOwnAccount?: boolean
}

const pretendRuntime = (id: string, pretend: Pretend) => {
  const catalogue = (pretend.models ?? []).map((one) => ({
    id: one,
    displayName: one,
    reasoningLevels: [],
    supportsImages: false,
  }))
  return {
    info: { id: runtimeId(id), capabilities: { account: pretend.keepsOwnAccount !== true } },
    health: (): RuntimeHealth => pretend.health ?? { state: 'ready' },
    getAccount: async () => {
      if (pretend.accountFails) throw new Error('the account endpoint timed out')
      return { accounts: pretend.signedOut ? [] : [{ kind: 'apiKey', label: 'key' }], signInMethods: [] }
    },
    listModels: async () => {
      if (pretend.modelsFail) throw new Error('the catalogue did not load')
      return pretend.modelsUnknown ? [] : catalogue
    },
    ...(pretend.modelsUnknown !== undefined
      ? { knownModels: async () => (pretend.modelsUnknown ? null : catalogue) }
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
  } = {},
) => {
  const root = tempDir('hd-agent-seat-')
  const user = join(root, 'user')
  const source = agentFile(prefer, options.permission)
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(join(user, 'reviewer', 'AGENT.md'), source, 'utf8')
  const roster = new Agents({ user, builtin: join(root, 'builtin') })

  const created: { runtime: string; model?: string; cwd: string }[] = []
  const titles: string[] = []
  const ordered: string[] = []
  const retired: string[] = []
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
    },
    usage: () => ({ reports: async () => options.reports ?? [] }),
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
  return { ctx, source, created, titles, ordered, retired, recorded, asked, root, overlaps, alive: () => alive }
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
    'ghost=m, gone=m, old=m, starting=m, mute=m, out=m, spent=m',
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
          '  ghost=m — ghost is not installed',
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

test("another sign-in's figures do not spend the runtime, however spent they are", async () => {
  // Antigravity's quota, read through the separately signed-in `agy` CLI
  // (#769): the host files it under `unverified`, and this check reads the
  // runtime's own lanes, which are empty. Every group spent, still seated.
  const borrowed: UsageReport = {
    ...reportFor('claude', []),
    unverified: {
      whose: 'agy CLI sign-in',
      lanes: [
        { id: 'gemini-weekly', label: 'Weekly', scope: 'Gemini Models', usedPercent: 100, windowMinutes: 10_080, resetsAt: null },
        { id: '3p-weekly', label: 'Weekly', scope: 'Claude and GPT models', usedPercent: 100, windowMinutes: 10_080, resetsAt: null },
        // Even scoped to the very model asked for, another sign-in's lane decides nothing.
        { id: 'opus-weekly', label: 'Weekly', scope: 'opus-5', usedPercent: 100, windowMinutes: 10_080, resetsAt: null },
      ],
      reached: 'gemini-weekly',
      fetchedAt: 0,
      staleAfterMs: 60_000,
    },
  }
  const { ctx, created } = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, { reports: [borrowed] })
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
})

test('a runtime that reports only model groups is spent only when every group is', async () => {
  // The shape Antigravity and Gemini CLI report: no account-wide window, one
  // per group of models. A spent group is a model to switch away from.
  const groups = (gemini: number, others: number) =>
    reportFor('claude', [
      { usedPercent: gemini, scope: 'Gemini Models' },
      { usedPercent: others, scope: 'Claude and GPT models' },
    ])
  const oneSpent = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, { reports: [groups(100, 0)] })
  await agentMethods['agent/seat'](oneSpent.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(oneSpent.created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])

  const allSpent = await rig('claude=opus-5/high', { claude: { models: ['opus-5'] } }, { reports: [groups(100, 100)] })
  await assert.rejects(
    () => agentMethods['agent/seat'](allSpent.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /claude's window is spent/,
  )
  assert.deepEqual(allSpent.created, [])
})

test("a candidate whose model's own window is spent is passed over for one whose model has room", async () => {
  // Lanes scoped by model id, the way Gemini CLI reports them, read from the
  // report the desk already holds (#769).
  const perModel = reportFor('claude', [
    { usedPercent: 100, scope: 'opus-5' },
    { usedPercent: 10, scope: 'sonnet-5' },
  ])
  const desk = { claude: { models: ['opus-5', 'sonnet-5'] } }
  const both = await rig('claude=opus-5/high, claude=sonnet-5/high', desk, { reports: [perModel] })
  await agentMethods['agent/seat'](both.ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(both.created, [{ runtime: 'claude', model: 'sonnet-5', cwd: '/tmp/x' }])

  const onlySpent = await rig('claude=opus-5/high', desk, { reports: [perModel] })
  await assert.rejects(
    () => agentMethods['agent/seat'](onlySpent.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    /claude's window for opus-5 is spent/,
  )
  assert.deepEqual(onlySpent.created, [])
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
  // Every seat that opens and is passed over leaves an empty conversation behind, so the list is capped.
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
})

test('through the host: when every candidate fails the refusal names each, and no conversation is left open', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'ghost=m1, seatfake=small/high, seatfake=small/medium+thinking')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      [
        'No seat could be opened for this Agent:',
        '  ghost=m1 — ghost is not installed',
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

    await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
      assert.equal(
        error.message,
        [
          'No seat could be opened for this Agent:',
          // High has no thinking variant: asked for, thinking is settled off.
          '  variant=fam/high+thinking — variant runs it without thinking, which was asked for',
          // Medium comes with thinking, and turning it off is declined.
          '  variant=fam/medium — variant runs it with thinking on, which was not asked for and would not turn off',
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

test("over ACP: the brief opens as a notice, not a turn the person is shown as having typed", async (t) => {
  const { harness, client, work } = await acpDesk(t, 'variant-acp-agent.mjs', 'variant', {})
  await writeReviewer(harness.stateDir, 'variant=fam/medium+thinking')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const read = (await client.call('session/read', {
    runtime: session.runtime,
    sessionId: session.id,
  })) as Session
  const items = read.turns.flatMap((turn) => turn.items)
  // The brief opened the conversation, but not as the person's own words —
  // titleOf and the sidebar read only `userMessage`, and would otherwise
  // pick the brief's own text (including its git rules) as the title.
  assert.deepEqual(
    items.filter((item) => item.type === 'userMessage'),
    [],
    'the brief is never recorded as something a person typed',
  )
  const notice = items.find((item) => item.type === 'notice')
  assert.ok(notice, 'the brief is still recorded, just not as speech')
  assert.match((notice as { text: string }).text, /^Read the diff\.\n\n/, 'the brief as written, first')
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
  return { harness, client, work, runtime }
}

/** A Codex desk exercised through Host.call, with no loopback server in front of it. */
const directCodexDesk = async (t: TestContext, env: Record<string, string>) => {
  const stateDir = tempDir('hd-agent-seat-state-')
  const host = new Host({
    logger: new Heard(),
    state: new StateStore(join(stateDir, 'state.json')),
    version: '9.9.9',
    pickDirectory: async () => stateDir,
  })
  const runtime = new CodexRuntime({ binaryPath: CODEX_FAKE, clientName: 'harnessdesk-test', env })
  host.register(runtime)
  await host.start()
  t.after(() => host.dispose())
  const work = tempDir('hd-agent-seat-work-')
  await host.call('workspace/open', { path: work })
  return { host, runtime, stateDir, work }
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

test('over Codex: the brief opens as a notice too — Codex echoes it back as `userMessage` on its own wire, and the session still does not read it as one', async (t) => {
  const { harness, client, work } = await codexDesk(t, {})
  await writeReviewer(harness.stateDir, 'codex=gpt-5.5/high')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const read = (await client.call('session/read', {
    runtime: session.runtime,
    sessionId: session.id,
  })) as Session
  const items = read.turns.flatMap((turn) => turn.items)
  assert.deepEqual(
    items.filter((item) => item.type === 'userMessage'),
    [],
    'the brief is never recorded as something a person typed, even once Codex echoes it back',
  )
  const notice = items.find((item) => item.type === 'notice')
  assert.ok(notice, 'the brief is still recorded, just not as speech')
  assert.match((notice as { text: string }).text, /^Read the diff\.\n\n/, 'the brief as written, first')
})

test('over Codex: a coalesced turn/start answer and opening echo still record the brief as a notice', async (t) => {
  const { harness, client, work } = await codexDesk(t, { FAKE_CODEX_TURN_START_ORDER: 'one-chunk' })
  await writeReviewer(harness.stateDir, 'codex=gpt-5.5/high')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const read = (await client.call('session/read', {
    runtime: session.runtime,
    sessionId: session.id,
  })) as Session
  const items = read.turns.flatMap((turn) => turn.items)
  assert.deepEqual(
    items.filter((item) => item.type === 'userMessage'),
    [],
    'the synchronous opening echo cannot overtake the silent-turn marker',
  )
  const notice = items.find((item) => item.type === 'notice')
  assert.ok(notice, 'the coalesced echo is still recorded as a notice')
  assert.match((notice as { text: string }).text, /^Read the diff\.\n\n/, 'the brief as written, first')
})

test('over Codex: a fuller completion and a cold read cannot turn the recorded brief back into speech', async (t) => {
  const { host, stateDir, work } = await directCodexDesk(t, {
    FAKE_CODEX_FULLER_COMPLETION: '1',
    FAKE_CODEX_PERSIST_TURN: '1',
  })
  await writeReviewer(stateDir, 'codex=gpt-5.5/high')

  const session = (await host.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  const record = host.registry.get(runtimeId('codex'), session.id)
  const approvalDeadline = Date.now() + 5_000
  while (record?.approvals.size === 0 && Date.now() < approvalDeadline) {
    await new Promise((wake) => setTimeout(wake, 10))
  }
  const approval = [...(record?.approvals.values() ?? [])].find(
    (entry): entry is CommandApproval => entry.type === 'command',
  )
  assert.ok(approval, 'the silent order asks for its command approval')
  await host.call('approval/respond', {
    runtime: session.runtime,
    sessionId: session.id,
    approvalId: approval.id,
    decision: {
      type: 'option',
      optionId: approval.options.find((option) => option.intent === 'approve')!.id,
    },
  })
  const completionDeadline = Date.now() + 5_000
  while (record?.running.size !== 0 && Date.now() < completionDeadline) {
    await new Promise((wake) => setTimeout(wake, 10))
  }
  assert.equal(record?.session.turns[0]?.status, 'completed', 'the fuller completion reached the host')

  const transcript = join(stateDir, 'transcripts', 'codex', `${encodeURIComponent(session.id)}.json`)
  const transcriptDeadline = Date.now() + 5_000
  while (Date.now() < transcriptDeadline) {
    if (await readFile(transcript, 'utf8').then(() => true, () => false)) break
    await new Promise((wake) => setTimeout(wake, 10))
  }
  await host.call('session/close', { runtime: session.runtime, sessionId: session.id })
  host.registry.delete(runtimeId('codex'), session.id)

  const reread = (await host.call('session/read', {
    runtime: session.runtime,
    sessionId: session.id,
  })) as Session
  const items = reread.turns.flatMap((turn) => turn.items)
  assert.deepEqual(
    items.filter((item) => item.type === 'userMessage'),
    [],
    'the persisted Codex opening is still not something a person typed',
  )
  assert.equal(items[0]?.type, 'notice', 'the host-restored classification survives without a live Codex session')
})

test('over Codex: the normal turn after a silent order is speech and supplies the opening preview', async (t) => {
  const { harness, client, work, runtime } = await codexDesk(t, { FAKE_CODEX_TURN_START_ORDER: 'one-chunk' })
  await writeReviewer(harness.stateDir, 'codex=gpt-5.5/high')

  const session = (await client.call('agent/seat', { id: 'reviewer', cwd: work })) as Session
  await client.until(
    () =>
      client.events.some(
        (event) =>
          event.type === 'approval/requested' &&
          event.approval.sessionId === session.id &&
          event.approval.type === 'command',
      ),
    5_000,
    'the silent order approval',
  )
  const approval = client.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval/requested' }> & { approval: CommandApproval } =>
      event.type === 'approval/requested' &&
      event.approval.sessionId === session.id &&
      event.approval.type === 'command',
  )!
  await client.call('approval/respond', {
    runtime: session.runtime,
    sessionId: session.id,
    approvalId: approval.approval.id,
    decision: {
      type: 'option',
      optionId: approval.approval.options.find((option) => option.intent === 'approve')!.id,
    },
  })
  await client.until(
    () => client.events.some((event) => event.type === 'turn/completed' && event.sessionId === session.id),
    5_000,
    'the silent order to finish',
  )
  const request = 'Continue with the person\'s request.'
  await client.call('turn/send', {
    runtime: session.runtime,
    sessionId: session.id,
    input: [
      { type: 'text', text: '<context source="Git">\nStatus: ## main\n</context>' },
      { type: 'text', text: request },
    ],
  })

  const read = (await client.call('session/read', {
    runtime: session.runtime,
    sessionId: session.id,
  })) as Session
  const spoken = read.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === 'userMessage')
  assert.equal(spoken.length, 1, 'only the person\'s follow-up is speech')
  const spokenText = spoken.flatMap((item) =>
    item.type === 'userMessage' ? item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])) : [],
  )
  assert.ok(spokenText.includes(request), 'the normal message is recorded in the person\'s voice')
  const summary = (await runtime.listSessions()).data.find((row) => row.id === session.id)
  assert.equal(summary?.preview, request, 'the normal turn supplies the live session opening')
  // `agent/seat` names the conversation before handing over its silent order,
  // so this seated session cannot be renamed by a later opening message.
})
