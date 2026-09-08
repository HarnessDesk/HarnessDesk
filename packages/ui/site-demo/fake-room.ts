/**
 * The staged room behind the site's fourth desk.
 *
 * The renderer draws the real Room over a TeamState it receives as
 * `team/changed` notifications, and asks the host for `team/peers`, the
 * visitor's referee verbs (`team/add`, `team/intent`, `team/post`,
 * `team/messaging`), and the members' sessions. This class stands in for
 * the host on exactly those, keeping the host's own rules — the state
 * transitions and signal wording of packages/server/src/team.ts — and
 * refuses everything else with the standing sentence. Nothing here is an
 * agent: a message a visitor sends comes back `refused`, never `delivered`
 * to nobody.
 *
 * The seed (demo-rig/demo-room.mjs in the site repository) carries every
 * time as an offset from page load; they become absolute once, here, so the
 * board reads the same on any day. Later stamps are the visitor's clock.
 */
import { AGENT_MESSAGE_NOTICE, agentMessageSource, sessionKey, wrapContext } from '@harnessdesk/protocol'
import type { RuntimeId, SessionId } from '@harnessdesk/protocol'

type Json = Record<string, unknown>

interface StagedMember {
  runtime: string
  sessionId: string
  title: string
  nickname: string
  createdAt: number
  updatedAt: number
}
interface StagedSignal {
  by: Json
  signal: string
  intent: number
  detail: string | null
}
interface StagedFrame {
  dt: number
  intents?: Record<string, Json>
  signals?: StagedSignal[]
  message?: { from: Json; to: Json; text: string }
}
export interface StagedSeed {
  id: string
  name: string
  root: string
  messaging: boolean
  members: StagedMember[]
  intents: Json[]
  channel: Json[]
  timeline: StagedFrame[]
  refusal: string
}
interface Response {
  ok: boolean
  result?: unknown
  error?: unknown
}
type Model = { id: string; provider: string } | undefined

const T_LOAD = Date.now()
const OFFSET_KEYS = new Set(['at', 'createdAt', 'updatedAt', 'leaseUntil'])
const deepClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Offsets from page load become absolute stamps, exactly once. */
const absolute = <T,>(value: T): T => {
  if (Array.isArray(value)) return value.map((entry) => absolute(entry)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Json = {}
    for (const [key, entry] of Object.entries(value as Json)) {
      out[key] = OFFSET_KEYS.has(key) && typeof entry === 'number' ? T_LOAD + entry : absolute(entry)
    }
    return out as T
  }
  return value
}

// The app's own key: the separator is the protocol's to choose, never typed here.
const key = (m: { runtime: string; sessionId: string }): string => sessionKey(m.runtime as RuntimeId, m.sessionId as SessionId) as string

export class StagedRoom {
  readonly id: string
  readonly #seed: StagedSeed
  readonly #state: Json
  readonly #sessions: Json[]
  readonly #push: (message: unknown) => void
  readonly #later: (ms: number, fn: () => void) => void
  readonly #touched = new Set<number>()
  #counter = 0
  #played = false

  constructor(
    seed: StagedSeed,
    sessionTemplate: Json | null,
    models: Record<string, Model>,
    labels: Record<string, string>,
    push: (message: unknown) => void,
    later: (ms: number, fn: () => void) => void,
  ) {
    this.id = seed.id
    this.#seed = seed
    this.#push = push
    this.#later = later
    const nicknames: Record<string, string> = {}
    for (const member of seed.members) nicknames[key(member)] = member.nickname
    this.#state = {
      id: seed.id,
      name: seed.name,
      root: seed.root,
      members: seed.members.map(key),
      messaging: seed.messaging,
      nicknames,
      intents: absolute(deepClone(seed.intents)),
      channel: absolute(deepClone(seed.channel)),
      plans: [],
      problem: null,
    }
    // The members are live conversations with nothing said in them yet —
    // cloned from the recorded session shape so every field the renderer
    // reads is there, retagged to the agent each one belongs to.
    this.#sessions = seed.members.map((member) => {
      const session: Json = sessionTemplate ? deepClone(sessionTemplate) : {}
      session['id'] = member.sessionId
      session['runtime'] = member.runtime
      session['title'] = member.title
      session['preview'] = null
      session['cwd'] = seed.root
      session['createdAt'] = T_LOAD + member.createdAt
      session['updatedAt'] = T_LOAD + member.updatedAt
      session['turns'] = []
      session['status'] = { type: 'idle' }
      const model = models[member.runtime]
      const settings = session['settings'] as Json | undefined
      if (settings) {
        settings['cwd'] = seed.root
        if (model) {
          settings['model'] = model.id
          settings['modelProvider'] = model.provider
        }
      }
      const options = session['options'] as Json[] | undefined
      if (Array.isArray(options) && model) {
        for (const option of options) {
          if (option['id'] !== 'model') continue
          option['currentValue'] = model.id
          option['choices'] = [{ value: model.id, label: labels[model.id] ?? model.id, description: null }]
        }
      }
      return session
    })
  }

  /** The host replays every room on connect, after the sessions it holds. */
  boot(): void {
    this.#later(420, () => {
      for (const session of this.#sessions) {
        this.#push({ method: 'event', params: { runtime: session['runtime'], event: { type: 'session/started', session } } })
      }
    })
    this.#later(440, () => this.#commit())
  }

  /** Answers the requests the room makes; `undefined` means not mine. */
  answer(method: string, params: Json): Response | undefined {
    if (method === 'session/read' || method === 'session/resume') {
      const session = this.#sessions.find(
        (one) => one['runtime'] === params['runtime'] && one['id'] === params['sessionId'],
      )
      return session ? { ok: true, result: session } : undefined
    }
    if (!method.startsWith('team/')) return undefined
    if (params['room'] !== undefined && params['room'] !== this.id) return undefined
    switch (method) {
      case 'team/peers':
        return { ok: true, result: this.#peers() }
      case 'team/add':
        return { ok: true, result: this.#add(params) }
      case 'team/intent':
        this.#intent(params)
        return { ok: true, result: null }
      case 'team/post':
        this.#post(params)
        return { ok: true, result: null }
      case 'team/messaging':
        this.#state['messaging'] = Boolean(params['enabled'])
        this.#commit()
        return { ok: true, result: null }
      default:
        return undefined
    }
  }

  /** The three moves, once: called when the band is on screen. */
  play(): void {
    if (this.#played) return
    this.#played = true
    for (const frame of this.#seed.timeline) this.#later(frame.dt, () => this.#apply(frame))
  }

  // ---------------------------------------------------------------- state

  get #intents(): Json[] {
    return this.#state['intents'] as Json[]
  }
  get #channel(): Json[] {
    return this.#state['channel'] as Json[]
  }

  #commit(): void {
    this.#push({ method: 'team/changed', params: { state: deepClone(this.#state) } })
  }

  #entryId(): string {
    this.#counter += 1
    return `t-${Date.now().toString(36)}-${this.#counter}`
  }

  #find(id: number): Json | undefined {
    return this.#intents.find((one) => one['id'] === id)
  }

  #patch(id: number, patch: Json): void {
    const intent = this.#find(id)
    if (!intent) return
    Object.assign(intent, patch, { updatedAt: Date.now() })
  }

  #signal(by: Json, signal: string, intent: Json, detail: string | null): void {
    this.#channel.push({
      id: this.#entryId(),
      at: Date.now(),
      kind: 'signal',
      by,
      signal,
      intent: intent['id'],
      title: intent['title'],
      detail,
    })
  }

  /** The host's own rule: graph-blocked work opens when its dependencies are done. */
  #unblock(by: Json): void {
    for (const intent of this.#intents) {
      if (intent['state'] !== 'blocked' || intent['blockedBy'] === 'hand') continue
      const deps = (intent['dependsOn'] as number[] | undefined) ?? []
      const ready = deps.every((dep) => {
        const found = this.#find(dep)
        return found === undefined || found['state'] === 'done'
      })
      if (ready && deps.length > 0) {
        this.#patch(intent['id'] as number, { state: 'open', blockedReason: null, blockedBy: null })
        this.#signal(by, 'unblocked', intent, null)
      }
    }
  }

  #peers(): Json[] {
    return this.#seed.members.map((member) => ({
      runtime: member.runtime,
      sessionId: member.sessionId,
      title: member.title,
      agent: member.nickname,
      // Open, and in the room: the desk asks the host which members are
      // actually attached, and a peer that does not say so reads as away —
      // grey mark, "not open", and a claim whose holder is nowhere.
      here: true,
      busy: false,
      nickname: member.nickname,
      model: (this.#sessions.find((one) => one['id'] === member.sessionId)?.['settings'] as Json | undefined)?.['model'] ?? null,
      usedBoard: this.#channel.some((entry) => {
        const by = entry['by'] as Json | undefined
        return entry['kind'] === 'signal' && by?.['kind'] === 'agent' && by['sessionId'] === member.sessionId
      }),
    }))
  }

  #add(params: Json): Json {
    const ids = this.#intents.map((one) => one['id'] as number)
    const dependsOn = Array.isArray(params['dependsOn']) ? (params['dependsOn'] as number[]) : []
    const waiting = dependsOn.some((dep) => {
      const found = this.#find(dep)
      return found !== undefined && found['state'] !== 'done'
    })
    const now = Date.now()
    const intent: Json = {
      id: (ids.length ? Math.max(...ids) : 0) + 1,
      title: String(params['title'] ?? '').trim(),
      detail: typeof params['detail'] === 'string' && params['detail'].trim() ? params['detail'].trim() : null,
      state: waiting ? 'blocked' : 'open',
      files: Array.isArray(params['files']) ? params['files'] : [],
      dependsOn,
      claim: null,
      blockedReason: null,
      blockedBy: waiting ? 'graph' : null,
      handoff: null,
      note: null,
      plan: null,
      createdAt: now,
      updatedAt: now,
    }
    this.#intents.push(intent)
    this.#touched.add(intent['id'] as number)
    const files = intent['files'] as string[]
    this.#signal({ kind: 'user' }, 'added', intent, files.length ? files.join(', ') : null)
    this.#commit()
    return deepClone(intent)
  }

  #intent(params: Json): void {
    const id = Number(params['id'])
    const intent = this.#find(id)
    if (!intent) return
    const by: Json = { kind: 'user' }
    const action = params['action']
    this.#touched.add(id)
    if (action === 'block') {
      const said = typeof params['reason'] === 'string' && params['reason'].trim() ? params['reason'].trim() : null
      this.#patch(id, { state: 'blocked', claim: null, blockedReason: said, blockedBy: 'hand' })
      this.#signal(by, 'blocked', intent, said ?? 'stopped by you')
    } else if (action === 'release') {
      this.#patch(id, { state: 'open', claim: null, blockedReason: null, blockedBy: null })
      this.#signal(by, 'released', intent, 'released by you')
    } else if (action === 'abandon') {
      this.#patch(id, { state: 'abandoned', claim: null })
      this.#signal(by, 'abandoned', intent, null)
    } else if (action === 'done') {
      this.#patch(id, { state: 'done', claim: null })
      this.#signal(by, 'completed', intent, 'marked done by you')
      this.#unblock(by)
    } else {
      this.#patch(id, { state: 'open', claim: null, blockedReason: null, blockedBy: null })
      this.#signal(by, 'reopened', intent, null)
    }
    this.#commit()
  }

  #post(params: Json): void {
    // The host writes a post once per recipient; the renderer folds the
    // copies into one row. Everyone means every member.
    const to = params['to'] as Json | undefined
    const targets = to
      ? this.#seed.members.filter((one) => one.runtime === to['runtime'] && one.sessionId === to['sessionId'])
      : this.#seed.members
    const at = Date.now()
    for (const member of targets) {
      this.#channel.push({
        id: this.#entryId(),
        at,
        kind: 'message',
        from: { kind: 'user' },
        to: { runtime: member.runtime, sessionId: member.sessionId, title: member.title, nickname: member.nickname },
        text: String(params['text'] ?? ''),
        state: 'refused',
        reason: this.#seed.refusal,
        envelope: null,
      })
    }
    this.#commit()
  }

  #apply(frame: StagedFrame): void {
    const applied = new Set<number>()
    for (const [idText, patch] of Object.entries(frame.intents ?? {})) {
      const id = Number(idText)
      const intent = this.#find(id)
      // A card the visitor has already moved is theirs; the story steps
      // around it. A claim only lands on work that is actually open.
      if (!intent || this.#touched.has(id)) continue
      if (patch['state'] === 'claimed' && intent['state'] !== 'open') continue
      const next: Json = { ...patch }
      const claim = next['claim'] as Json | undefined
      if (claim && typeof claim['lease'] === 'number') {
        const now = Date.now()
        next['claim'] = { runtime: claim['runtime'], sessionId: claim['sessionId'], at: now, leaseUntil: now + (claim['lease'] as number) }
      }
      this.#patch(id, next)
      applied.add(id)
      if (patch['state'] === 'done') this.#unblockSilently(id)
    }
    for (const entry of frame.signals ?? []) {
      const intent = this.#find(entry.intent)
      if (!intent) continue
      // A signal about a patch that was skipped is skipped with it; the
      // unblock that follows a completion is the completion's own.
      const owner = entry.signal === 'unblocked' ? this.#unblockedBy.get(entry.intent) : entry.intent
      if (owner === undefined || !applied.has(owner)) continue
      this.#signal(entry.by, entry.signal, intent, entry.detail)
    }
    if (frame.message) {
      const from = frame.message.from
      const envelope = wrapContext(
        agentMessageSource(String(from['nickname'] ?? from['title'] ?? ''), String(from['title'] ?? '')),
        `${frame.message.text}\n\n${AGENT_MESSAGE_NOTICE}`,
      )
      const boardOnly = this.#state['messaging'] === false
      this.#channel.push({
        id: this.#entryId(),
        at: Date.now(),
        kind: 'message',
        from,
        to: frame.message.to,
        text: frame.message.text,
        state: boardOnly ? 'refused' : 'delivered',
        reason: boardOnly ? 'board-only is on, so this was not sent. Claims and signals continue.' : null,
        envelope,
      })
    }
    this.#commit()
  }

  /** Which completion opened which job, so the timeline can credit it. */
  readonly #unblockedBy = new Map<number, number>()
  #unblockSilently(doneId: number): void {
    for (const intent of this.#intents) {
      if (intent['state'] !== 'blocked' || intent['blockedBy'] === 'hand') continue
      const deps = (intent['dependsOn'] as number[] | undefined) ?? []
      const ready = deps.every((dep) => {
        const found = this.#find(dep)
        return found === undefined || found['state'] === 'done'
      })
      if (ready && deps.length > 0 && !this.#touched.has(intent['id'] as number)) {
        this.#patch(intent['id'] as number, { state: 'open', blockedReason: null, blockedBy: null })
        this.#unblockedBy.set(intent['id'] as number, doneId)
      }
    }
  }
}
