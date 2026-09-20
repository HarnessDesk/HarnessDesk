import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { lanePreferences, type Lane, type LanePreferences } from '@harnessdesk/protocol'
import { Serial } from './assignments.js'
import { atomicJson } from './store.js'

export { lanePreferences }
export type { Lane, LanePreferences }

const NO_BLOCK = 'No lane port block is free. Release a retained lane or change Workspaces › Lanes; no Seat was opened.'
const DEADLINE = 'The lane port scan took five seconds. Release a retained lane or change Workspaces › Lanes; no Seat was opened.'

export function firstBlock(prefs: LanePreferences, leases: readonly Lane[]): Lane['ports'] | null {
  lanePreferences(prefs)
  for (let start = prefs.start; start + prefs.width - 1 <= 65535; start += prefs.width) {
    const end = start + prefs.width - 1
    if (!leases.some((lane) => lane.state !== 'released' && start <= lane.ports.end && lane.ports.start <= end)) return { start, end }
  }
  return null
}

export function laneEnvironment(lane: Lane): Readonly<Record<string, string>> {
  if (lane.state === 'released') throw new Error('This lane’s ports were released. Allocate a new lane before reopening its conversation.')
  if (lane.state === 'reserved' || !lane.cwd) throw new Error('This lane is not ready. Review its retained reservation first.')
  return {
    HARNESSDESK_GOAL_ID: lane.goal, HARNESSDESK_LANE_ID: lane.id,
    HARNESSDESK_PORT_START: String(lane.ports.start), HARNESSDESK_PORT_END: String(lane.ports.end),
    HARNESSDESK_PORT_COUNT: String(lane.ports.end - lane.ports.start + 1), PORT: String(lane.ports.start),
  }
}

export interface LanePort {
  list(): readonly Lane[]
  save(lane: Lane): Promise<void>
  available(ports: Lane['ports'], deadline: number): Promise<boolean>
  create(id: string, goal: string): Promise<{ cwd: string; branch: string }>
  locate?(lane: Lane): Promise<{ cwd: string; branch: string } | null>
  active(lane: Lane): boolean
  busy(lane: Lane): boolean
}

export class LaneAllocator {
  readonly #serial = new Serial()
  constructor(private readonly port: LanePort, private readonly now: () => number = Date.now) {}
  list(): readonly Lane[] { return this.port.list().map((lane) => structuredClone(lane)) }
  listLanes(): readonly Lane[] { return this.list() }
  forSeat(seat: string): Lane | null { return this.list().find((lane) => lane.seat === seat) ?? null }

  allocate(goal: string, id: string, prefs: LanePreferences): Promise<Lane> {
    return this.#serial.run(async () => {
      lanePreferences(prefs)
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error('The host did not name a lane.')
      if (!goal || goal.length > 4096) throw new Error('Choose an existing Goal.')
      if (this.port.list().some((lane) => lane.id === id)) throw new Error('This lane is already recorded. Review its retained allocation.')
      const deadline = this.now() + 5000
      const rejected: Lane[] = []
      for (;;) {
        if (this.now() >= deadline) throw new Error(DEADLINE)
        const ports = firstBlock(prefs, [...this.port.list(), ...rejected])
        if (!ports) throw new Error(NO_BLOCK)
        const reservation: Lane = { id, goal, seat: null, cwd: '', branch: '', ports,
          browserProfile: prefs.browserProfile ? `lane-${randomUUID()}` : null, state: 'reserved', createdAt: this.now() }
        const available = await this.port.available(ports, deadline)
        if (this.now() >= deadline) throw new Error(DEADLINE)
        if (!available) { rejected.push(reservation); continue }
        await this.port.save(reservation)
        let result = reservation
        try {
          const checkout = await this.port.create(id, goal)
          result = { ...reservation, ...checkout, state: 'active' }
          await this.port.save(result)
          return structuredClone(result)
        } catch (error) {
          try { await this.port.save({ ...result, state: 'retained' }) }
          catch (retention) { throw new AggregateError([error, retention], `Lane ${id} could not finish or record its retained state. Its reservation and any checkout were kept.`) }
          throw error
        }
      }
    })
  }

  bind(id: string, seat: string): Promise<void> { return this.#serial.run(async () => {
    const lane = this.#read(id); if (lane.seat === seat) return
    if (lane.seat !== null) throw new Error('This lane already belongs to another Seat.')
    if (lane.state !== 'active') throw new Error('Only a ready lane can be bound to a Seat.')
    if (this.port.list().some((one) => one.seat === seat)) throw new Error('This Seat already has a lane.')
    await this.port.save({ ...lane, seat })
  }) }

  retain(id: string): Promise<void> { return this.#serial.run(async () => {
    const lane = this.#read(id); if (lane.state === 'retained' || lane.state === 'released') return
    await this.port.save({ ...lane, state: 'retained' })
  }) }

  release(id: string): Promise<Lane> { return this.#serial.run(async () => {
    const lane = this.#read(id); if (lane.state === 'released') return structuredClone(lane)
    if (this.port.active(lane)) throw new Error('Release this lane’s active Seat before releasing its ports.')
    if (this.port.busy(lane)) throw new Error('Wait for this conversation to finish its turn before releasing its ports.')
    if (!await this.port.available(lane.ports, this.now() + 5000)) throw new Error('A port in this lane is still in use. Stop its server before releasing the ports.')
    const released: Lane = { ...lane, state: 'released' }; await this.port.save(released); return structuredClone(released)
  }) }

  recover(seats: readonly { id: string; board: string | null; closed: unknown; restored?: unknown; checkout: { cwd: string } }[]): Promise<void> {
    return this.#serial.run(async () => {
      for (const saved of this.port.list()) {
        if (saved.state === 'released') continue
        const found = saved.cwd ? null : await this.port.locate?.(saved)
        const lane = found ? { ...saved, ...found } : saved
        const matching = seats.filter((seat) => !seat.restored && !seat.closed && seat.board === lane.goal && lane.cwd !== '' && seat.checkout.cwd === lane.cwd)
        if (matching.length > 1 || lane.seat !== null && matching.some((seat) => seat.id !== lane.seat)) throw new Error('A lane has conflicting Seat ownership. Repair it before dispatching work.')
        const seat = matching[0]?.id ?? lane.seat
        await this.port.save({ ...lane, seat, state: matching.length === 1 ? 'active' : 'retained' })
      }
    })
  }
  #read(id: string): Lane { const lane = this.port.list().find((one) => one.id === id); if (!lane) throw new Error('This lane was not found. Read the Goal again.'); return lane }
}

export function laneOf(value: unknown): Lane {
  const bad = (): never => { throw new Error('The lane registry cannot be read. Its bytes and port ownership were kept.') }
  if (typeof value !== 'object' || value === null) return bad()
  const lane = value as Lane
  if (typeof lane.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(lane.id) || typeof lane.goal !== 'string' || !lane.goal || lane.goal.length > 4096 ||
      !(lane.seat === null || typeof lane.seat === 'string' && lane.seat.length > 0 && lane.seat.length <= 200) || typeof lane.cwd !== 'string' || typeof lane.branch !== 'string' ||
      !['reserved', 'active', 'retained', 'released'].includes(lane.state) || !Number.isSafeInteger(lane.createdAt) || lane.createdAt < 0 ||
      !(lane.browserProfile === null || typeof lane.browserProfile === 'string' && /^lane-[a-f0-9-]{36}$/.test(lane.browserProfile)) || !lane.ports) return bad()
  try { lanePreferences({ start: lane.ports.start, width: lane.ports.end - lane.ports.start + 1, browserProfile: true }) } catch { return bad() }
  if (lane.state === 'active' && (!lane.cwd || !lane.branch)) return bad()
  return structuredClone(lane)
}

export class LaneStore {
  readonly #file: string; readonly #serial = new Serial(); #lanes: Lane[] = []; #loaded = false
  constructor(home: string, private readonly write: typeof atomicJson = atomicJson) { this.#file = join(home, 'lanes', 'index.json') }
  async load(): Promise<void> {
    let raw: string
    try { raw = await readFile(this.#file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.#loaded = true; return }
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('The lane registry is larger than 8 MiB.')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1 || !Array.isArray((parsed as { lanes?: unknown }).lanes)) throw new Error('The lane registry version cannot be read. Update the desk before allocating a lane.')
    const lanes = (parsed as { lanes: unknown[] }).lanes.map(laneOf); const ids = new Set<string>(); const seats = new Set<string>(); const intervals: Lane[] = []
    for (const lane of lanes) {
      if (ids.has(lane.id) || lane.seat !== null && seats.has(lane.seat)) throw new Error('The lane registry names an owner twice. Repair it before allocating a lane.')
      ids.add(lane.id); if (lane.seat !== null) seats.add(lane.seat); if (lane.state === 'released') continue
      if (intervals.some((one) => lane.ports.start <= one.ports.end && one.ports.start <= lane.ports.end)) throw new Error('The lane registry has overlapping port leases. Repair it before allocating a lane.')
      intervals.push(lane)
    }
    this.#lanes = lanes; this.#loaded = true
  }
  get loaded(): boolean { return this.#loaded }
  list(): readonly Lane[] { if (!this.#loaded) throw new Error('Read the lane registry before allocating a lane.'); return this.#lanes.map((lane) => structuredClone(lane)) }
  save(lane: Lane): Promise<void> { return this.#serial.run(async () => {
    this.list(); const next = [...this.#lanes.filter((one) => one.id !== lane.id), laneOf(lane)]
    await mkdir(join(this.#file, '..'), { recursive: true }); await this.write(this.#file, { version: 1, lanes: next }); this.#lanes = next
  }) }
}

export async function availablePorts(ports: Lane['ports'], deadline: number): Promise<boolean> {
  const held: ReturnType<typeof createServer>[] = []
  try {
    for (let port = ports.start; port <= ports.end; port++) for (const host of ['127.0.0.1', '::1']) {
      if (Date.now() >= deadline) throw new Error(DEADLINE)
      const server = createServer(); held.push(server)
      const free = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => { server.close(); reject(new Error(DEADLINE)) }, Math.max(1, deadline - Date.now()))
        server.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); if (error.code === 'EADDRINUSE') resolve(false); else if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code ?? '')) resolve(true); else reject(error) })
        server.listen({ host, port, exclusive: true, ipv6Only: host === '::1' }, () => { clearTimeout(timer); resolve(true) })
      })
      if (!free) return false
    }
    return true
  } finally { await Promise.all(held.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) }
}
