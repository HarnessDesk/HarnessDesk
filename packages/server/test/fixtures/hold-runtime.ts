import {
  runtimeId,
  sessionId,
  type AgentSession,
  type ConfigOption,
  type OptionValue,
  type RuntimeId,
  type RuntimeInfo,
  type Session,
  type SessionOptions,
  type SessionSettings,
} from '@harnessdesk/protocol'

import { FakeRuntime, FakeSession } from './fake-runtime.js'

export type SandboxHabit = 'takes' | 'settlesElsewhere' | 'refuses'

const SANDBOX_LABELS: Readonly<Record<string, string>> = { 'read-only': 'Read only', workspace: 'Workspace', full: 'Full access' }

export const HOLD_CEILINGS = {
  read: { settings: [{ option: 'sandbox', value: 'read-only' }], how: 'Read-only sandbox' },
  edit: { settings: [{ option: 'sandbox', value: 'workspace' }], how: 'Workspace sandbox' },
} as const satisfies RuntimeInfo['ceilings']

export class HoldSession extends FakeSession {
  sandbox = 'full'

  constructor(
    host: HoldFake,
    id: AgentSession['id'],
    settings: SessionSettings,
    values: Record<string, OptionValue>,
    private readonly fake: HoldFake,
  ) {
    super(host, id, settings, values)
  }

  override get runtime(): RuntimeId {
    return this.fake.info.id
  }

  override snapshot(): Session {
    return { ...super.snapshot(), runtime: this.fake.info.id, options: this.options() }
  }

  override options(): readonly ConfigOption[] {
    return [
      ...super.options(),
      {
        type: 'select',
        id: 'sandbox',
        category: '_permissions',
        label: 'Sandbox',
        currentValue: this.sandbox,
        choices: Object.entries(SANDBOX_LABELS).map(([value, label]) => ({ value, label })),
      },
    ]
  }

  override async setOption(id: string, value: OptionValue): Promise<void> {
    if (id !== 'sandbox') return super.setOption(id, value)
    if (this.fake.habit === 'refuses') throw new Error('a managed configuration forbids it')
    this.sandbox = this.fake.habit === 'settlesElsewhere' ? 'full' : String(value)
  }
}

export class HoldFake extends FakeRuntime {
  habit: SandboxHabit = 'takes'
  readonly held: HoldSession[] = []

  constructor(id = 'holdfake') {
    super({ id: runtimeId(id), name: 'Hold Fake' })
    const info = this.info
    ;(this as { info: RuntimeInfo }).info = {
      ...info,
      presentation: { ...info.presentation, name: 'Hold Fake' },
      ceilings: HOLD_CEILINGS,
    }
  }

  #opened = 0

  override async createSession(options: SessionOptions): Promise<AgentSession> {
    this.#opened += 1
    const id = sessionId(`hold-session-${this.#opened}`)
    const model = options.model ?? 'fake-1'
    const session = new HoldSession(this, id, { cwd: options.cwd, model }, { model, tone: 'plain', uppercase: false }, this)
    this.sessions.set(String(id), session)
    this.minted.set(String(id), options.cwd)
    this.held.push(session)
    this.emit({ type: 'session/started', session: session.snapshot() })
    return session
  }
}
