import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import type { Goal, Intent, Plan, SeatRecord, TeamEntry } from '@harnessdesk/protocol'

import type { SeatOpening } from '../evidence/records.js'
import { atomicJson, documentOf, goalFile, GoalStore, syncDirectory, type GoalDocument } from './store.js'

export interface RememberedMember {
  readonly title: string | null
  readonly agent: string
  readonly cwd: string
  readonly model?: string | null
  readonly at: number
}

export interface LegacyRoom {
  readonly version: 1
  readonly id?: string
  readonly root?: string
  readonly cwd?: string
  readonly name?: string
  readonly updatedAt?: number
  readonly members?: readonly string[]
  readonly nicknames?: Readonly<Record<string, string>>
  readonly roles?: Readonly<Record<string, string>>
  readonly roster?: Readonly<Record<string, RememberedMember>>
  readonly plans?: readonly Plan[]
  readonly nextPlan?: number
  readonly nextIntent: number
  readonly messaging: boolean
  readonly intents: readonly Intent[]
  readonly channel: readonly TeamEntry[]
}

export interface MigrationSeat {
  id: string
  board: string
  runtime: string
  sessionId: string
  cwd: string
  project: string
  role: string | null
  openedAt: number
  name: string
  cwdKnown: boolean
  seatLabel: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const failure = (file: string, what: string): never => {
  throw new Error(`Cannot read ${what} in ${file}; the old file was kept.`)
}

export function convertRoom(file: string, value: unknown, source?: string): {
  goal: Goal
  seats: MigrationSeat[]
  board: GoalDocument['board']
  legacy: NonNullable<GoalDocument['legacy']>
} {
  if (!file.endsWith('.json') || !object(value) || value.version !== 1 ||
    !Array.isArray(value.channel) || !Array.isArray(value.intents) ||
    !Number.isSafeInteger(value.nextIntent) || Number(value.nextIntent) < 1 ||
    typeof value.messaging !== 'boolean') return failure(file, 'the room')
  const raw = value as unknown as LegacyRoom
  let encoded: string
  try {
    encoded = decodeURIComponent(file.slice(0, -5))
  } catch {
    return failure(file, 'the filename')
  }
  const id = raw.id ?? encoded
  const root = raw.root ?? encoded
  const cwd = raw.cwd ?? root
  if (typeof id !== 'string' || id.length > 4096 || typeof root !== 'string' || typeof cwd !== 'string' ||
    !isAbsolute(root) || !isAbsolute(cwd)) return failure(file, 'the location')
  goalFile(id)
  for (const field of ['nicknames', 'roles', 'roster'] as const) {
    if (raw[field] !== undefined && !object(raw[field])) return failure(file, field)
  }
  for (const words of [raw.nicknames ?? {}, raw.roles ?? {}]) {
    if (Object.values(words).some((word) => typeof word !== 'string')) return failure(file, 'member words')
  }
  for (const remembered of Object.values(raw.roster ?? {})) {
    if (!object(remembered) || typeof remembered.cwd !== 'string' || !isAbsolute(remembered.cwd) ||
      typeof remembered.agent !== 'string' || !Number.isFinite(remembered.at) ||
      !(remembered.title === null || typeof remembered.title === 'string')) return failure(file, 'the roster')
  }
  const plans = raw.plans ?? []
  if (!Array.isArray(plans) || plans.some((plan) => !object(plan) || !Number.isSafeInteger(plan.id) ||
    typeof plan.goal !== 'string' || !['running', 'wrapped'].includes(String(plan.state)) ||
    !Number.isFinite(plan.createdAt) ||
    !(plan.wrappedAt == null || Number.isFinite(plan.wrappedAt)))) return failure(file, 'Plans')
  const order = (a: Plan, b: Plan): number => b.createdAt - a.createdAt || b.id - a.id
  const selected = plans.filter((plan) => plan.state === 'running').sort(order)[0] ?? [...plans].sort(order)[0]
  if (raw.name !== undefined && typeof raw.name !== 'string') return failure(file, 'the name')
  const sentence = selected?.goal.trim() || raw.name?.trim() || basename(root) || 'Imported work'
  const stamps = [0, ...raw.channel.map((entry) => entry.at),
    ...raw.intents.flatMap((card) => [card.createdAt, card.updatedAt]),
    ...plans.flatMap((plan) => [plan.createdAt, plan.wrappedAt ?? 0])]
  if (stamps.some((at) => !Number.isFinite(at))) return failure(file, 'timestamps')
  const updatedAt = raw.updatedAt ?? Math.max(...stamps)
  if (!Number.isFinite(updatedAt)) return failure(file, 'activity')
  const goal: Goal = {
    id, root, cwd, sentence, state: 'open', revision: 0, checkout: 'shared', dependsOn: [],
    origin: { kind: 'legacy', source: file },
    createdAt: Math.min(updatedAt, ...plans.map((plan) => plan.createdAt)),
    updatedAt, receipt: null,
  }
  const memberKeys = raw.members ?? Object.keys(raw.nicknames ?? {})
  if (!Array.isArray(memberKeys) || memberKeys.some((key) => typeof key !== 'string')) return failure(file, 'members')
  const seats = [...new Set(memberKeys)].map((key): MigrationSeat => {
    const parts = key.split('\u0000')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return failure(file, 'a member')
    const remembered = raw.roster?.[key]
    return {
      id: `legacy-${createHash('sha256').update(JSON.stringify([id, key])).digest('hex')}`,
      board: id,
      runtime: parts[0],
      sessionId: parts[1],
      cwd: remembered?.cwd ?? cwd,
      project: root,
      role: raw.roles?.[key] ?? null,
      openedAt: remembered?.at ?? updatedAt,
      name: raw.nicknames?.[key] ?? remembered?.title ?? remembered?.agent ?? 'Conversation',
      cwdKnown: remembered !== undefined,
      seatLabel: remembered ? [remembered.agent, remembered.model].filter(Boolean).join(' · ') : parts[0],
    }
  })
  const board = {
    nextIntent: raw.nextIntent,
    messaging: raw.messaging,
    intents: raw.intents.map((card) => ({ ...card, files: card.files ?? [], dependsOn: card.dependsOn ?? [] })),
    channel: raw.channel,
  }
  const legacy: NonNullable<GoalDocument['legacy']> = {
    source: file,
    plans,
    nicknames: raw.nicknames ?? {},
    roster: raw.roster ?? {},
    sourceSha256: createHash('sha256').update(source ?? JSON.stringify(value)).digest('hex'),
    seatLocations: Object.fromEntries(seats.map((seat) => [seat.id, seat.cwdKnown ? 'remembered' : 'inferred'])),
  }
  documentOf({ version: 1, goal, board, legacy, citations: [], receipt: null, operation: null })
  return { goal, board, seats, legacy }
}

export function migrationOpening(seat: MigrationSeat): SeatOpening {
  return {
    id: seat.id,
    agent: null,
    briefDigest: null,
    seat: { runtime: seat.runtime },
    seatLabel: seat.seatLabel,
    passedOver: [],
    standing: { kind: 'unknown' },
    ceiling: null,
    checkout: { cwd: seat.cwd, project: seat.project, branch: null, head: null },
    session: { runtime: seat.runtime, sessionId: seat.sessionId },
    board: seat.board,
    role: seat.role,
    openedAt: seat.openedAt,
  }
}

export async function importMigrationSeats(
  seats: readonly MigrationSeat[],
  book: {
    all(): readonly SeatRecord[]
    importOpening(project: string, opening: SeatOpening): Promise<SeatRecord>
  },
): Promise<void> {
  for (const wanted of seats) {
    const matches = book.all().filter((one) => !one.closed && !one.restored &&
      one.board === wanted.board && one.session.runtime === wanted.runtime && one.session.sessionId === wanted.sessionId)
    if (matches.length > 1) throw new Error(`Two kept Seats name one member of ${wanted.board}. Repair the evidence before upgrading.`)
    if (matches.length === 1) continue
    await book.importOpening(wanted.project, migrationOpening(wanted))
  }
}

export async function migrateDesk(
  home: string,
  importSeats: (seats: MigrationSeat[]) => Promise<void>,
  beforeActivate: () => Promise<void> = async () => {},
): Promise<'migrated' | 'existing'> {
  const target = join(home, 'goals')
  const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    const store = new GoalStore(home)
    await store.load()
    return 'existing'
  }
  const source = join(home, 'team')
  const names = await readdir(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const converted: ReturnType<typeof convertRoom>[] = []
  const ids = new Map<string, string>()
  const owners = new Map<string, string>()
  for (const name of names.filter((one) => one.endsWith('.json') && one !== 'inbound.json').sort()) {
    const text = await readFile(join(source, name), 'utf8')
    const room = convertRoom(name, JSON.parse(text), text)
    const duplicate = ids.get(room.goal.id)
    if (duplicate) throw new Error(`Rooms ${duplicate} and ${name} have one id. Both files were kept.`)
    ids.set(room.goal.id, name)
    for (const seat of room.seats) {
      const key = JSON.stringify([seat.runtime, seat.sessionId])
      const owner = owners.get(key)
      if (owner) throw new Error(`Rooms ${owner} and ${name} hold one conversation. Both files were kept.`)
      owners.set(key, name)
    }
    converted.push(room)
  }
  const staging = join(home, `goals.pending-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    for (const room of converted) {
      const document: GoalDocument = {
        version: 1, goal: room.goal, board: room.board, legacy: room.legacy,
        citations: [], receipt: null, operation: null,
      }
      await atomicJson(join(staging, goalFile(room.goal.id)), document)
    }
    await atomicJson(join(staging, 'index.json'), {
      version: 1, noticeSeen: converted.length === 0, ids: [...ids.keys()].sort(),
    })
    await importSeats(converted.flatMap((room) => room.seats))
    await beforeActivate()
    await syncDirectory(staging)
    await rename(staging, target)
    await syncDirectory(home)
    return 'migrated'
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
