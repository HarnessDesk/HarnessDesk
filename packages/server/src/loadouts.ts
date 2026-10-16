import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import {
  runtimeId, sessionKey,
  type AgentRuntime, type ConversationLoadout, type LoadoutPart, type RuntimeLoadout,
  type RuntimeLoadoutPart, type RuntimeId, type SeatId, type SessionId,
} from '@harnessdesk/protocol'
import { LoadoutDigests } from './loadout-digests.js'

const PARTS = ['skills', 'mcp', 'memory', 'agents'] as const
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = MAX_RECORD_BYTES * 20
const fileName = (id: string): string => {
  const encoded = encodeURIComponent(id).replace(/\./g, '%2E')
  return Buffer.byteLength(encoded) <= 220 ? encoded : `h-${createHash('sha256').update(id).digest('hex')}`
}
const missing = (what: string): RuntimeLoadoutPart => ({ reported: false, reason: `This agent does not report its ${what}.` })
const unavailable = (reason?: string): RuntimeLoadout => ({
  approximate: false, source: 'not reported',
  skills: reason ? { reported: false, reason } : missing('skills'),
  mcp: reason ? { reported: false, reason } : missing('MCP servers'),
  memory: reason ? { reported: false, reason } : missing('memory files'),
  agents: reason ? { reported: false, reason } : missing('agents'),
})
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string'
const nullableNumber = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const validPart = (part: unknown): boolean => {
  if (!object(part)) return false
  if (part.reported === false) return typeof part.reason === 'string'
  return part.reported === true && Number.isSafeInteger(part.more) && Number(part.more) >= 0 &&
    Array.isArray(part.items) && part.items.length <= 500 && part.items.every(item => object(item) &&
      typeof item.name === 'string' && nullableString(item.group) && nullableString(item.origin) &&
      nullableString(item.pathLabel) && nullableString(item.digest) && nullableNumber(item.tokens) &&
      nullableNumber(item.count) && (item.enabled === null || typeof item.enabled === 'boolean'))
}
const validRecord = (value: unknown): value is ConversationLoadout => object(value) && value.version === 1 &&
  typeof value.runtime === 'string' && typeof value.session === 'string' && nullableString(value.seat) &&
  typeof value.build === 'string' && typeof value.source === 'string' && typeof value.approximate === 'boolean' &&
  Number.isSafeInteger(value.epoch) && Number(value.epoch) >= 0 && typeof value.observedAt === 'number' && Number.isFinite(value.observedAt) &&
  PARTS.every(part => validPart(value[part]))
const sameParts = (a: ConversationLoadout, b: ConversationLoadout): boolean => PARTS.every(part => JSON.stringify(a[part]) === JSON.stringify(b[part]))

/** Immutable epochs, atomically appended/pruned under one owner-only state directory. */
export class LoadoutStore {
  #tail: Promise<void> = Promise.resolve()
  constructor(private readonly folder: string) {}
  #path(runtime: RuntimeId, session: SessionId): string { return join(this.folder, fileName(runtime), `${fileName(session)}.ndjson`) }
  async history(runtime: RuntimeId, session: SessionId): Promise<readonly ConversationLoadout[]> {
    let text: string
    try {
      const handle = await open(this.#path(runtime, session), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { if ((await handle.stat()).size > MAX_FILE_BYTES) throw new Error('Loadout history is too large.'); text = await handle.readFile('utf8') }
      finally { await handle.close() }
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
      throw error
    }
    const records: ConversationLoadout[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { break }
      if (!validRecord(value) || value.runtime !== runtime || value.session !== session || value.epoch <= (records.at(-1)?.epoch ?? -1)) break
      records.push(value)
    }
    return records
  }
  async runtimes(session: SessionId): Promise<RuntimeId[]> {
    let names: string[]
    try { names = await readdir(this.folder) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const matches: RuntimeId[] = []
    for (const name of names) {
      let runtime: RuntimeId
      try { runtime = runtimeId(decodeURIComponent(name)) } catch { continue }
      const history = await this.history(runtime, session)
      if (history.length) matches.push(history[0]!.runtime)
    }
    return matches
  }
  #write(work: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(work)
    this.#tail = run.catch(() => {})
    return run
  }
  async append(input: Omit<ConversationLoadout, 'epoch'>): Promise<void> {
    return this.#write(async () => {
      const old = await this.history(input.runtime, input.session)
      const record: ConversationLoadout = { ...input, epoch: (old.at(-1)?.epoch ?? -1) + 1 }
      if (!validRecord(record)) throw new Error('Invalid conversation loadout.')
      if (old.length && sameParts(old.at(-1)!, record)) return
      if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new Error('Conversation loadout is too large.')
      const records = [...old, record]
      const kept = records.length > 20 ? [records[0]!, ...records.slice(-19)] : records
      await mkdir(this.folder, { recursive: true, mode: 0o700 })
      const path = this.#path(input.runtime, input.session)
      await mkdir(join(this.folder, fileName(input.runtime)), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(kept.map(value => JSON.stringify(value)).join('\n') + '\n'); await handle.sync() }
        finally { await handle.close() }
        await rename(temporary, path)
      } finally { await rm(temporary, { force: true }) }
    })
  }
  forget(runtime: RuntimeId, session: SessionId): Promise<void> { return this.#write(() => rm(this.#path(runtime, session), { force: true })) }
  flush(): Promise<void> { return this.#tail }
}

interface Observation {
  readonly runtime: AgentRuntime
  readonly session: SessionId
  readonly cwd: string
  readonly seat: () => SeatId | null
  readonly generation: number
  firstTurn: boolean
  retry: boolean
  retried: boolean
}

/** The lifecycle port: observe is deliberately synchronous and never holds an open. */
export class LoadoutRecorder {
  readonly #digests = new LoadoutDigests()
  readonly #pending = new Set<Promise<void>>()
  readonly #tails = new Map<string, Promise<void>>()
  readonly #observations = new Map<string, Observation>()
  readonly #generations = new Map<string, number>()
  #closed = false
  constructor(private readonly store: LoadoutStore, private readonly options: { home: string; timeoutMs?: number; log(message: string, error: unknown): void }) {}
  observe(runtime: AgentRuntime, session: SessionId, cwd: string, seat: () => SeatId | null): void {
    if (this.#closed) return
    const key = sessionKey(runtime.info.id, session)
    const observation: Observation = { runtime, session, cwd, seat, generation: this.#generations.get(key) ?? 0, firstTurn: false, retry: false, retried: false }
    this.#observations.set(key, observation)
    this.#start(observation)
  }
  #start(observation: Observation): void {
    const key = sessionKey(observation.runtime.info.id, observation.session)
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(() => this.#capture(observation)).catch(error => this.options.log('Conversation loadout could not be recorded.', error))
    this.#tails.set(key, run)
    this.#pending.add(run)
    void run.then(() => {
      this.#pending.delete(run)
      if (this.#tails.get(key) === run) this.#tails.delete(key)
    })
  }
  async #capture(observation: Observation): Promise<void> {
    const { runtime, session, cwd } = observation
    if ((this.#generations.get(sessionKey(runtime.info.id, session)) ?? 0) !== observation.generation) return
    let report: RuntimeLoadout
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      report = runtime.loadout ? await Promise.race([
        Promise.resolve().then(() => runtime.loadout!(session, cwd)),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('The agent did not report its loadout within 3 seconds.')), this.options.timeoutMs ?? 3000) }),
      ]) : unavailable()
    } catch (error) {
      this.options.log('The agent could not report its conversation loadout.', error)
      report = unavailable(error instanceof Error ? error.message : String(error))
    } finally { clearTimeout(timeout) }
    const key = sessionKey(runtime.info.id, session)
    if ((this.#generations.get(key) ?? 0) !== observation.generation) return
    const budget = this.#digests.record(this.options.home, cwd)
    const label = (path: string): string => {
      for (const [root, prefix] of [[this.options.home, '~'], [cwd, '.']] as const) {
        const rest = relative(root, path)
        if (rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))) return rest ? `${prefix}/${rest.split(sep).join('/')}` : prefix
      }
      return basename(path)
    }
    const partOf = async (name: typeof PARTS[number]): Promise<LoadoutPart> => {
      const part = report[name]
      if (!part.reported) return { reported: false, reason: part.reason }
      const items = []
      for (const item of part.items.slice(0, 500)) {
        items.push({ name: item.name, group: item.group, origin: item.origin,
          pathLabel: name !== 'mcp' && item.path ? label(item.path) : null,
          digest: item.path && (name === 'skills' || name === 'memory') ? await budget.digest(name, item.path) : null,
          tokens: item.tokens, count: item.count, enabled: item.enabled })
      }
      items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      return { reported: true, items, more: part.more + Math.max(0, part.items.length - 500) }
    }
    const skills = await partOf('skills'), mcp = await partOf('mcp'), memory = await partOf('memory'), agents = await partOf('agents')
    if ((this.#generations.get(key) ?? 0) !== observation.generation) return
    await this.store.append({ version: 1, runtime: runtime.info.id, session, seat: observation.seat(), observedAt: Date.now(),
      build: runtime.info.version ?? 'unknown', approximate: report.approximate, source: report.source, skills, mcp, memory, agents })
    observation.retry = PARTS.some(name => !report[name].reported && report[name].notReady === true)
    if (observation.firstTurn) this.#retry(observation)
  }
  #retry(observation: Observation): void {
    if (this.#closed || !observation.retry || observation.retried) return
    observation.retried = true
    this.#start(observation)
  }
  turnCompleted(runtime: RuntimeId, session: SessionId): void {
    const observation = this.#observations.get(sessionKey(runtime, session))
    if (!observation || observation.firstTurn) return
    observation.firstTurn = true
    this.#retry(observation)
  }
  async forget(runtime: RuntimeId, session: SessionId): Promise<void> {
    const key = sessionKey(runtime, session)
    this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1)
    this.#observations.delete(key)
    await this.store.forget(runtime, session)
  }
  async flush(): Promise<void> { while (this.#pending.size) await Promise.all(this.#pending); await this.store.flush() }
  async close(): Promise<void> { this.#closed = true; await this.flush(); this.#observations.clear() }
}
