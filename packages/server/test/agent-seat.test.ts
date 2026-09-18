import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

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
import type { OpenedSeat } from '../src/host.js'
import { Logger } from '../src/log.js'
import { agentMethods } from '../src/methods/agents.js'
import type { SeatedAs } from '../src/registry.js'
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
  readonly opened: SeatSession[] = []

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
    return session
  }
}

type SeatValues = { model: string; effort: string; thinking: boolean; fast: boolean; 'max-mode': boolean }

class SeatSession implements AgentSession {
  readonly runtime = runtimeId('seatfake')
  /** Every message it was sent, as text. */
  readonly sent: string[] = []
  closed = false
  title: string | null = null
  #values: SeatValues
  #turns = 0

  constructor(
    private readonly owner: SeatFake,
    readonly id: SessionId,
    private readonly cwd: string,
    values: SeatValues,
  ) {
    this.#values = SeatSession.#fit(values)
  }

  /** What `small` cannot do is off, whatever was asked of it. */
  static #fit(values: SeatValues): SeatValues {
    return values.model === 'small' ? { ...values, effort: 'medium', thinking: false, fast: false } : values
  }

  values(): SeatValues {
    return this.#values
  }

  settings(): SessionSettings {
    return { cwd: this.cwd, model: this.#values.model }
  }

  options(): readonly ConfigOption[] {
    const small = this.#values.model === 'small'
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
        ...(small ? { disabled: 'Small has no thinking mode.' } : {}),
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
    this.#values = SeatSession.#fit({ ...this.#values, [id]: value })
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

// ------------------------------------------------------ the method, by itself

/** An Agent file as a person writes one, with the candidates it prefers. */
const agentFile = (prefer: string): string =>
  `---\nname: Reviewer\npermission: read\nprefer: [${prefer}]\n---\nRead the diff.\n`

/** What one runtime on the pretend desk says about itself. Honest and ready unless a test says otherwise. */
interface Pretend {
  readonly models?: readonly string[]
  /** The model list will not load. */
  readonly modelsFail?: boolean
  readonly health?: RuntimeHealth
  /** Signed in to nothing. */
  readonly signedOut?: boolean
  /** The account would not answer. */
  readonly accountFails?: boolean
  /** Keeps its own credential, so the desk never asks it to sign in. */
  readonly keepsOwnAccount?: boolean
}

const pretendRuntime = (id: string, pretend: Pretend) => ({
  info: { id: runtimeId(id), capabilities: { account: pretend.keepsOwnAccount !== true } },
  health: (): RuntimeHealth => pretend.health ?? { state: 'ready' },
  getAccount: async () => {
    if (pretend.accountFails) throw new Error('the account endpoint timed out')
    return { accounts: pretend.signedOut ? [] : [{ kind: 'apiKey', label: 'key' }], signInMethods: [] }
  },
  listModels: async () => {
    if (pretend.modelsFail) throw new Error('the catalogue did not load')
    return (pretend.models ?? []).map((one) => ({
      id: one,
      displayName: one,
      reasoningLevels: [],
      supportsImages: false,
    }))
  },
})

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
    readonly openFails?: string
    readonly orderFails?: string
  } = {},
) => {
  const root = tempDir('hd-agent-seat-')
  const user = join(root, 'user')
  const source = agentFile(prefer)
  await mkdir(join(user, 'reviewer'), { recursive: true })
  await writeFile(join(user, 'reviewer', 'AGENT.md'), source, 'utf8')
  const roster = new Agents({ user, builtin: join(root, 'builtin') })

  const created: { runtime: string; model?: string; cwd: string }[] = []
  const titles: string[] = []
  const ordered: string[] = []
  const retired: string[] = []
  const recorded: SeatedAs[] = []
  const asked: (string | undefined)[] = []
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
        if (options.openFails) throw new Error(options.openFails)
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
  return { ctx, source, created, titles, ordered, retired, recorded, asked, root }
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

test('the brief is handed over as the standing order, once', async () => {
  const { ctx, ordered } = await rig('claude=opus-5/high')
  await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.equal(ordered.length, 1)
  assert.match(ordered[0] ?? '', /Read the diff\./)
  assert.equal(ordered[0], 'Read the diff.', 'the brief, and nothing added to it')
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

test('an effort nothing can list before seating is let through, and the seat is kept when it runs at it', async () => {
  // No runtime lists its efforts before a session exists. Taken for "offers
  // none", every candidate that names an effort would be refused.
  const { ctx, created, ordered } = await rig('claude=opus-5/xhigh')
  const session = await agentMethods['agent/seat'](ctx, { id: 'reviewer', cwd: '/tmp/x' })
  assert.deepEqual(created, [{ runtime: 'claude', model: 'opus-5', cwd: '/tmp/x' }])
  assert.equal(ordered.length, 1)
  assert.equal(session.settings?.agent, 'reviewer')
})

test('a seat that comes back on another effort is closed and refused, and never handed the brief', async () => {
  const seen = await rig('claude=opus-5/high', undefined, { comesBackAs: () => ({ effort: 'medium' }) })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  claude=opus-5/high — claude opened at medium effort, not high — so it was closed',
      )
      return true
    },
  )
  assert.equal(seen.created.length, 1, 'it was opened, which is how the difference was found')
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.ordered, [])
  assert.deepEqual(seen.recorded, [])
})

test('a +thinking seat that comes back without thinking is closed and refused, in the runtime\'s words', async () => {
  const seen = await rig('claude=opus-5/high+thinking', undefined, {
    comesBackAs: () => ({ thinking: false, thinkingFixed: 'Opus 5 has no thinking mode here.' }),
  })
  await assert.rejects(
    () => agentMethods['agent/seat'](seen.ctx, { id: 'reviewer', cwd: '/tmp/x' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'No seat could be opened for this Agent:\n' +
          '  claude=opus-5/high+thinking — claude opened without thinking, which was asked for (Opus 5 has no thinking mode here) — so it was closed',
      )
      return true
    },
  )
  assert.deepEqual(seen.retired, ['claude s1'])
  assert.deepEqual(seen.ordered, [])
  assert.deepEqual(seen.recorded, [])
})

test('a seat that comes back on another model is closed and refused, the candidates above it named too', async () => {
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
          '  claude=opus-5/high — claude opened on model sonnet-5, not opus-5 — so it was closed',
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
  const seen = await rig('claude=opus-5/high', undefined, { openFails: 'The agent is not running.' })
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

  const opened = seats.opened[0]
  assert.ok(opened)
  assert.equal(String(opened.id), String(session.id))
  assert.deepEqual(opened.sent, ['Read the diff.'], 'the brief, once')
  // The same seating a flow's seat gets: the picks in, the inherited switches off.
  assert.deepEqual(opened.values(), { model: 'big', effort: 'high', thinking: false, fast: false, 'max-mode': false })
  assert.equal(opened.title, 'Reviewer')
  assert.equal(opened.closed, false)
  assert.equal(settingsSeen(client, String(session.id))?.agent, 'reviewer', 'every window is told')

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
  const held = harness.host.registry.get(runtimeId('seatfake'), session.id)?.session.settings
  assert.equal(held?.model, 'small')
  assert.equal(held?.agent, 'reviewer')
  assert.equal(held?.briefDigest, digestOf(source))
})

test('through the host: a seat the runtime opens on something else is closed, refused, and never handed the brief', async (t) => {
  const { harness, seats, client, work } = await desk(t)
  await writeReviewer(harness.stateDir, 'seatfake=small/high+thinking')

  await assert.rejects(client.call('agent/seat', { id: 'reviewer', cwd: work }), (error: Error) => {
    assert.equal(
      error.message,
      'No seat could be opened for this Agent:\n' +
        '  seatfake=small/high+thinking — seatfake opened at medium effort, not high, and without thinking, which was asked for (Small has no thinking mode) — so it was closed',
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
    options: { cwd: '/w', agent: 'forged', briefDigest: 'forged' },
  })) as Session
  assert.equal(session.settings?.agent, undefined)
  // The plain fake echoes a patch back into its settings, the way a runtime might.
  await client.call('session/settings', {
    runtime: FAKE_RUNTIME_ID,
    sessionId: session.id,
    patch: { agent: 'forged', briefDigest: 'forged' },
  })
  await client.until(() => settingsSeen(client, String(session.id)) !== undefined, 5_000, 'the echoed settings')
  assert.equal(settingsSeen(client, String(session.id))?.agent, undefined)
  assert.equal(settingsSeen(client, String(session.id))?.briefDigest, undefined)
  assert.equal(harness.host.registry.get(FAKE_RUNTIME_ID, session.id)?.session.settings?.agent, undefined)
})
