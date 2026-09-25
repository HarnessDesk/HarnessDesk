import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

import type { TriggerAttention, TriggerAttentionKind } from '@harnessdesk/protocol'

import { Serial } from '../goals/assignments.js'
import { atomicJson } from '../goals/store.js'

/**
 * Named attention: in a Goal a trigger opened, nothing waits on a person in
 * silence.
 *
 * Every wait on unattended work — a held message, a held action or approval,
 * a question, a step addressed to a person, a member it waits for, a budget
 * stop, a source that stopped reading, a review that could not be posted — is
 * one `TriggerAttention`: who it waits on, in a sentence, and what opens it.
 *
 * - **One id per transition.** An attention's id is derived from the key of
 *   the request or reason it stands for. The same wait read again is the same
 *   id; a wait that ended and began again is a new one.
 * - **Durable before it is said.** The outbox (`triggers-attention.json`)
 *   records a new wait before it is announced, and a resolution before it is
 *   announced; a reconnect or a restart replays what is still unresolved by
 *   its id, and never makes a second.
 * - **Scoped.** A scope — a Goal, a source, an arm — is reconciled whole:
 *   what it no longer shows is resolved, and only that; another scope's waits
 *   keep the Goal in Needs you.
 * - **Never claimed.** `notification` is `pending` until the desktop says it
 *   delivered it outside the app or could not; nothing here claims either.
 *
 * One writer: this class, through one queue. It asks for no other queue.
 */

const FILE = 'triggers-attention.json'
const LIMIT = 2000
const BYTES = 4 * 1024 * 1024
const SENTENCE = 600
const LABEL = 120

/** What a wait is, before the outbox gives it an id and times. */
export interface AttentionInput {
  /** The request or reason it stands for: stable while the wait is the same wait. */
  readonly key: string
  readonly goal: string | null
  readonly trigger: string
  readonly kind: TriggerAttentionKind
  readonly waitingOn: TriggerAttention['waitingOn']
  readonly sentence: string
  readonly action: TriggerAttention['action']
}

interface Stored extends TriggerAttention {
  readonly key: string
  readonly scope: string
  /** How many times the same skip reason was seen in its window: shown, never re-announced. */
  readonly count: number
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const KINDS = new Set(['message', 'approval', 'question', 'person-step', 'member', 'budget', 'source', 'publication', 'skipped'])
const WAITING = new Set(['person', 'member', 'service'])
const ACTIONS = new Set(['open-goal', 'open-trigger', 'open-permissions', 'open-usage'])
const NOTIFIED = new Set(['pending', 'delivered', 'unavailable'])

const clip = (text: string, limit: number): string => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

const storedOf = (value: unknown): Stored | null => {
  if (!isMap(value)) return null
  const { id, key, scope, goal, trigger, kind, waitingOn, sentence, action, createdAt, resolvedAt, notification, count } = value
  if (typeof id !== 'string' || !/^att-[0-9a-f]{32}$/.test(id) || typeof key !== 'string' || key.length > 1024 ||
    typeof scope !== 'string' || scope.length > 1024 || !(goal === null || (typeof goal === 'string' && goal.length <= 200)) ||
    typeof trigger !== 'string' || trigger.length > 64 || !KINDS.has(kind as string) || !isMap(waitingOn) ||
    !WAITING.has(waitingOn['kind'] as string) || typeof waitingOn['label'] !== 'string' || typeof sentence !== 'string' ||
    !ACTIONS.has(action as string) || !Number.isSafeInteger(createdAt) || !(resolvedAt === null || Number.isSafeInteger(resolvedAt)) ||
    !NOTIFIED.has(notification as string) || !Number.isSafeInteger(count)) return null
  return value as unknown as Stored
}

const publicOf = ({ key: _key, scope: _scope, count: _count, ...attention }: Stored): TriggerAttention => attention

export interface AttentionOutboxPort {
  /** Announced once each entry — raised or resolved — is on the disk. */
  announce(attention: TriggerAttention): void
  now(): number
  log?(message: string, details?: Readonly<Record<string, unknown>>): void
}

export class AttentionOutbox {
  readonly #file: string
  readonly #port: AttentionOutboxPort
  readonly #serial = new Serial()
  #entries: Stored[] = []
  #loaded = false

  constructor(home: string, port: AttentionOutboxPort) {
    this.#file = join(home, FILE)
    this.#port = port
  }

  /** Reads the outbox once. An unreadable one is set aside by starting empty: waits are recomputed from their owners. */
  async load(): Promise<void> {
    await this.#serial.run(async () => {
      this.#entries = await this.#read()
      this.#loaded = true
    })
  }

  async #read(): Promise<Stored[]> {
    let handle
    try {
      handle = await open(this.#file, 'r')
    } catch {
      return []
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > BYTES) return []
      const parsed = JSON.parse(await handle.readFile('utf8')) as unknown
      if (!isMap(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['entries'])) return []
      return (parsed['entries'] as unknown[]).map(storedOf).filter((one): one is Stored => one !== null)
    } catch {
      return []
    } finally {
      await handle.close()
    }
  }

  async #save(entries: Stored[]): Promise<void> {
    // Resolved ones go first, oldest first, once the outbox is full: an unresolved wait is never forgotten.
    let kept = entries
    if (kept.length > LIMIT) {
      const resolved = kept.filter((one) => one.resolvedAt !== null).sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
      const drop = new Set(resolved.slice(0, kept.length - LIMIT).map((one) => one.id))
      kept = kept.filter((one) => !drop.has(one.id))
    }
    await atomicJson(this.#file, { version: 1, entries: kept })
    this.#entries = kept
  }

  /** The id a key's next transition gets: its hash, and how many times it was raised before. */
  #idFor(key: string): string {
    const times = this.#entries.filter((one) => one.key === key).length
    return `att-${createHash('sha256').update(JSON.stringify([key, times])).digest('hex').slice(0, 32)}`
  }

  /**
   * Makes one scope show exactly `wanted`: a wait not yet open is recorded
   * and announced; an open one still wanted is left as it is (the same id);
   * an open one the scope no longer shows is resolved and announced.
   */
  sync(scope: string, wanted: readonly AttentionInput[]): Promise<void> {
    return this.#serial.run(async () => {
      if (!this.#loaded) return
      const now = this.#port.now()
      const open = this.#entries.filter((one) => one.scope === scope && one.resolvedAt === null)
      const keys = new Set(wanted.map((one) => one.key))
      const raised: Stored[] = []
      for (const input of wanted) {
        if (open.some((one) => one.key === input.key)) continue
        if (raised.some((one) => one.key === input.key)) continue
        raised.push({
          id: this.#idFor(input.key), key: input.key, scope, goal: input.goal, trigger: input.trigger, kind: input.kind,
          waitingOn: { kind: input.waitingOn.kind, label: clip(input.waitingOn.label, LABEL) },
          sentence: clip(input.sentence, SENTENCE), action: input.action,
          createdAt: now, resolvedAt: null, notification: 'pending', count: 1,
        })
      }
      const ended = new Set(open.filter((one) => !keys.has(one.key)).map((one) => one.id))
      if (raised.length === 0 && ended.size === 0) return
      const next = [
        ...this.#entries.map((one) => ended.has(one.id) ? { ...one, resolvedAt: now } : one),
        ...raised,
      ]
      await this.#save(next)
      for (const one of next) if (ended.has(one.id)) this.#port.announce(publicOf(one))
      for (const one of raised) this.#port.announce(publicOf(one))
    })
  }

  /** Resolves every open wait in every scope that starts with `prefix`, announcing each once. */
  resolveScopes(prefix: string): Promise<void> {
    return this.#serial.run(async () => {
      if (!this.#loaded) return
      const now = this.#port.now()
      const ended = new Set(this.#entries.filter((one) => one.resolvedAt === null && one.scope.startsWith(prefix)).map((one) => one.id))
      if (ended.size === 0) return
      const next = this.#entries.map((one) => ended.has(one.id) ? { ...one, resolvedAt: now } : one)
      await this.#save(next)
      for (const one of next) if (ended.has(one.id)) this.#port.announce(publicOf(one))
    })
  }

  /**
   * A notice that asks nothing of anyone — a skipped firing — recorded
   * resolved and announced once. The same key within `windowMs` of the last
   * one only counts: never a second announcement, never a storm.
   */
  notice(scope: string, input: AttentionInput, windowMs: number): Promise<void> {
    return this.#serial.run(async () => {
      if (!this.#loaded) return
      const now = this.#port.now()
      const recent = [...this.#entries].reverse().find((one) => one.key === input.key && now - one.createdAt < windowMs)
      if (recent) {
        const count = recent.count + 1
        await this.#save(this.#entries.map((one) => one.id === recent.id
          ? { ...one, count, sentence: clip(`${input.sentence} (${count} times in the last few minutes)`, SENTENCE) }
          : one))
        return
      }
      const entry: Stored = {
        id: this.#idFor(input.key), key: input.key, scope, goal: input.goal, trigger: input.trigger, kind: input.kind,
        waitingOn: { kind: input.waitingOn.kind, label: clip(input.waitingOn.label, LABEL) },
        sentence: clip(input.sentence, SENTENCE), action: input.action,
        createdAt: now, resolvedAt: now, notification: 'pending', count: 1,
      }
      await this.#save([...this.#entries, entry])
      this.#port.announce(publicOf(entry))
    })
  }

  /** What the desktop answered for one attention: delivered outside the app, or could not be. */
  notified(id: string, status: 'delivered' | 'unavailable'): Promise<boolean> {
    return this.#serial.run(async () => {
      const entry = this.#entries.find((one) => one.id === id)
      if (!entry || entry.notification !== 'pending') return false
      const next = { ...entry, notification: status }
      await this.#save(this.#entries.map((one) => one.id === id ? next : one))
      this.#port.announce(publicOf(next))
      return true
    })
  }

  /** Every unresolved wait again, by its own id — after a start or a reconnect — and nothing new. */
  replay(): void {
    for (const one of this.#entries) if (one.resolvedAt === null) this.#port.announce(publicOf(one))
  }

  /** Resolves once every write queued so far is on the disk. */
  idle(): Promise<void> {
    return this.#serial.run(async () => {})
  }

  /** Whether any wait is still open: a read that copies nothing. */
  get open(): boolean {
    return this.#entries.some((one) => one.resolvedAt === null)
  }

  list(filter: { readonly goal?: string; readonly open?: boolean } = {}): readonly TriggerAttention[] {
    return this.#entries
      .filter((one) => (filter.goal === undefined || one.goal === filter.goal) && (filter.open !== true || one.resolvedAt === null))
      .map(publicOf)
  }
}
