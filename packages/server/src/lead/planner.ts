import { leadRefusal } from './controls.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEAD_SCHEDULE_LIMITS, parseLeadMemory, parseLeadSchedule, type LeadMemory, type LeadSchedule, type LeadScheduledTask, type LeadScheduledRun, type LeadAcceptanceContract } from '@harnessdesk/protocol'

const SCHEDULE_FILE = 'schedule.json', MEMORY_FILE = 'memory.json'
const EMPTY_SCHEDULE: LeadSchedule = { version: 1, tasks: [], quiet: null }
const EMPTY_MEMORY: LeadMemory = { version: 1, items: [] }

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
/** Whether a local time falls inside quiet hours; a span that crosses midnight wraps. */
export const leadQuietAt = (schedule: LeadSchedule, at: Date): boolean => {
  if (!schedule.quiet) return false
  const now = at.getHours() * 60 + at.getMinutes(), from = minutesOf(schedule.quiet.from), to = minutesOf(schedule.quiet.to)
  return from === to ? false : from < to ? now >= from && now < to : now >= from || now < to
}
const DAYS: Record<LeadScheduledTask['every'], (day: number) => boolean> = {
  day: () => true, weekdays: day => day >= 1 && day <= 5, mondays: day => day === 1, fridays: day => day === 5,
}
/** The task's time today if today is one of its days and that time has passed; otherwise null. */
const slotToday = (task: LeadScheduledTask, at: Date): number | null => {
  if (!DAYS[task.every](at.getDay())) return null
  const slot = new Date(at); slot.setHours(Number(task.at.slice(0, 2)), Number(task.at.slice(3, 5)), 0, 0)
  return slot.getTime() <= at.getTime() ? slot.getTime() : null
}
/** Coalesce sleeping across slots to the most recent eligible slot. A brand new task
 * begins with today's slot; existing tasks can catch up once after a long sleep. */
export const leadDueTask = (schedule: LeadSchedule, at: Date): { readonly task: LeadScheduledTask; readonly slot: number } | null => {
  if (leadQuietAt(schedule, at)) return null
  for (const task of schedule.tasks) {
    if (!task.enabled) continue
    const date = new Date(at)
    for (let days = 0; days < (task.lastRunAt === null && task.createdAt === undefined ? 1 : 8); days++) {
      const slot = slotToday(task, date)
      if (slot !== null && (task.lastRunAt !== null || task.createdAt === undefined || slot >= task.createdAt) && (task.lastRunAt === null || task.lastRunAt < slot)) return { task, slot }
      date.setDate(date.getDate() - 1); date.setHours(23, 59, 59, 999)
    }
  }
  return null
}

/**
 * The Lead's two small files beside its journal: the timetable and what it
 * keeps between goals. Both are the person's, written whole and atomically;
 * neither grants the Lead anything a goal it opens by hand would not have.
 */
export class LeadPlanner {
  #writes: Promise<unknown> = Promise.resolve()
  constructor(private readonly home: string) {}
  #file(name: string) { return join(this.home, 'lead', name) }
  async #read<T>(name: string, parse: (value: unknown) => T, empty: T): Promise<T> {
    try { return parse(JSON.parse(await readFile(this.#file(name), 'utf8'))) } catch { return empty }
  }
  #write<T>(name: string, value: T): Promise<T> {
    const next = this.#writes.then(async () => {
      await mkdir(join(this.home, 'lead'), { recursive: true, mode: 0o700 })
      const file = this.#file(name), temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
      await rename(temporary, file)
      return value
    })
    this.#writes = next.catch(() => {})
    return next
  }
  readSchedule(): Promise<LeadSchedule> { return this.#read(SCHEDULE_FILE, value => parseLeadSchedule(value), EMPTY_SCHEDULE) }
  #mutate(change: (schedule: LeadSchedule) => LeadSchedule): Promise<LeadSchedule> {
    const next = this.#writes.then(async () => {
      const value = parseLeadSchedule(change(await this.readSchedule()))
      await mkdir(join(this.home, 'lead'), { recursive: true, mode: 0o700 })
      const file = this.#file(SCHEDULE_FILE), temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, file)
      return value
    })
    this.#writes = next.catch(() => {})
    return next
  }
  /** Person edits never forge host run history or an approved contract. Changing
   * the recurring scope drops its approval and returns to ordinary plan cards. */
  writeSchedule(value: LeadSchedule): Promise<LeadSchedule> {
    const parsed = parseLeadSchedule(value)
    return this.#mutate(previous => ({ ...parsed, tasks: parsed.tasks.map(task => {
      const old = previous.tasks.find(one => one.id === task.id)
      const { approved: _approved, perRunCaps: _caps, runs: _runs, createdAt: _created, ...edit } = task
      const preserves = old && old.goal === task.goal && old.project === task.project && old.every === task.every && old.at === task.at
      return { ...edit, lastRunAt: old?.lastRunAt ?? null, ...(!old ? { createdAt: Date.now() } : old.createdAt === undefined ? {} : { createdAt: old.createdAt }), ...(old?.runs ? { runs: old.runs } : {}),
        ...(preserves && old.approved ? { approved: old.approved, perRunCaps: old.perRunCaps } : {}) }
    }) }))
  }
  async markRan(id: string, at: number): Promise<void> {
    await this.#mutate(schedule => ({ ...schedule, tasks: schedule.tasks.map(task => task.id === id ? { ...task, lastRunAt: at } : task) }))
  }
  approveRepeat(id: string, contract: LeadAcceptanceContract, logicalGoalId?: string, now = Date.now()): Promise<LeadSchedule> {
    if (!contract.repeat) throw new Error('lead-repeat-required')
    return this.#mutate(schedule => {
      const existing = schedule.tasks.find(task => task.approved?.contractDigest === contract.digest || task.project === contract.project.path && task.goal === contract.goal && task.every === contract.repeat!.every && task.at === contract.repeat!.at)
      if (existing) return { ...schedule, tasks: schedule.tasks.map(task => task.id !== existing.id ? task : { ...task, approved: { contract, contractDigest: contract.digest }, perRunCaps: contract.caps,
        runs: logicalGoalId ? [...(task.runs ?? []).filter(run => run.logicalGoalId !== logicalGoalId), { slot: task.runs?.find(run => run.logicalGoalId === logicalGoalId)?.slot ?? now, at: now, state: 'started' as const, logicalGoalId }].slice(-12) : task.runs }) }
      return { ...schedule, tasks: [...schedule.tasks, { id, project: contract.project.path, title: contract.goal.slice(0, 80), goal: contract.goal.slice(0, 2000),
        ...contract.repeat!, enabled: true, paused: false, createdAt: now, lastRunAt: now, approved: { contract, contractDigest: contract.digest }, perRunCaps: contract.caps, runs: logicalGoalId ? [{ slot: now, at: now, state: 'started' as const, logicalGoalId }] : [] }] }
    })
  }
  recordRun(id: string, run: LeadScheduledRun): Promise<LeadSchedule> {
    return this.#mutate(schedule => ({ ...schedule, tasks: schedule.tasks.map(task => task.id === id ? { ...task, lastRunAt: Math.max(task.lastRunAt ?? 0, run.slot),
      runs: [...(task.runs ?? []).filter(old => old.slot !== run.slot), run].slice(-12) } : task) }))
  }
  settleRun(logicalGoalId: string, outcome: 'accepted' | 'declined' | 'stopped', usdMicros: number | undefined, rounds: number): Promise<LeadSchedule> {
    return this.#mutate(schedule => ({ ...schedule, tasks: schedule.tasks.map(task => ({ ...task, ...(task.runs ? { runs: task.runs.map(run =>
      run.logicalGoalId === logicalGoalId ? { ...run, outcome, ...(usdMicros === undefined ? {} : { usdMicros: Math.max(run.usdMicros ?? 0, usdMicros) }), rounds } : run) } : {}) })) }))
  }
  control(id: string, action: 'pause' | 'resume' | 'stop'): Promise<LeadSchedule> {
    return this.#mutate(schedule => {
      if (!schedule.tasks.some(task => task.id === id && (action !== 'resume' || task.enabled))) throw leadRefusal('lead-repeat-missing')
      return { ...schedule, tasks: schedule.tasks.map(task => task.id !== id ? task : action === 'stop' ? { ...task, enabled: false, paused: true } :
        action === 'pause' ? { ...task, paused: true } : { ...task, enabled: true, paused: false }) }
    })
  }
  readMemory(): Promise<LeadMemory> { return this.#read(MEMORY_FILE, value => parseLeadMemory(value), EMPTY_MEMORY) }
  writeMemory(value: LeadMemory): Promise<LeadMemory> { return this.#write(MEMORY_FILE, parseLeadMemory(value)) }
  /** A line the Lead offers to keep. It waits for the person's Keep; a line already there, kept or offered, is not offered twice. */
  async suggest(text: string, id: string, at: number): Promise<LeadMemory> {
    const memory = await this.readMemory(), line = text.trim().replace(/\s+/g, ' ').slice(0, 400)
    if (!line || memory.items.some(item => item.text.toLowerCase() === line.toLowerCase())) return memory
    const items = [...memory.items, { id, text: line, state: 'suggested' as const, at }]
    // The cap drops the oldest suggestion first; the person's kept lines stay.
    while (items.length > LEAD_SCHEDULE_LIMITS.memory) {
      const oldest = items.findIndex(item => item.state === 'suggested')
      if (oldest < 0) return memory
      items.splice(oldest, 1)
    }
    return this.writeMemory({ version: 1, items })
  }
  /** The kept lines, numbered as the instructions number them, for a goal's standing text. */
  async kept(): Promise<readonly string[]> { return (await this.readMemory()).items.filter(item => item.state === 'kept').map(item => item.text) }
}
