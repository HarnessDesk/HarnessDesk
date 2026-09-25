import {
  AGAIN_TITLE,
  DEFAULT_FLOW_BUDGET,
  DEFAULT_TRIGGER_BUDGET,
  TRIGGER_DEFAULTS,
  TRIGGER_LABEL_CHARS,
  TRIGGER_LABEL_LIMIT,
  TRIGGER_COMMENT_FROM,
  TRIGGER_SOURCES,
  type FlowBudget,
  type FlowThen,
  type TriggerBudget,
  type TriggerCommentFrom,
  type TriggerDefinition,
  type TriggerDocument,
  type TriggerFact,
  type TriggerField,
  type TriggerOn,
  type TriggerProblem,
  type TriggerSource,
} from '@harnessdesk/protocol'

export { AGAIN_TITLE }

import { parseYaml, YamlError } from '../yaml.js'
import { SCHEDULE_MINUTES_MAX } from './keys.js'

/**
 * The one reader of `.harnessdesk/triggers.yml`.
 *
 * The file arrives with a clone, so this reads exactly one bounded shape and
 * refuses everything else by name — an unknown key at any level (a `command`,
 * an `env`, a `ceiling` a reader might think does something), a duplicate id,
 * a key set twice, an alias, excess nesting, a number that is not finite —
 * and a file with any problem runs nothing. It does no I/O and infers nothing
 * from event text: every default below is the protocol's, the same for every
 * project.
 *
 * The size and nesting bounds are checked *before* the shared recursive YAML
 * reader is asked, so a hostile file cannot make the reader do unbounded work.
 */

export const TRIGGER_FILE_LIMIT = 65536
export const TRIGGER_LINE_LIMIT = 2048
export const TRIGGER_LIMIT = 64
const FIELD_LIMIT = 5
const CONCURRENCY_MAX = 32
const LOOP_MAX = 100
const USD_MIN = 0.01
const USD_MAX = 10000
const HOURS_MIN = 1 / 60
const HOURS_MAX = 168

/** An id, a flow, an Agent or a role: an ASCII slug a path or a shell could never read as anything else. */
export const TRIGGER_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

const ENTRY_KEYS = new Set(['id', 'on', 'events', 'label', 'from', 'opens', 'goal', 'again', 'dedupe', 'concurrency', 'forks', 'budget', 'every'])
const BUDGET_KEYS = new Set(['usd', 'rounds', 'hours', 'without-progress'])
const AGAIN_KEYS = new Set(['role'])

/** The bound that must hold before the shared reader sees the text. Throws a sentence. */
export function checkTriggerText(source: string): void {
  if (Buffer.byteLength(source, 'utf8') > TRIGGER_FILE_LIMIT || source.split('\n').length > TRIGGER_LINE_LIMIT) {
    throw new Error('Triggers must fit in 64 KiB and 2048 lines.')
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(source)) {
    throw new Error('Triggers must be UTF-8 text.')
  }
  let quote: string | null = null
  let depth = 0
  for (const line of source.split(/\r?\n/)) {
    if (/^ {33}/.test(line)) throw new Error('Trigger nesting is too deep.')
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quote !== null) {
        if (quote === '"' && char === '\\') index += 1
        else if (char === quote) quote = null
        continue
      }
      if (char === '#' && (index === 0 || /\s/.test(line[index - 1]!))) break
      if (char === '"' || char === "'") { quote = char; continue }
      if (char === '[' || char === '{') {
        depth += 1
        if (depth > 16) throw new Error('Trigger nesting is too deep.')
      }
      if (char === ']' || char === '}') depth -= 1
      if (depth < 0) throw new Error('A trigger collection closes before it opens.')
      if ((char === '|' || char === '>') && /[:\-]\s*$/.test(line.slice(0, index))) {
        throw new Error('Block scalars are not read in triggers. Use a quoted value.')
      }
    }
    if (quote !== null || depth !== 0) throw new Error('Keep quoted values and inline collections on one line.')
  }
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const FILE_FIX = 'Edit .harnessdesk/triggers.yml so it is one short list of triggers, then commit it.'

/**
 * Reads a triggers file into normalized definitions, or refuses it whole.
 * Never throws for what the file says.
 */
export function parseTriggers(source: string): TriggerDocument {
  const refuse = (problems: TriggerProblem[]): TriggerDocument => ({ definitions: [], problems })
  try {
    checkTriggerText(source)
  } catch (error) {
    return refuse([{ at: 'file', text: (error as Error).message, fix: FILE_FIX }])
  }
  let root: unknown
  try {
    root = parseYaml(source)
  } catch (error) {
    if (error instanceof YamlError) {
      return refuse([{ at: `line ${error.line}`, text: error.message.replace(/^line \d+: /, ''), fix: 'Correct that line, then commit the file.' }])
    }
    return refuse([{ at: 'file', text: 'The triggers file could not be read.', fix: FILE_FIX }])
  }
  if (root === null) return { definitions: [], problems: [] }
  if (!Array.isArray(root)) {
    return refuse([{ at: 'file', text: 'The triggers file is a list, each trigger starting with "- ".', fix: FILE_FIX }])
  }
  if (root.length > TRIGGER_LIMIT) {
    return refuse([{ at: 'file', text: `The file names ${root.length} triggers, and at most ${TRIGGER_LIMIT} triggers are read.`, fix: 'Remove triggers until at most 64 remain.' }])
  }
  const problems: TriggerProblem[] = []
  const definitions: TriggerDefinition[] = []
  const seen = new Set<string>()
  root.forEach((raw, index) => {
    const definition = readEntry(raw, `[${index}]`, problems)
    if (!definition) return
    if (seen.has(definition.id)) {
      problems.push({ at: `[${index}].id`, text: `"${definition.id}" is used twice.`, fix: 'Give every trigger its own id.' })
      return
    }
    seen.add(definition.id)
    definitions.push(definition)
  })
  return problems.length > 0 ? refuse(problems) : { definitions, problems: [] }
}

const slug = (value: unknown, at: string, what: string, problems: TriggerProblem[]): string | null => {
  if (typeof value === 'string' && TRIGGER_SLUG.test(value)) return value
  problems.push({
    at,
    text: `${what} must be 1–64 lowercase letters, digits, dashes or underscores, starting with a letter or digit.`,
    fix: `Rename it, for example "review-pr".`,
  })
  return null
}

const unknownKeys = (record: Record<string, unknown>, allowed: ReadonlySet<string>, at: string, problems: TriggerProblem[]): boolean => {
  let clean = true
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue
    clean = false
    problems.push({
      at: `${at}.${key}`,
      text: `"${key}" is not something a trigger reads, so the file is not run until it is removed.`,
      fix: `Remove "${key}". A trigger says only ${[...allowed].join(', ')}.`,
    })
  }
  return clean
}

/** A nonempty, unique list of at most five words, each from `allowed`. */
const fieldList = <T extends string>(
  value: unknown, at: string, allowed: readonly T[], problems: TriggerProblem[], what: string,
): T[] | null => {
  const fix = `Write ${what} as a list of ${allowed.join(', ')}, each at most once.`
  if (!Array.isArray(value) || value.length === 0 || value.length > FIELD_LIMIT) {
    problems.push({ at, text: `${what} must be a list of one to five values.`, fix })
    return null
  }
  const out: T[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !(allowed as readonly string[]).includes(item)) {
      problems.push({ at, text: `"${String(item)}" is not one of ${allowed.join(', ')} here.`, fix })
      return null
    }
    if (out.includes(item as T)) {
      problems.push({ at, text: `"${item}" is listed twice.`, fix })
      return null
    }
    out.push(item as T)
  }
  return out
}

/**
 * A label name as a trigger or the forge may spell it: 1–50 characters, no
 * control character, no space at either end — exactly what the forge itself
 * keeps — or null. Compared exactly, never as a pattern.
 */
export function labelName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const length = [...value].length
  if (length < 1 || length > TRIGGER_LABEL_CHARS || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

/** `label:` as one name or a short list of distinct names. */
const readLabel = (value: unknown, at: string, problems: TriggerProblem[]): readonly string[] | null => {
  const fix = `Write label: agent-ready, or a list of at most ${TRIGGER_LABEL_LIMIT} label names.`
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.length === 0 || list.length > TRIGGER_LABEL_LIMIT) {
    problems.push({ at, text: `label is one label name or a list of one to ${TRIGGER_LABEL_LIMIT}.`, fix })
    return null
  }
  const out: string[] = []
  for (const item of list) {
    const name = labelName(item)
    if (name === null) {
      problems.push({ at, text: `A label name is 1–${TRIGGER_LABEL_CHARS} characters of text with no line breaks or spaces at either end.`, fix })
      return null
    }
    if (out.includes(name)) {
      problems.push({ at, text: `"${name}" is listed twice.`, fix })
      return null
    }
    out.push(name)
  }
  return out
}

const integer = (value: unknown, at: string, min: number, max: number, problems: TriggerProblem[], what: string): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) return value
  problems.push({ at, text: `${what} must be a whole number from ${min} to ${max}.`, fix: `Write a whole number from ${min} to ${max}.` })
  return null
}

const readBudget = (value: unknown, at: string, problems: TriggerProblem[]): TriggerBudget | null => {
  if (value === undefined) return DEFAULT_TRIGGER_BUDGET
  if (!isMap(value)) {
    problems.push({ at, text: 'budget is a map of usd, rounds, hours and without-progress.', fix: 'Write it as { usd: 5, rounds: 3, hours: 4, without-progress: 2 }.' })
    return null
  }
  const before = problems.length
  unknownKeys(value, BUDGET_KEYS, at, problems)
  let usd = DEFAULT_TRIGGER_BUDGET.usd
  if (value['usd'] !== undefined) {
    const raw = value['usd']
    const cents = typeof raw === 'number' ? raw * 100 : Number.NaN
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < USD_MIN || raw > USD_MAX || Math.abs(cents - Math.round(cents)) > 1e-6) {
      problems.push({ at: `${at}.usd`, text: 'usd must be a number of dollars from 0.01 to 10000, with at most two decimals.', fix: 'Write an amount such as 5 or 2.50.' })
    } else usd = raw
  }
  let hours = DEFAULT_TRIGGER_BUDGET.hours
  if (value['hours'] !== undefined) {
    const raw = value['hours']
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < HOURS_MIN || raw > HOURS_MAX) {
      problems.push({ at: `${at}.hours`, text: 'hours must be a number from one minute (0.0167) to 168.', fix: 'Write a number of hours such as 4 or 0.5.' })
    } else hours = raw
  }
  const rounds = value['rounds'] === undefined ? DEFAULT_TRIGGER_BUDGET.rounds
    : integer(value['rounds'], `${at}.rounds`, 1, LOOP_MAX, problems, 'rounds')
  const withoutProgress = value['without-progress'] === undefined ? DEFAULT_TRIGGER_BUDGET.withoutProgress
    : integer(value['without-progress'], `${at}.without-progress`, 1, LOOP_MAX, problems, 'without-progress')
  if (problems.length > before || rounds === null || withoutProgress === null) return null
  return { usd, rounds, hours, withoutProgress }
}

const SUBJECT: Readonly<Record<TriggerSource, TriggerField>> = { 'pull-request': 'pr', issue: 'issue', schedule: 'slot' }
/** The narrowest dedupe each source accepts: anything less merges facts that are not the same. */
const DEDUPE_FLOOR: Readonly<Record<TriggerSource, readonly TriggerField[]>> = {
  'pull-request': ['pr', 'head'],
  issue: ['issue', 'event'],
  schedule: ['slot'],
}

const readEntry = (raw: unknown, at: string, problems: TriggerProblem[]): TriggerDefinition | null => {
  if (!isMap(raw)) {
    problems.push({ at, text: 'A trigger is a map of settings.', fix: 'Start each trigger with "- id: ..." and indent its settings under it.' })
    return null
  }
  const before = problems.length
  unknownKeys(raw, ENTRY_KEYS, at, problems)
  const id = slug(raw['id'], `${at}.id`, 'A trigger id', problems)
  const sourceName = raw['on']
  const source = typeof sourceName === 'string' && (TRIGGER_SOURCES as readonly string[]).includes(sourceName) ? sourceName as TriggerSource : null
  if (source === null) {
    problems.push({ at: `${at}.on`, text: 'on must be pull-request, issue or schedule.', fix: 'Write on: pull-request, on: issue or on: schedule.' })
    return null
  }
  const defaults = TRIGGER_DEFAULTS[source]

  let events: readonly string[] | null = defaults.events
  if (raw['events'] !== undefined) {
    events = fieldList(raw['events'], `${at}.events`, defaults.events as readonly string[], problems, 'events')
  }

  let label: readonly string[] | undefined
  if (raw['label'] !== undefined) {
    const labelled = raw['events'] !== undefined && events?.length === 1 && events[0] === 'labelled'
    if (source !== 'issue') {
      problems.push({ at: `${at}.label`, text: 'Only an issue trigger reads label.', fix: 'Remove label, or make this trigger on: issue.' })
    } else if (!labelled) {
      problems.push({ at: `${at}.label`, text: 'label chooses which labelled issues fire, so this trigger must say events: [labelled].', fix: 'Add events: [labelled], or remove label.' })
    } else {
      label = readLabel(raw['label'], `${at}.label`, problems) ?? undefined
    }
  }

  let on: TriggerOn | null = null
  if (source === 'schedule') {
    if (raw['every'] === undefined) {
      problems.push({ at: `${at}.every`, text: 'A schedule needs every: the minutes between its firings.', fix: 'Add every: 60 (any whole number of minutes from 1 to 10080).' })
    } else {
      const every = integer(raw['every'], `${at}.every`, 1, SCHEDULE_MINUTES_MAX, problems, 'every')
      if (every !== null) on = { kind: 'schedule', events: ['tick'], everyMinutes: every }
    }
  } else {
    if (raw['every'] !== undefined) {
      problems.push({ at: `${at}.every`, text: 'Only a schedule reads every.', fix: 'Remove every, or make this trigger on: schedule.' })
    }
    if (events) {
      on = source === 'pull-request'
        ? { kind: 'pull-request', events: events as readonly ('opened' | 'pushed')[] }
        : { kind: 'issue', events: events as readonly ('labelled' | 'closed' | 'commented')[] }
    }
  }

  let opens: TriggerDefinition['opens'] | null = null
  const target = raw['opens']
  if (!isMap(target) || Object.keys(target).length !== 1 || !('flow' in target || 'agent' in target)) {
    problems.push({ at: `${at}.opens`, text: 'opens names exactly one flow or one Agent.', fix: 'Write opens: { flow: review-pr } or opens: { agent: triager }.' })
  } else if ('flow' in target) {
    const flow = slug(target['flow'], `${at}.opens.flow`, 'A flow id', problems)
    if (flow) opens = { flow }
  } else {
    const agent = slug(target['agent'], `${at}.opens.agent`, 'An Agent id', problems)
    if (agent) opens = { agent }
  }

  const subject = SUBJECT[source]
  let goal: readonly TriggerField[] | null = defaults.goal
  if (raw['goal'] !== undefined) {
    goal = fieldList(raw['goal'], `${at}.goal`, defaults.fields, problems, 'goal')
    if (goal && !goal.includes(subject)) {
      problems.push({ at: `${at}.goal`, text: `goal must include ${subject}: a Goal is about one ${subject === 'slot' ? 'slot' : subject === 'pr' ? 'pull request' : 'issue'}.`, fix: `Add ${subject} to goal.` })
      goal = null
    }
  }
  let dedupe: readonly TriggerField[] | null = defaults.dedupe
  if (raw['dedupe'] !== undefined) {
    dedupe = fieldList(raw['dedupe'], `${at}.dedupe`, defaults.fields, problems, 'dedupe')
    const floor = DEDUPE_FLOOR[source]
    if (dedupe && !floor.every((field) => dedupe!.includes(field))) {
      problems.push({ at: `${at}.dedupe`, text: `dedupe must include ${floor.join(' and ')}, or two different facts would be one firing.`, fix: `Add ${floor.filter((field) => !dedupe!.includes(field)).join(' and ')} to dedupe.` })
      dedupe = null
    }
  }

  let again: FlowThen | null = null
  if (raw['again'] !== undefined && raw['again'] !== null) {
    if (source === 'schedule') {
      problems.push({ at: `${at}.again`, text: 'Each schedule slot opens its own Goal, so again has nothing to continue.', fix: 'Remove again from this schedule.' })
    } else if (!isMap(raw['again'])) {
      problems.push({ at: `${at}.again`, text: 'again names the role a later firing opens.', fix: 'Write again: { role: reviewer }.' })
    } else if (unknownKeys(raw['again'], AGAIN_KEYS, `${at}.again`, problems)) {
      const role = slug(raw['again']['role'], `${at}.again.role`, 'A role', problems)
      if (role) again = { role, title: AGAIN_TITLE, detail: null }
    }
  }

  const concurrency = raw['concurrency'] === undefined ? 1 : integer(raw['concurrency'], `${at}.concurrency`, 1, CONCURRENCY_MAX, problems, 'concurrency')

  let forks: 'never' | 'allow' = 'never'
  if (raw['forks'] !== undefined) {
    if (source !== 'pull-request') {
      problems.push({ at: `${at}.forks`, text: 'Only a pull-request trigger reads forks.', fix: 'Remove forks from this trigger.' })
    } else if (raw['forks'] === 'never' || raw['forks'] === 'allow') forks = raw['forks']
    else problems.push({ at: `${at}.forks`, text: 'forks is never or allow.', fix: 'Write forks: never or forks: allow.' })
  }

  // Whose comments fire it: only a trigger that reads comments says, and it is `me` unless the file chooses otherwise.
  const comments = on?.kind === 'issue' && (on.events as readonly string[]).includes('commented')
  let from: TriggerCommentFrom | undefined = comments ? 'me' : undefined
  if (raw['from'] !== undefined) {
    if (!comments) {
      problems.push({ at: `${at}.from`, text: 'Only an issue trigger that reads comments says whose comments fire it.', fix: 'Remove from, or add commented to this issue trigger’s events.' })
    } else if (typeof raw['from'] === 'string' && (TRIGGER_COMMENT_FROM as readonly string[]).includes(raw['from'])) {
      from = raw['from'] as TriggerCommentFrom
    } else {
      problems.push({ at: `${at}.from`, text: 'from is me, collaborators or anyone.', fix: 'Write from: me (your own comments), from: collaborators, or from: anyone.' })
    }
  }

  const budget = readBudget(raw['budget'], `${at}.budget`, problems)
  if (problems.length > before || !id || !on || !opens || !goal || !dedupe || concurrency === null || !budget) return null
  return { id, on, opens, goal, again, dedupe, concurrency, forks, budget, ...(label ? { label } : {}), ...(from ? { from } : {}) }
}

/**
 * Whether a definition reads a fact at all: its source, one of its events,
 * and — when it names labels — a labelled event whose label is exactly one of
 * them. A fact with no readable label matches no label filter.
 */
export function acceptsFact(definition: TriggerDefinition, fact: TriggerFact): boolean {
  if (definition.on.kind !== fact.source || !(definition.on.events as readonly string[]).includes(fact.action)) return false
  if (definition.label === undefined) return true
  return fact.action === 'labelled' && typeof fact.label === 'string' && definition.label.includes(fact.label)
}

/**
 * `opens: { agent }` as the ordinary new-format flow it stands for: one role,
 * `worker`, using that Agent under a read grant, its answers the Agent's own,
 * and no rule — so nothing downstream special-cases which Agent it is. The id
 * is a validated slug, so it is written into the document verbatim.
 */
export function agentFlowSource(agent: string): string {
  if (!TRIGGER_SLUG.test(agent)) throw new Error('An Agent id must be a lowercase slug.')
  return [
    'version: 2',
    `name: "${agent}"`,
    'roles:',
    `  worker: { kind: agent, uses: ["${agent}"], grant: read }`,
    'seed: { role: worker, title: "Do this work" }',
    '',
  ].join('\n')
}

/** The loop limits a trigger's Goal runs under: the narrower of the trigger's and the flow's, defaults included. */
export function effectiveBudget(trigger: TriggerBudget, flow: FlowBudget | undefined): FlowBudget {
  const own = flow ?? DEFAULT_FLOW_BUDGET
  return { rounds: Math.min(trigger.rounds, own.rounds), withoutProgress: Math.min(trigger.withoutProgress, own.withoutProgress) }
}

/** Dollars to integer micros, where money is accounted: never a floating sum. */
export function usdMicros(usd: number): number {
  return Math.round(usd * 100) * 10_000
}
