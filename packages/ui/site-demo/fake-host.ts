/**
 * A host that lives inside the page, for the website's embedded demo.
 *
 * The production renderer is untouched: its Transport constructs a WebSocket
 * and speaks the wire protocol, so this class stands in for WebSocket and
 * answers from a recorded session (demo-rig/capture-wire.mjs in the site
 * repository). Requests are answered from the recording; the one captured
 * turn replays with the visitor's own words in it; every turn after that is
 * synthesized from recorded event shapes. Nothing here reaches a network.
 *
 * URL knobs, set by the embedding page:
 *   ?pace=fast — the recorded turn plays at ~20× and the approval resolves
 *   itself from the recorded answer, for sections that open on a finished
 *   conversation rather than an empty composer.
 */

import wire from './demo-wire.json'
import { StagedRoom, type StagedSeed } from './fake-room'

interface WireEventParams {
  runtime: string
  event: Record<string, unknown> & { type: string }
}
interface TimedEvent {
  dt: number
  params: WireEventParams
}
interface WireResponse {
  ok: boolean
  result?: unknown
  error?: unknown
}

export const RECORDED_PROMPT: string = (wire as { prompt: string }).prompt
const RESPONSES = (wire as { responses: Record<string, WireResponse> }).responses
const VARIANTS = (wire as { variants?: Record<string, Array<{ params: Record<string, unknown>; res: WireResponse }>> }).variants ?? {}
const LEDGERS = (wire as {
  ledgers?: {
    base: Record<string, unknown> & { daily: Array<{ day: number; runtime: string; cost: number; tokens: number }> }
    byPivot: Record<string, { rows: Array<Record<string, unknown>> }>
  }
}).ledgers
const BOOT = (wire as { boot: Array<{ t: number; method: string; params: unknown }> }).boot
const TURN = (wire as { turn: { pre: TimedEvent[]; post: TimedEvent[] } }).turn
const TEMPLATES = (wire as { templates: Record<string, WireEventParams> }).templates

/**
 * The wire's clock. Every absolute stamp in the recording sits on one epoch
 * (`capturedNow`, written by process-wire); shifting them all by the same
 * delta puts "Read 2m ago", "resets in 1h" and the sessions' ages where they
 * were the day the story was staged. Computed once: a delta taken per reply
 * would move a file's modifiedAt under the editor's own poll and reload it.
 * Durations, offsets, counts, and the sentinel stamps below 2024 (which the
 * renderer already treats as "no time") are never touched.
 */
const CAPTURED_NOW = (wire as { capturedNow?: number }).capturedNow ?? Date.now()
const SHIFT = Date.now() - CAPTURED_NOW
const TIME_KEYS = new Set(['fetchedAt', 'resetsAt', 'scannedAt', 'startedAt', 'finishedAt', 'completedAt', 'requestedAt', 'createdAt', 'updatedAt', 'lastOpenedAt', 'catalogCheckedAt', 'modifiedAt', 'committedAt'])
const EARLIEST = Date.UTC(2024, 0, 1)
const DAY = 86_400_000
const shiftTimes = <T,>(value: T, delta: number): T => {
  if (Array.isArray(value)) return value.map((entry) => shiftTimes(entry, delta)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = TIME_KEYS.has(key) && typeof entry === 'number' && entry >= EARLIEST ? entry + delta : shiftTimes(entry, delta)
    }
    return out as T
  }
  return value
}
/**
 * A day bucket is matched by exact equality against the visitor's local
 * midnight, so the staged days are re-laid onto today's calendar rather than
 * shifted: the latest staged day becomes today, the one before it yesterday.
 */
const resnapDays = <T extends { day: number }>(daily: T[]): T[] => {
  if (daily.length === 0) return daily
  const latest = Math.max(...daily.map((d) => d.day))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return daily.map((d) => ({ ...d, day: today.getTime() - Math.round((latest - d.day) / DAY) * DAY }))
}

const KNOBS = new URL(window.location.href).searchParams
const FAST = KNOBS.get('pace') === 'fast'
const VIEW = KNOBS.get('view') ?? 'hero'
/** The staged room (demo-rig/demo-room.mjs), only when the page asks for it. */
const ROOM_SEED = (wire as { room?: StagedSeed }).room ?? null
export const ROOM_ID: string | null = ROOM_SEED?.id ?? null
const DT = FAST ? 0.05 : 1
const RECORDED_RUNTIME = TEMPLATES['turnStarted'].runtime
const RECORDED_TURN_START = ((TEMPLATES['turnStarted'].event as { turn?: { startedAt?: number } }).turn?.startedAt) ?? CAPTURED_NOW

const DOWNLOAD = 'https://updates.harnessdesk.app/mac/HarnessDesk-0.1.0-arm64.dmg'

/**
 * What everything outside the demo's story answers with.
 *
 * The desk is the real renderer, so it offers controls this page cannot
 * honour — starting an agent, renaming a room, signing in. They refuse with
 * this, and `main.tsx` drops any toast carrying it: an unavailable control
 * does nothing at all rather than raising an error a visitor can neither act
 * on nor learn from. Where a refusal belongs to a surface the visitor is
 * already reading — the room's channel, which shows a message coming back
 * refused and says why — it is written into that surface instead.
 */
export const NOT_WIRED = 'Not wired in this web demo — the desktop app does this for real.'

/** The follow-up turns: honest about the demo, pointing at the real thing. */
const FOLLOW_UPS: string[] = [
  'Fair warning: that first turn was staged. This window is the real HarnessDesk renderer — the same code the desktop app ships — but the agent behind it is a recording with no keys to anything.\n\nThe real desk runs your own Codex, Claude, and Cursor, on your machine, against your repositories. Download it and bring your agents:\n\n' + DOWNLOAD + '\n\nApple silicon · notarized · no account, ever.',
  'Still me, still a recording. What you are poking at is the production interface — transcript, approvals, composer — wired to a replayed session instead of a live agent.\n\nTwo things the real desk does that this page cannot: run a second agent beside this one in its own worktree, and hand this conversation to it — goal, files, branch — when a plan runs dry. That second one is the reason it exists. The room further down this page is the board several of them share — staged, since none of them runs here.\n\n' + DOWNLOAD,
  'The demo has exactly one trick and you have now seen it twice. The download is one file, it is notarized, and it never asks you to sign in:\n\n' + DOWNLOAD,
]

/** The reply to a hand-off packet arriving in a second agent. */
const HANDOFF_REPLY =
  'Hand-off received. The packet above carried the goal, the changed files, and branch fix/checkout-retry — enough to keep going without retyping any of it.\n\nIn the desktop app this is a live second agent picking the work up in its own worktree; here it is a recording, so this is where the demo stops and the real thing starts:\n\n' + DOWNLOAD

const deepClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const MODEL_OF: Record<string, { id: string; provider: string } | undefined> = {
  'claude-code': { id: 'claude-opus-5', provider: 'anthropic' },
  cursor: { id: 'composer-2', provider: 'cursor' },
}
const MODEL_LABEL: Record<string, string> = { 'claude-opus-5': 'Claude Opus 5', 'composer-2': 'Composer 2' }

/** Rewrites the recorded ask into the visitor's words, wherever it appears. */
const substitute = (params: WireEventParams, visitorText: string): WireEventParams => {
  const text = JSON.stringify(params)
  if (!text.includes(RECORDED_PROMPT.slice(0, 24))) return params
  return JSON.parse(
    text.split(JSON.stringify(RECORDED_PROMPT).slice(1, -1)).join(JSON.stringify(visitorText).slice(1, -1)),
  ) as WireEventParams
}

/** Answers usage/ledger from the staged story: slice the window, filter the scope. */
const ledgerFor = (params: Record<string, unknown>): WireResponse => {
  if (!LEDGERS) return { ok: true, result: null }
  const days = typeof params['days'] === 'number' ? (params['days'] as number) : 30
  const scope = typeof params['runtime'] === 'string' ? (params['runtime'] as string) : null
  const pivot = typeof params['groupBy'] === 'string' ? (params['groupBy'] as string) : 'runtime'
  const base = deepClone(LEDGERS.base)
  base.daily = resnapDays(base.daily)
  const latest = Math.max(...base.daily.map((d) => d.day))
  const cutoff = latest - (days - 1) * 86_400_000
  let daily = base.daily.filter((d) => d.day >= cutoff)
  if (scope) daily = daily.filter((d) => d.runtime === scope)
  const total = (field: 'cost' | 'tokens') => Math.round(daily.reduce((t, d) => t + d[field], 0) * 100) / 100
  const fullCost = base.daily.reduce((t, d) => t + d.cost, 0)
  const ratio = fullCost > 0 ? daily.reduce((t, d) => t + d.cost, 0) / fullCost : 1
  const rows = (LEDGERS.byPivot[pivot]?.rows ?? [])
    .filter((r) => (scope ? r['runtime'] === scope || r['key'] === scope : true))
    .map((r) => ({
      ...r,
      cost: typeof r['cost'] === 'number' ? Math.round((r['cost'] as number) * ratio * 100) / 100 : r['cost'],
      tokens: typeof r['tokens'] === 'number' ? Math.round((r['tokens'] as number) * ratio) : r['tokens'],
    }))
  return { ok: true, result: { ...base, days, daily, rows, totalCost: total('cost'), totalTokens: total('tokens') } }
}

export class FakeHostSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeHostSocket.CONNECTING

  #listeners = new Map<string, Array<(event: unknown) => void>>()
  #timers: number[] = []
  #turnsQueued = 0
  #pendingApproval: (() => void) | null = null
  #closed = false
  #room: StagedRoom | null = null

  constructor(_url: string) {
    if (VIEW === 'room' && ROOM_SEED) {
      const template = TURN.pre.map((entry) => entry.params.event).find((event) => event.type === 'session/started')
      this.#room = new StagedRoom(
        ROOM_SEED,
        ((template as { session?: Record<string, unknown> } | undefined)?.session) ?? null,
        MODEL_OF,
        MODEL_LABEL,
        (message) => this.#push(message),
        (ms, fn) => this.#later(ms, fn),
      )
      window.addEventListener('hd-room-play', () => this.#room?.play(), { once: true })
    }
    this.#later(30, () => {
      this.readyState = FakeHostSocket.OPEN
      this.#emit('open', {})
      for (const notification of BOOT) {
        this.#later(Math.min(notification.t, 400), () =>
          this.#push({ method: notification.method, params: shiftTimes(notification.params, SHIFT) }),
        )
      }
      this.#room?.boot()
    })
  }

  addEventListener(name: string, handler: (event: unknown) => void): void {
    const list = this.#listeners.get(name) ?? []
    list.push(handler)
    this.#listeners.set(name, list)
  }
  removeEventListener(name: string, handler: (event: unknown) => void): void {
    const list = this.#listeners.get(name) ?? []
    this.#listeners.set(name, list.filter((h) => h !== handler))
  }

  close(): void {
    this.#closed = true
    for (const timer of this.#timers) window.clearTimeout(timer)
    this.readyState = FakeHostSocket.CLOSED
    this.#emit('close', {})
  }

  send(frame: string): void {
    let message: { id: number; method: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(frame) as typeof message
    } catch {
      return
    }
    const { id, method } = message
    const params = message.params ?? {}

    if (method === 'turn/queue') {
      this.#reply(id, { ok: true, result: {} })
      const input = (params as { input?: Array<{ type: string; text?: string }> }).input ?? []
      const text = input.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ').trim()
      const runtime = typeof params['runtime'] === 'string' ? (params['runtime'] as string) : RECORDED_RUNTIME
      const sessionId = typeof params['sessionId'] === 'string' ? (params['sessionId'] as string) : null
      this.#turnsQueued += 1
      if (runtime !== RECORDED_RUNTIME || text.includes('## Goal')) {
        // A hand-off landed in another agent: answer as that agent, in the
        // session the renderer just created for it.
        this.#playFollowUp(text || '…', HANDOFF_REPLY, runtime, sessionId)
      } else if (this.#turnsQueued === 1) {
        this.#playRecordedTurn(text || RECORDED_PROMPT)
      } else {
        const answer = FOLLOW_UPS[Math.min(this.#turnsQueued - 2, FOLLOW_UPS.length - 1)]
        this.#playFollowUp(text || '…', answer, runtime, sessionId)
      }
      return
    }

    if (method === 'session/create' && this.#room) {
      // Adding an agent to the staged room would first start a real one; the
      // dialog then says what it says on a desk with no agent to start.
      this.#reply(id, { ok: false, error: { message: NOT_WIRED } })
      return
    }

    if (method === 'session/create') {
      // The capture only ever created a Codex session; a hand-off creates
      // one for another agent. Same recorded shape, retagged to the agent
      // that asked — the synthesized turn events use the same session id.
      const runtime = typeof params['runtime'] === 'string' ? (params['runtime'] as string) : RECORDED_RUNTIME
      const recorded = RESPONSES['session/create:' + runtime] ?? RESPONSES['session/create:' + RECORDED_RUNTIME]
      const body = deepClone(recorded)
      const result = body.result as Record<string, unknown> | null
      const model = MODEL_OF[runtime]
      if (result && typeof result === 'object') {
        result['runtime'] = runtime
        const settings = result['settings'] as Record<string, unknown> | undefined
        if (settings && model) {
          settings['model'] = model.id
          settings['modelProvider'] = model.provider
        }
        const options = result['options'] as Array<Record<string, unknown>> | undefined
        if (Array.isArray(options) && model) {
          for (const option of options) {
            if (option['id'] !== 'model') continue
            option['currentValue'] = model.id
            option['choices'] = [{ value: model.id, label: MODEL_LABEL[model.id] ?? model.id, description: null }]
          }
        }
      }
      this.#reply(id, body)
      return
    }

    if (method === 'approval/respond') {
      this.#reply(id, RESPONSES['approval/respond'] ?? { ok: true, result: {} })
      const resume = this.#pendingApproval
      this.#pendingApproval = null
      if (resume) resume.call(null)
      return
    }

    if (method === 'usage/ledger') {
      this.#reply(id, ledgerFor(params))
      return
    }

    if (method === 'usage/reports' || method === 'usage/refresh') {
      const body = deepClone(RESPONSES[method] ?? { ok: true, result: [] })
      const reports = body.result as Array<{ spend?: { daily?: Array<{ day: number }> } }> | undefined
      for (const report of reports ?? []) if (report.spend?.daily) report.spend.daily = resnapDays(report.spend.daily)
      this.#reply(id, body)
      return
    }

    // The staged room answers for its board, its roster, and its members'
    // sessions; its stamps are already on the visitor's clock.
    if (this.#room) {
      const answered = this.#room.answer(method, params)
      if (answered !== undefined) {
        this.#replyRaw(id, answered)
        return
      }
    }

    // A method the capture asked more than one thing of answers per-params:
    // reading a second file must not return the first one.
    const variantList = VARIANTS[method]
    if (variantList) {
      const wanted = JSON.stringify(params)
      const hit = variantList.find((v) => JSON.stringify(v.params) === wanted)
      if (hit) {
        this.#reply(id, hit.res)
        return
      }
    }

    const key = typeof params['runtime'] === 'string' ? `${method}:${String(params['runtime'])}` : method
    const recorded = RESPONSES[key] ?? RESPONSES[method]
    if (recorded) {
      this.#reply(id, recorded)
      return
    }
    // Anything the recording never saw is out of the demo's reach — say so
    // in the app's own voice rather than pretending.
    this.#reply(id, {
      ok: false,
      error: { message: NOT_WIRED },
    })
  }

  // ------------------------------------------------------------------ turns

  #playRecordedTurn(visitorText: string): void {
    // "Working for …" counts from the moment the visitor pressed send, not
    // from the afternoon the turn was recorded.
    const turnShift = Date.now() - RECORDED_TURN_START
    const play = (list: TimedEvent[], offset: number, done?: (end: number) => void) => {
      let end = offset
      for (const { dt, params } of list) {
        end = offset + dt * DT
        this.#later(end, () => this.#push({ method: 'event', params: shiftTimes(substitute(params, visitorText), turnShift) }))
      }
      if (done) this.#later(end, () => done(end))
    }
    play(TURN.pre, 0, (end) => {
      if (FAST) {
        // The recorded answer is part of the recording: the approval resolves
        // itself and the rest of the turn follows without a pause.
        play(TURN.post, end + 120)
      } else {
        // The stream is now parked on approval/requested; the renderer's own
        // dialog is up. The answer request releases the rest.
        this.#pendingApproval = () => play(TURN.post, 0)
      }
    })
  }

  #playFollowUp(visitorText: string, answer: string, runtime: string, sessionId: string | null): void {
    const n = this.#turnsQueued
    const followShift = Date.now() - RECORDED_TURN_START

    const patch = (name: string, fn: (event: Record<string, unknown>) => void): WireEventParams => {
      const cloned = shiftTimes(deepClone(TEMPLATES[name]), followShift)
      cloned.runtime = runtime
      fn(cloned.event as Record<string, unknown>)
      return cloned
    }
    const retag = (event: Record<string, unknown>, item: Record<string, unknown> | null, id: string) => {
      if (typeof event['turnId'] === 'string') event['turnId'] = `turn-demo-${n}`
      if (item && typeof item['id'] === 'string') item['id'] = id
      if (typeof event['itemId'] === 'string') event['itemId'] = id
      if (sessionId && typeof event['threadId'] === 'string') event['threadId'] = sessionId
    }

    let t = 150
    const at = (delay: number, params: WireEventParams) => {
      t += delay
      this.#later(t, () => this.#push({ method: 'event', params }))
    }

    at(0, patch('turnStarted', (e) => {
      retag(e, null, '')
      const turn = e['turn'] as Record<string, unknown> | undefined
      if (turn && typeof turn['id'] === 'string') turn['id'] = `turn-demo-${n}`
    }))
    at(60, patch('userStarted', (e) => {
      const item = e['item'] as Record<string, unknown>
      retag(e, item, `item-demo-u${n}`)
      item['content'] = [{ type: 'text', text: visitorText }]
    }))
    at(30, patch('userCompleted', (e) => {
      const item = e['item'] as Record<string, unknown>
      retag(e, item, `item-demo-u${n}`)
      item['content'] = [{ type: 'text', text: visitorText }]
    }))
    at(600, patch('messageStarted', (e) => {
      const item = e['item'] as Record<string, unknown>
      retag(e, item, `item-demo-a${n}`)
      item['text'] = ''
    }))
    const words = answer.split(' ')
    for (let i = 0; i < words.length; i += 4) {
      at(i === 0 ? 300 : 90, patch('messageDelta', (e) => {
        retag(e, null, `item-demo-a${n}`)
        const delta = e['delta'] as Record<string, unknown>
        delta['text'] = (i === 0 ? '' : ' ') + words.slice(i, i + 4).join(' ')
      }))
    }
    at(200, patch('messageCompleted', (e) => {
      const item = e['item'] as Record<string, unknown>
      retag(e, item, `item-demo-a${n}`)
      item['text'] = answer
    }))
    at(250, patch('turnCompleted', (e) => {
      retag(e, null, '')
      const turn = e['turn'] as Record<string, unknown> | undefined
      if (turn && typeof turn['id'] === 'string') turn['id'] = `turn-demo-${n}`
    }))
  }

  // ------------------------------------------------------------------ wiring

  #reply(id: number, body: WireResponse): void {
    this.#later(15, () => this.#push({ id, ...shiftTimes(body, SHIFT) }))
  }
  /** For answers stamped on the visitor's clock already. */
  #replyRaw(id: number, body: WireResponse): void {
    this.#later(15, () => this.#push({ id, ...body }))
  }
  #push(message: unknown): void {
    this.#emit('message', { data: JSON.stringify(message) })
  }
  #emit(name: string, payload: Record<string, unknown>): void {
    if (this.#closed && name !== 'close') return
    for (const handler of this.#listeners.get(name) ?? []) handler(payload)
  }
  #later(ms: number, fn: () => void): void {
    this.#timers.push(window.setTimeout(fn, ms))
  }
}
