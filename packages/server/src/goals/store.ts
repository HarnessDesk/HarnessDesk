import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Goal, GoalBoard, GoalCitation, GoalId, GoalReceipt, Lane, Plan, SeatId } from '@harnessdesk/protocol'

import type { RememberedMember } from './migration.js'
import type { GoalOperation } from './operations.js'

export interface GoalDocument {
  readonly version: 1
  readonly restored?: { readonly at: number }
  readonly goal: Goal
  readonly board: GoalBoard
  readonly legacy?: {
    readonly source: string
    readonly plans: readonly Plan[]
    readonly nicknames: Readonly<Record<string, string>>
    readonly roster: Readonly<Record<string, RememberedMember>>
    readonly sourceSha256: string
    readonly seatLocations: Readonly<Record<SeatId, 'remembered' | 'inferred'>>
  }
  readonly citations: readonly GoalCitation[]
  readonly receipt: GoalReceipt | null
  readonly operation: GoalOperation | null
}

/** A restored Goal is inert history: its bytes survive, its executable journal does not. */
export function restoredGoal(document: GoalDocument, at: number): GoalDocument {
  return { ...structuredClone(document), restored: { at }, operation: null }
}

/** Imported lanes describe retained history but confer no local port, Seat or profile authority. */
export function restoredLane(lane: Lane): Lane {
  return { ...structuredClone(lane), state: 'released', seat: null, browserProfile: null }
}

export const GOAL_DOCUMENT_LIMIT = 8 * 1024 * 1024

/** Human-readable encoded names where possible; collision-resistant names for long historical ids. */
export const goalFile = (id: string): string => {
  if (!id || id.length > 4096) {
    throw new Error('This Goal id cannot be stored under the current file naming rule. The original file was kept.')
  }
  const encoded = `${encodeURIComponent(id)}.json`
  if (encoded === 'index.json') {
    throw new Error('This Goal id cannot be stored under the current file naming rule. The original file was kept.')
  }
  return Buffer.byteLength(encoded) <= 255
    ? encoded
    : `h-${createHash('sha256').update(id).digest('hex')}.json`
}

export async function syncDirectory(folder: string): Promise<void> {
  const handle = await open(folder, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** A rename may already have landed when its directory sync fails. The caller must stop writing. */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > GOAL_DOCUMENT_LIMIT) {
    throw new Error('This Goal document is larger than 8 MiB. Nothing was written.')
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    await syncDirectory(dirname(file))
  } finally {
    await rm(temporary, { force: true })
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((one) => typeof one === 'string')

const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)

const citationOf = (value: unknown): value is GoalCitation =>
  object(value) && typeof value.goal === 'string' && typeof value.receipt === 'string' &&
  typeof value.project === 'string' && typeof value.path === 'string' && sha(value.at)

const receiptOf = (value: unknown, goal: string, id: unknown): value is GoalReceipt => {
  if (!object(value) || value.version !== 1 || value.goal !== goal || value.id !== id ||
    typeof value.id !== 'string' || typeof value.sentence !== 'string' ||
    !Number.isFinite(value.wrappedAt) || typeof value.summary !== 'string' ||
    !Array.isArray(value.cards) || !strings(value.seats) || !strings(value.evidence) ||
    !Array.isArray(value.answers) || !Array.isArray(value.lanes) ||
    !Array.isArray(value.revisions) || !Array.isArray(value.citations) || !strings(value.gaps)) return false
  if (!value.cards.every((card) => object(card) && Number.isSafeInteger(card.id) && Number(card.id) > 0 &&
    ['finished', 'dropped'].includes(String(card.resolution)) && (card.reason === null || typeof card.reason === 'string'))) return false
  if (!value.answers.every((answer) => object(answer) && typeof answer.seat === 'string' &&
    object(answer.session) && typeof answer.session.runtime === 'string' && typeof answer.session.sessionId === 'string' &&
    (answer.turn === null || typeof answer.turn === 'string') && typeof answer.text === 'string' &&
    typeof answer.partial === 'boolean' && (answer.stopReason === null || typeof answer.stopReason === 'string'))) return false
  if (!value.lanes.every((lane) => object(lane) && typeof lane.lane === 'string' && typeof lane.cwd === 'string' &&
    (lane.dirty === null || typeof lane.dirty === 'boolean') && lane.retained === true)) return false
  if (!value.revisions.every((revision) => object(revision) && typeof revision.cwd === 'string' &&
    (revision.head === null || sha(revision.head)) && (revision.dirty === null || typeof revision.dirty === 'boolean'))) return false
  return value.citations.every(citationOf)
}

/** Refuse a partial or newer document; do not repair it by dropping fields. */
export function documentOf(value: unknown): GoalDocument {
  const bad = (): never => { throw new Error('A Goal document cannot be read. Its original bytes were kept.') }
  if (!object(value) || value.version !== 1 || !object(value.goal) || !object(value.board)) return bad()
  const goal = value.goal
  const board = value.board
  if (
    typeof goal.id !== 'string' || goal.id.length > 4096 || typeof goal.root !== 'string' || typeof goal.cwd !== 'string' ||
    typeof goal.sentence !== 'string' || !goal.sentence.trim() ||
    !['open', 'wrapping', 'wrapped'].includes(String(goal.state)) ||
    !Number.isSafeInteger(goal.revision) || Number(goal.revision) < 0 ||
    !['shared', 'isolated'].includes(String(goal.checkout)) || !strings(goal.dependsOn) ||
    !Number.isFinite(goal.createdAt) || !Number.isFinite(goal.updatedAt) ||
    !object(goal.origin) || !['person', 'legacy', 'flow', 'trigger'].includes(String(goal.origin.kind)) ||
    !(goal.receipt === null || typeof goal.receipt === 'string') ||
    'members' in goal || 'members' in board || 'roles' in board || 'plans' in board ||
    !Number.isSafeInteger(board.nextIntent) || Number(board.nextIntent) < 1 ||
    typeof board.messaging !== 'boolean' || !Array.isArray(board.intents) || !Array.isArray(board.channel) ||
    !Array.isArray(value.citations) || !value.citations.every(citationOf) ||
    !('receipt' in value) || !('operation' in value)
  ) return bad()
  for (const card of board.intents) {
    if (!object(card) || !Number.isSafeInteger(card.id) || Number(card.id) < 1 ||
      typeof card.title !== 'string' || !['open', 'claimed', 'blocked', 'done', 'abandoned'].includes(String(card.state)) ||
      !strings(card.files) || !Array.isArray(card.dependsOn) ||
      !card.dependsOn.every((id) => Number.isSafeInteger(id) && id > 0) ||
      !Number.isFinite(card.createdAt) || !Number.isFinite(card.updatedAt)) return bad()
  }
  for (const entry of board.channel) {
    if (!object(entry) || typeof entry.id !== 'string' || !Number.isFinite(entry.at) ||
      !['message', 'signal', 'notice'].includes(String(entry.kind))) return bad()
    if (entry.kind === 'message' && (typeof entry.text !== 'string' || !object(entry.from) ||
      !['delivered', 'queued', 'held', 'refused', 'shown'].includes(String(entry.state)))) return bad()
  }
  if (value.receipt !== null && !receiptOf(value.receipt, String(goal.id), goal.receipt)) return bad()
  if (value.operation !== null && (!object(value.operation) || value.operation.goal !== goal.id ||
    typeof value.operation.id !== 'string' || !['assignment', 'release', 'wrap'].includes(String(value.operation.kind)))) return bad()
  if (value.operation !== null && value.operation.kind === 'wrap' &&
    (goal.state !== 'wrapping' || !sha(value.operation.stamp) ||
      !receiptOf(value.operation.receipt, String(goal.id), object(value.operation.receipt) ? value.operation.receipt.id : null))) return bad()
  if ((goal.state === 'wrapped') !== (value.receipt !== null) ||
    (value.restored === undefined && (goal.state === 'wrapping') !== (object(value.operation) && value.operation.kind === 'wrap'))) return bad()
  if (value.restored !== undefined && (!object(value.restored) || !Number.isFinite(value.restored.at))) return bad()
  goalFile(goal.id)
  return value as unknown as GoalDocument
}

export interface GoalIndex {
  readonly version: 1
  readonly noticeSeen: boolean
  readonly ids: readonly string[]
}

export function indexOf(value: unknown): GoalIndex {
  if (!object(value) || value.version !== 1 || typeof value.noticeSeen !== 'boolean' ||
    !strings(value.ids) || new Set(value.ids).size !== value.ids.length) {
    throw new Error('The Goal index cannot be read. Its original bytes were kept.')
  }
  value.ids.forEach(goalFile)
  return value as unknown as GoalIndex
}

/** One queue for file writes. The Goal transaction queue never calls itself recursively. */
export class GoalStore {
  readonly #directory: string
  readonly #write: typeof atomicJson
  #documents = new Map<string, GoalDocument>()
  #index: GoalIndex = { version: 1, noticeSeen: true, ids: [] }
  #tail: Promise<void> = Promise.resolve()
  #problem: Error | null = null

  constructor(home: string, write: typeof atomicJson = atomicJson) {
    this.#directory = join(home, 'goals')
    this.#write = write
  }

  get problem(): string | null { return this.#problem?.message ?? null }
  get noticeSeen(): boolean { return this.#index.noticeSeen }

  async load(): Promise<void> {
    const files = await readdir(this.#directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (files === null) {
      throw new Error('The Goal store is not activated. Finish the room upgrade first.')
    }
    const index = indexOf(JSON.parse(await readFile(join(this.#directory, 'index.json'), 'utf8')))
    const documents = new Map<string, GoalDocument>()
    for (const file of files.filter((one) => one.endsWith('.json') && one !== 'index.json').sort()) {
      const path = join(this.#directory, file)
      if ((await stat(path)).size > GOAL_DOCUMENT_LIMIT) throw new Error(`Goal file ${file} is larger than 8 MiB.`)
      const document = documentOf(JSON.parse(await readFile(path, 'utf8')))
      if (goalFile(document.goal.id) !== file || documents.has(document.goal.id)) {
        throw new Error(`Goal file ${file} does not match its id. Its original bytes were kept.`)
      }
      documents.set(document.goal.id, document)
    }
    for (const id of index.ids) {
      if (!documents.has(id)) throw new Error(`The indexed Goal ${id} is missing. The desk was not opened empty.`)
    }
    const recovered: GoalIndex = { ...index, ids: [...documents.keys()].sort() }
    if (JSON.stringify(recovered.ids) !== JSON.stringify([...index.ids].sort())) {
      await this.#persist(join(this.#directory, 'index.json'), recovered)
    }
    this.#documents = documents
    this.#index = recovered
    this.#problem = null
  }

  list(): readonly GoalDocument[] { return [...this.#documents.values()].map((one) => structuredClone(one)) }

  read(id: GoalId): GoalDocument {
    const document = this.#documents.get(id)
    if (!document) throw new Error('That Goal is not on this desk.')
    return structuredClone(document)
  }

  save(document: GoalDocument, expectedRevision: number | null): Promise<void> {
    const copy = structuredClone(document)
    return this.#enqueue(async () => {
      documentOf(copy)
      const current = this.#documents.get(copy.goal.id)
      if (expectedRevision === null ? current !== undefined : current?.goal.revision !== expectedRevision) {
        throw new Error('This Goal changed. Read it again before saving.')
      }
      if (current && (current.goal.id !== copy.goal.id || current.goal.root !== copy.goal.root)) {
        throw new Error('A Goal cannot change its identity or project.')
      }
      if (copy.goal.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) {
        throw new Error('Every Goal change must advance its revision exactly once.')
      }
      if (current?.goal.state === 'wrapped') throw new Error('A wrapped Goal is read-only. Start another Goal for new work.')
      await this.#persist(join(this.#directory, goalFile(copy.goal.id)), copy)
      if (!current) {
        const index: GoalIndex = { ...this.#index, ids: [...this.#index.ids, copy.goal.id].sort() }
        await this.#persist(join(this.#directory, 'index.json'), index)
        this.#index = index
      }
      this.#documents.set(copy.goal.id, copy)
    })
  }

  acknowledgeMigration(): Promise<void> {
    return this.#enqueue(async () => {
      const index: GoalIndex = { ...this.#index, noticeSeen: true }
      await this.#persist(join(this.#directory, 'index.json'), index)
      this.#index = index
    })
  }

  restore(document: GoalDocument, at: number): Promise<'restored' | 'duplicate' | 'conflict'> {
    const imported = restoredGoal(documentOf(structuredClone(document)), at)
    documentOf(imported)
    const canonical = (value: GoalDocument): string => JSON.stringify({ ...value, restored: undefined, operation: null })
    return this.#enqueue(async () => {
      const current = this.#documents.get(imported.goal.id)
      if (current) return canonical(current) === canonical(imported) ? 'duplicate' : 'conflict'
      await this.#persist(join(this.#directory, goalFile(imported.goal.id)), imported)
      const index: GoalIndex = { ...this.#index, ids: [...this.#index.ids, imported.goal.id].sort() }
      await this.#persist(join(this.#directory, 'index.json'), index)
      this.#documents.set(imported.goal.id, imported)
      this.#index = index
      return 'restored'
    })
  }

  #enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      if (this.#problem) throw this.#problem
      return write()
    })
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  async #persist(file: string, value: unknown): Promise<void> {
    try {
      await this.#write(file, value)
    } catch (error) {
      this.#problem = error instanceof Error ? error : new Error(String(error))
      throw this.#problem
    }
  }

  async flush(): Promise<void> {
    await this.#tail
    if (this.#problem) throw this.#problem
  }
}
