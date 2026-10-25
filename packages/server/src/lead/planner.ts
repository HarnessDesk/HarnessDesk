import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LEAD_SCHEDULE_LIMITS, parseLeadMemory, parseLeadSchedule, type LeadMemory, type LeadSchedule, type LeadScheduledTask } from '@harnessdesk/protocol'

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
/** The first enabled task whose slot today has come and that has not run since; quiet hours hold every one. */
export const leadDueTask = (schedule: LeadSchedule, at: Date): { readonly task: LeadScheduledTask; readonly slot: number } | null => {
  if (leadQuietAt(schedule, at)) return null
  for (const task of schedule.tasks) {
    const slot = task.enabled ? slotToday(task, at) : null
    if (slot !== null && (task.lastRunAt === null || task.lastRunAt < slot)) return { task, slot }
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
  /** The person's edit; when a task last ran is the host's to say, so an edit keeps the recorded time. */
  async writeSchedule(value: LeadSchedule): Promise<LeadSchedule> {
    const previous = await this.readSchedule(), parsed = parseLeadSchedule(value)
    const ran = new Map(previous.tasks.map(task => [task.id, task.lastRunAt]))
    return this.#write(SCHEDULE_FILE, { ...parsed, tasks: parsed.tasks.map(task => ({ ...task, lastRunAt: ran.get(task.id) ?? null })) })
  }
  async markRan(id: string, at: number): Promise<void> {
    const schedule = await this.readSchedule()
    await this.#write(SCHEDULE_FILE, { ...schedule, tasks: schedule.tasks.map(task => task.id === id ? { ...task, lastRunAt: at } : task) })
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
