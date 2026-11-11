import type { AgentsEngine, AgentsScope, AskAnswer, AskInput } from '@harnessdesk/cordis-host'
import { FLOW_ASK_LIMITS, type FlowAsk, type FlowSeat, type RuntimeInfo, type SeatRecord, type Turn } from '@harnessdesk/protocol'

/**
 * `ask_agent`'s engine: one read-only question from a Flow seat to another
 * agent, answered once.
 *
 * The desk opens a hidden, ephemeral conversation on the agent asked, in the
 * caller's checkout, held at the read ceiling; sends the question; waits for
 * that one turn; and discards the conversation. It is a consult, not a
 * delegation: the agent asked cannot edit, cannot ask anyone else, and leaves
 * nothing behind but the answer in the caller's transcript.
 *
 * Every refusal is an `Error` with a `wireCode`, in words the asking agent
 * can act on. The steps run in the order the design gives them: who is
 * calling, depth, the Flow's gate, money, sizes, then the open — so a refusal
 * never costs a conversation.
 *
 * Host-private seat functions reach this through `ConsultPort`, a port of
 * closures the host builds, as the seats port is: the plane holds the rules
 * and the order, the host holds the conversations.
 */

/** The most a question or its context may be, in UTF-8 bytes. The tool schema caps characters; this caps bytes. */
export const ASK_INPUT_BYTES = 16 * 1024
/** The most an answer is handed back, in UTF-8 bytes; longer is cut and marked. */
export const ASK_ANSWER_BYTES = 32 * 1024
export const ASK_TRUNCATED_MARK = '\n\n[answer truncated at 32 KiB]'

/** The most one cleanup step — a meter's last read, the link, the discard — may take once an ask has ended. */
export const CONSULT_CLEANUP_MS = 10_000

export const CONSULT_PROMPT =
  'You are being consulted by another agent. Answer the question below. You may read files in this checkout; you cannot change anything or ask anyone else. Reply with your answer only.'

export type AskRefusal =
  | 'askNoCaller' | 'askDepth' | 'askNotAllowed' | 'askSpent' | 'askBudget' | 'askTooLarge'
  | 'askUnavailable' | 'askNoReadCeiling' | 'askTimeout' | 'askCancelled' | 'askFailed'

const refused = (wireCode: AskRefusal, message: string): Error => Object.assign(new Error(message), { wireCode })

/** The Flow seat a conversation holds, as the run reads it. */
export interface AskingSeat {
  readonly run: string
  readonly goal: string
  readonly seat: string
  readonly ask: FlowAsk | null
  readonly trigger: boolean
  readonly used: number
}

/** A consult conversation, opened and held for the one turn it lives. */
export interface OpenedConsult {
  readonly runtime: string
  readonly sessionId: string
  readonly openedAt: number
}

export interface ConsultPort {
  /** The conversation calling, as the registry holds it; null for one this desk does not hold. */
  caller(runtime: string, sessionId: string): { readonly cwd: string; readonly project: string | null } | null
  /** Whether a conversation is itself a consult — the depth lock. */
  isConsult(runtime: string, sessionId: string): boolean
  askingSeat(runtime: string, sessionId: string): AskingSeat | null
  seat(id: string): SeatRecord | null
  spendAsk(run: string, seat: string, times: number): Promise<number | null>
  /** The trigger gate by Goal; ok for a Goal no trigger opened. */
  beforeDispatch(goal: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>
  runtime(id: string): RuntimeInfo | null
  /**
   * Opens the consult hidden, ephemeral and asking for the read ceiling, in
   * the caller's checkout. The plane stops waiting when the ask's deadline
   * passes; a conversation that comes back after that is discarded.
   */
  open(agent: FlowSeat, where: { readonly cwd: string; readonly project: string | null }): Promise<OpenedConsult>
  /** Whether the runtime now holds the read ceiling — read back, never assumed. Bounded by the deadline too. */
  holdRead(consult: OpenedConsult): Promise<boolean>
  /**
   * Sends the question as the desk's own notice and settles with the turn
   * it started once that turn completes. Rejects when `signal` aborts first.
   */
  ask(consult: OpenedConsult, text: string, signal: AbortSignal): Promise<Turn>
  /** Discards the consult; answers what it was left as when it could not be deleted. */
  discard(consult: OpenedConsult): Promise<string | null>
  /** Meters the consult on the caller's trigger Goal; answers the meter key, or null when the Goal is not metered. */
  metered(caller: SeatRecord, consult: OpenedConsult & { readonly n: number }): Promise<string | null>
  /** The consult's one turn is about to be sent: recorded before it is, so the meter never reads a working consult as idle. */
  meteredStart(goal: string, meter: string, started: number): Promise<void>
  /**
   * The ask ended: the consult's usage is captured from the live
   * conversation and priced before it is discarded — a deleted conversation
   * cannot be read. Usage that cannot be known leaves the meter unknown,
   * which refuses the Goal's next dispatch and ask.
   */
  meteredEnd(goal: string, meter: string, consult: OpenedConsult, ended: number): Promise<void>
  /** Records that this consult was the caller's Seat asking, so what it spent is the caller's in Insight. */
  link(seat: string, consult: OpenedConsult, closedAt: number): Promise<void>
  audit(entry: {
    readonly runtime: string
    readonly sessionId: string
    readonly agent: string
    readonly outcome: string
    readonly bytesIn: number
    readonly bytesOut: number
    readonly durationMs: number
  }): void
  log(message: string, detail: Readonly<Record<string, unknown>>): void
  now(): number
  setTimer(fire: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** C0 and C1 control characters, except a newline and a tab: an answer is text, never terminal control. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** An answer as the caller is handed it: controls stripped, cut on a character boundary at 32 KiB, and marked when cut. */
export const answerText = (raw: string): { readonly text: string; readonly truncated: boolean } => {
  const clean = raw.replace(CONTROLS, '')
  if (bytes(clean) <= ASK_ANSWER_BYTES) return { text: clean, truncated: false }
  const room = ASK_ANSWER_BYTES - bytes(ASK_TRUNCATED_MARK)
  let kept = ''
  let used = 0
  for (const character of clean) {
    const size = bytes(character)
    if (used + size > room) break
    kept += character
    used += size
  }
  return { text: kept + ASK_TRUNCATED_MARK, truncated: true }
}

/** The last thing the agent said in the turn: its final message when it marked one, else its last message with words in it. */
const lastMessage = (turn: Turn): string | null => {
  const said = turn.items.filter((item) => item.type === 'assistantMessage' && item.text.trim() !== '')
  const final = said.filter((item) => item.type === 'assistantMessage' && item.phase === 'final')
  const last = (final.length > 0 ? final : said).at(-1)
  return last && last.type === 'assistantMessage' ? last.text : null
}

export class ConsultPlane implements AgentsEngine {
  /** One ask per caller at a time: a second waits on the first. */
  readonly #lines = new Map<string, Promise<unknown>>()
  /** Live consults by the run that asked, so the run ending withdraws them. */
  readonly #byRun = new Map<string, Set<AbortController>>()

  constructor(private readonly port: ConsultPort) {}

  /** Waits for a step only until the ask's deadline or cancel: an abort rejects at once with its reason. */
  #within<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const stop = (): void => { reject(signal.reason) }
      signal.addEventListener('abort', stop, { once: true })
      work.then(
        (value) => { signal.removeEventListener('abort', stop); resolve(value) },
        (error: unknown) => { signal.removeEventListener('abort', stop); reject(error) },
      )
    })
  }

  /** One cleanup step, bounded: what fails or outlasts `CONSULT_CLEANUP_MS` is logged, and the ask's line goes on. */
  async #bounded<T>(step: string, work: Promise<T>): Promise<T | undefined> {
    let timer: unknown = null
    const late = new Promise<undefined>((resolve) => {
      timer = this.port.setTimer(() => {
        this.port.log(`a consult’s ${step} did not finish in time`, { ms: CONSULT_CLEANUP_MS })
        resolve(undefined)
      }, CONSULT_CLEANUP_MS)
    })
    try {
      return await Promise.race([work, late])
    } catch (error) {
      this.port.log(`a consult’s ${step} failed`, { error: String(error) })
      return undefined
    } finally {
      this.port.clearTimer(timer)
    }
  }

  async #discard(consult: OpenedConsult): Promise<void> {
    const left = await this.#bounded('discard', this.port.discard(consult).catch((error: unknown) => `could not be discarded: ${String(error)}`))
    if (left === undefined || left) this.port.log('a consult conversation was not deleted', { runtime: consult.runtime, session: consult.sessionId, left: left ?? 'did not finish in time' })
  }

  ask(input: AskInput, scope: AgentsScope): Promise<AskAnswer> {
    const runtime = scope.runtime ?? ''
    const sessionId = scope.sessionId ?? ''
    const line = `${runtime}\u0000${sessionId}`
    const before = this.#lines.get(line) ?? Promise.resolve()
    const mine = before.catch(() => undefined).then(() => this.#ask(input, scope))
    const tail = mine.catch(() => undefined)
    this.#lines.set(line, tail)
    void tail.then(() => { if (this.#lines.get(line) === tail) this.#lines.delete(line) })
    return mine
  }

  /** A run left `running`: every consult it has open is withdrawn. */
  runEnded(run: string): void {
    for (const controller of this.#byRun.get(run) ?? []) controller.abort(refused('askCancelled', 'The run ended before the agent asked answered.'))
  }

  async #ask(input: AskInput, scope: AgentsScope): Promise<AskAnswer> {
    const startedAt = this.port.now()
    // 1. Who is calling.
    const runtime = scope.runtime
    const sessionId = scope.sessionId
    const caller = runtime && sessionId ? this.port.caller(runtime, sessionId) : null
    if (!runtime || !sessionId || !caller) throw refused('askNoCaller', 'ask_agent works only from a conversation on this desk.')
    // 2. Depth 1 — the second lock; the first is that a consult is never offered the tool.
    if (this.port.isConsult(runtime, sessionId)) throw refused('askDepth', 'An agent you asked cannot ask another.')
    // 3. The Flow's gate.
    const seat = this.port.askingSeat(runtime, sessionId)
    if (!seat?.ask) {
      throw refused('askNotAllowed', 'This conversation may not ask another agent: only a seat whose Flow role lists `ask` can.')
    }
    const allowed = [...new Set(seat.ask.seats.map((one) => one.runtime))]
    if (!allowed.includes(input.agent)) {
      const named = allowed.map((id) => {
        const info = this.port.runtime(id)
        return info ? `${id} (${info.presentation.name})` : id
      })
      throw refused('askNotAllowed', `This seat may ask only: ${named.join(', ')}.`)
    }
    if (seat.used >= seat.ask.times) throw refused('askSpent', `This seat has used all ${seat.ask.times} of its asks on this run.`)
    // 4. Money, for a trigger's Goal.
    const gate = await this.port.beforeDispatch(seat.goal)
    if (!gate.ok) throw refused('askBudget', gate.detail)
    // 5. Sizes, in bytes.
    const bytesIn = bytes(input.question) + bytes(input.context ?? '')
    if (input.question.trim() === '') throw refused('askTooLarge', 'The question is empty.')
    if (bytes(input.question) > ASK_INPUT_BYTES) throw refused('askTooLarge', 'The question is larger than 16 KiB.')
    if (input.context !== null && bytes(input.context) > ASK_INPUT_BYTES) throw refused('askTooLarge', 'The context is larger than 16 KiB.')
    // Admission: only an agent whose adapter reports a read ceiling can be held read-only, so only it is asked.
    const target = this.port.runtime(input.agent)
    if (!target) throw refused('askUnavailable', `${input.agent} is not on this desk.`)
    if (!target.ceilings?.read) throw refused('askNoReadCeiling', `${target.presentation.name} cannot be held read-only here, so it is not asked.`)
    // The ask is spent before anything opens: a restarted desk keeps the count.
    const n = await this.port.spendAsk(seat.run, seat.seat, seat.ask.times)
    if (n === null) throw refused('askSpent', `This seat has used all ${seat.ask.times} of its asks on this run.`)

    const timeoutMs = (seat.ask.timeoutSeconds ?? FLOW_ASK_LIMITS.timeoutSeconds.default) * 1000
    const controller = new AbortController()
    const live = this.#byRun.get(seat.run) ?? new Set<AbortController>()
    live.add(controller)
    this.#byRun.set(seat.run, live)
    const timer = this.port.setTimer(
      () => controller.abort(refused('askTimeout', `${target.presentation.name} did not answer within ${timeoutMs / 1000} seconds.`)),
      timeoutMs,
    )
    const withdraw = (): void => { controller.abort(refused('askCancelled', 'The question was withdrawn before it was answered.')) }
    if (scope.signal?.aborted) withdraw()
    scope.signal?.addEventListener('abort', withdraw, { once: true })

    let outcome = 'failed'
    let bytesOut = 0
    let opening: Promise<OpenedConsult> | null = null
    let consult: OpenedConsult | null = null
    let meter: Promise<string | null> | null = null
    try {
      if (controller.signal.aborted) throw controller.signal.reason
      // 6. Open, hidden and read-only, in the caller's checkout — waited for only until the deadline.
      // The role's own seat for that agent: its model and effort, when it names them.
      const spec = seat.ask.seats.find((one) => one.runtime === input.agent) ?? { runtime: input.agent }
      opening = this.port.open(spec, { cwd: caller.cwd, project: caller.project })
      consult = await this.#within(controller.signal, opening)
      if (!await this.#within(controller.signal, this.port.holdRead(consult))) {
        throw refused('askNoReadCeiling', `${target.presentation.name} cannot be held read-only here, so it is not asked.`)
      }
      // Counted against the caller's run: the consult's usage is metered on the caller's Goal.
      const callerSeat = this.port.seat(seat.seat)
      meter = callerSeat && seat.trigger ? this.port.metered(callerSeat, { ...consult, n }) : null
      const key = meter ? await this.#within(controller.signal, meter) : null
      // The turn's start is on the meter before the question goes.
      if (key) await this.#within(controller.signal, this.port.meteredStart(seat.goal, key, this.port.now()))
      // 8. Ask, and wait for the one turn.
      const text = [CONSULT_PROMPT, input.question, ...(input.context ? [input.context] : [])].join('\n\n')
      const turn = await this.port.ask(consult, text, controller.signal)
      if (turn.status === 'failed') {
        throw refused('askFailed', `${target.presentation.name} could not answer: ${turn.error?.message ?? 'its turn failed'}.`)
      }
      const said = lastMessage(turn)
      if (said === null) throw refused('askFailed', `${target.presentation.name} ended its turn without an answer.`)
      // 10. The answer, cleaned and capped. It is untrusted, and reaches the caller only as a tool result.
      const answer = answerText(said)
      bytesOut = bytes(answer.text)
      outcome = answer.truncated ? 'truncated' : 'answered'
      return { text: answer.text, agentName: target.presentation.name, truncated: answer.truncated }
    } catch (error) {
      const code = (error as { wireCode?: unknown } | null)?.wireCode
      outcome = typeof code === 'string' ? code : 'failed'
      throw error
    } finally {
      this.port.clearTimer(timer)
      scope.signal?.removeEventListener('abort', withdraw)
      live.delete(controller)
      if (live.size === 0) this.#byRun.delete(seat.run)
      // 9. Metered from the live conversation, linked to the caller, then discarded — each step bounded.
      if (consult) {
        const ended = this.port.now()
        const key = meter ? await this.#bounded('meter', meter) : null
        if (key) await this.#bounded('usage', this.port.meteredEnd(seat.goal, key, consult, ended))
        await this.#bounded('link', this.port.link(seat.seat, consult, ended))
        await this.#discard(consult)
      } else if (opening) {
        // The deadline or a cancel ended the wait for it: a conversation that comes back later is discarded then.
        void opening.then((late) => this.#discard(late), () => undefined)
      }
      this.port.audit({ runtime, sessionId, agent: input.agent, outcome, bytesIn, bytesOut, durationMs: this.port.now() - startedAt })
    }
  }
}
