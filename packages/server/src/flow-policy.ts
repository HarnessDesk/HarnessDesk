import {
  DEFAULT_FLOW_BUDGET,
  isCeilingLevel,
  narrower,
  reaches as ceilingReaches,
  type AgentDefinition,
  type AgentEntry,
  type CeilingLevel,
  type CompiledFlow,
  type FlowAgentRole,
  type FlowBinding,
  type FlowBudget,
  type FlowCheck,
  type FlowDocument,
  type FlowEvidenceGuard,
  type FlowInput,
  type FlowPolicy,
  type FlowPolicyRole,
  type FlowPolicyRule,
  type FlowProblem,
  type FlowSeat,
  type FlowThen,
} from '@harnessdesk/protocol'

import { asList, asRecord, asText, parseFlow, parseSeatList, problem, seatSpec, seatWritesCompactly } from './flow.js'
import { parseYaml, YamlError } from './yaml.js'

const SOURCE_LIMIT = 256 * 1024
const ROLE_LIMIT = 64
const RULE_LIMIT = 256
const SLOT_LIMIT = 32
const COMPILED_SLOT_LIMIT = 1024
const DEFAULT_WAIT = 240
const DEFAULT_TIMEOUT = 900
const DEFAULT_REARM = 3
const REARM_LIMIT = 120

const ROOT_FIELDS = new Set(['version', 'name', 'description', 'inputs', 'roles', 'rules', 'seed', 'messaging', 'wait', 'rearm', 'budget', 'layout'])
const BUDGET_FIELDS = new Set(['rounds', 'without-progress'])
/** The most rounds a budget may name, either key. */
const BUDGET_LIMIT = 100
const AGENT_FIELDS = new Set(['kind', 'uses', 'seats', 'count', 'isolate', 'grant', 'independentOf', 'blind'])
const CHECK_FIELDS = new Set(['kind', 'check', 'run', 'exits', 'otherwise', 'timeout', 'cwd'])
const CHECK_VALUE_FIELDS = new Set(['run', 'exits', 'otherwise', 'timeout', 'cwd'])
const PERSON_FIELDS = new Set(['kind', 'outcomes'])
const RULE_FIELDS = new Set(['id', 'on', 'when', 'then'])
const THEN_FIELDS = new Set(['role', 'title', 'detail', 'files', 'split'])
const WHEN_FIELDS = new Set(['every', 'any', 'evidence'])

export interface SlotInput {
  readonly uses: readonly string[]
  readonly seats: readonly string[]
  readonly count?: number
}

export interface Slot {
  readonly agent: string
  readonly seat: string | null
  readonly index: number
}

/** Expand one role without turning two lists into a hidden Cartesian product. */
export const expandSlots = (input: SlotInput): Slot[] => {
  const { uses, seats, count } = input
  if (uses.length === 0 || uses.length > SLOT_LIMIT || seats.length > SLOT_LIMIT) {
    throw new Error('A round needs between 1 and 32 Agents or seats.')
  }
  if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > SLOT_LIMIT)) {
    throw new Error('Count must be a whole number from 1 to 32.')
  }
  if (uses.length > 1 && seats.length > 1) throw new Error('Choose a list of Agents or a list of seats, not both.')
  const listed = Math.max(uses.length, seats.length)
  const width = listed > 1 ? listed : count ?? 1
  if (listed > 1 && count !== undefined && count !== listed) {
    throw new Error('Count must match the list that sets this round’s width.')
  }
  return Array.from({ length: width }, (_value, index) => ({
    agent: uses[uses.length > 1 ? index : 0]!,
    seat: seats.length === 0 ? null : seats[seats.length > 1 ? index : 0]!,
    index,
  }))
}

const words = (value: unknown, at: string, problems: FlowProblem[]): string[] => {
  const out: string[] = []
  for (const [index, one] of (asList(value) ?? (value === undefined || value === null ? [] : [value])).entries()) {
    if (typeof one !== 'string') {
      problems.push(problem('error', `${at}[${index}]`, 'a collection contains text entries only'))
      continue
    }
    const text = one.trim()
    if (text) out.push(text)
  }
  return out
}

const integer = (value: unknown, at: string, problems: FlowProblem[], fallback: number, min: number, max: number): number => {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    problems.push(problem('error', at, `must be a whole number from ${min} to ${max}`))
    return fallback
  }
  return value
}

const unknownKeys = (record: Record<string, unknown>, allowed: ReadonlySet<string>, at: string, problems: FlowProblem[]): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) problems.push(problem('error', `${at}.${key}`, `"${key}" is not read here`))
  }
}

const readThen = (value: unknown, at: string, problems: FlowProblem[]): FlowThen | null => {
  const record = asRecord(value)
  if (!record) {
    problems.push(problem('error', at, 'this names the round to open: a role, a title, and optionally a detail'))
    return null
  }
  unknownKeys(record, THEN_FIELDS, at, problems)
  const role = asText(record['role'])?.trim()
  const title = asText(record['title'])
  if (!role) problems.push(problem('error', `${at}.role`, 'which role takes this round?'))
  if (!title) problems.push(problem('error', `${at}.title`, 'a card needs a title'))
  if (!role || !title) return null
  const files = words(record['files'], `${at}.files`, problems)
  const split = record['split'] === undefined ? undefined : asText(record['split'])?.trim()
  if (record['split'] !== undefined && !split) problems.push(problem('error', `${at}.split`, 'split names the role whose finished card recorded the split'))
  return {
    role, title,
    ...(asText(record['detail']) ? { detail: asText(record['detail'])! } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(split ? { split } : {}),
  }
}

const readCheck = (record: Record<string, unknown>, at: string, problems: FlowProblem[]): FlowCheck | null => {
  const nested = record['check']
  const flat = ['run', 'exits', 'otherwise', 'timeout', 'cwd'].some((key) => record[key] !== undefined)
  if (nested !== undefined && flat) {
    problems.push(problem('error', at, 'write a nested check or flat check fields, not both'))
    return null
  }
  const source = nested === undefined ? record : asRecord(nested)
  if (!source) {
    problems.push(problem('error', `${at}.check`, 'a check is a command: { run: "pnpm test", exits: { 0: pass } }'))
    return null
  }
  if (nested !== undefined) unknownKeys(source, CHECK_VALUE_FIELDS, `${at}.check`, problems)
  const run = asText(source['run'])?.trim()
  if (!run) {
    problems.push(problem('error', `${at}.run`, 'a check needs a command to run'))
    return null
  }
  const exits: Record<string, string> = { 0: 'pass' }
  const rawExits = asRecord(source['exits'])
  for (const [status, outcome] of Object.entries(rawExits ?? {})) {
    if (!/^\d+$/.test(status) || !asText(outcome)?.trim()) {
      problems.push(problem('error', `${at}.exits.${status}`, 'an exit status needs an outcome'))
    } else exits[status] = asText(outcome)!.trim()
  }
  const otherwise = asText(source['otherwise'])?.trim() || 'fail'
  const timeout = integer(source['timeout'], `${at}.timeout`, problems, DEFAULT_TIMEOUT, 1, DEFAULT_TIMEOUT)
  return { run, ...(asText(source['cwd'])?.trim() ? { cwd: asText(source['cwd'])!.trim() } : {}), timeout, exits, otherwise }
}

const readEvidence = (value: unknown, at: string, problems: FlowProblem[]): FlowEvidenceGuard[] => {
  const out: FlowEvidenceGuard[] = []
  const list = asList(value)
  // A scalar, a map or null is not "no guards": a guard written wrongly must never open a round unguarded.
  if (!list) {
    problems.push(problem('error', at, 'evidence is a list of guards, such as [{ check: verify }]'))
    return out
  }
  for (const [index, raw] of list.entries()) {
    const guard = asRecord(raw)
    if (!guard || Object.keys(guard).length !== 1) {
      problems.push(problem('error', `${at}[${index}]`, 'an evidence guard names exactly one observed fact'))
      continue
    }
    const [key, val] = Object.entries(guard)[0]!
    if (key === 'check' && asText(val)?.trim()) out.push({ check: asText(val)!.trim() })
    else if (key === 'ci' && val === 'green') out.push({ ci: 'green' })
    else if (key === 'review' && asText(val)?.trim()) out.push({ review: asText(val)!.trim() })
    else if (key === 'pr' && (val === 'open' || val === 'merged')) out.push({ pr: val })
    else if (key === 'diff' && val === true) out.push({ diff: true })
    else problems.push(problem('error', `${at}[${index}]`, 'an evidence guard is check, ci: green, review, pr, or diff: true'))
  }
  return out
}

/**
 * A run's budget: `rounds` closed rounds in all and `without-progress`
 * closed rounds in a row with no new evidence, each a whole number from 1 to
 * 100, both named. Only those two keys: anything else — including the
 * internal spelling `withoutProgress` — is refused at its own key.
 */
const readBudget = (value: unknown, problems: FlowProblem[]): FlowBudget | undefined => {
  const record = asRecord(value)
  if (!record) {
    problems.push(problem('error', 'budget', 'budget is a map: { rounds: 3, without-progress: 2 }'))
    return undefined
  }
  unknownKeys(record, BUDGET_FIELDS, 'budget', problems)
  const bound = (key: 'rounds' | 'without-progress'): number | null => {
    const raw = record[key]
    if (raw === undefined || raw === null) {
      problems.push(problem('error', `budget.${key}`, `say "${key}" as a whole number from 1 to ${BUDGET_LIMIT}`))
      return null
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > BUDGET_LIMIT) {
      problems.push(problem('error', `budget.${key}`, `"${key}" must be a whole number from 1 to ${BUDGET_LIMIT}`))
      return null
    }
    return raw
  }
  const rounds = bound('rounds')
  const withoutProgress = bound('without-progress')
  return rounds === null || withoutProgress === null ? undefined : { rounds, withoutProgress }
}

const readInputs = (value: unknown, problems: FlowProblem[]): FlowInput[] => {
  if (value === undefined || value === null) return []
  const input = asRecord(value)
  if (!input) {
    problems.push(problem('error', 'inputs', 'inputs is a map of name to what to call it'))
    return []
  }
  return Object.entries(input).map(([id, raw]) => {
    const detail = asRecord(raw)
    return { id, label: (detail ? asText(detail['label']) : asText(raw)) ?? id, ...(detail && asText(detail['default']) !== null ? { default: asText(detail['default'])! } : {}) }
  })
}

const parseAgents = (root: Record<string, unknown>, problems: FlowProblem[]): FlowPolicy | null => {
  unknownKeys(root, ROOT_FIELDS, 'file', problems)
  if (root['version'] !== undefined && root['version'] !== 2) problems.push(problem('error', 'version', 'this Agent flow needs version: 2'))
  const rolesRecord = asRecord(root['roles'])
  if (!rolesRecord) problems.push(problem('error', 'roles', 'a flow needs roles'))
  if (rolesRecord && Object.keys(rolesRecord).length > ROLE_LIMIT) problems.push(problem('error', 'roles', 'a flow may name at most 64 roles'))
  const generation = Object.values(rolesRecord ?? {}).reduce<{ readonly modern: boolean; readonly legacy: boolean }>(
    (found, raw) => {
      const role = asRecord(raw)
      if ((asText(role?.['kind']) ?? 'agent') !== 'agent') return found
      const modern = ['uses', 'seats', 'grant', 'independentOf'].some((key) => role?.[key] !== undefined)
      const legacy = ['seat', 'order', 'permission', 'outcomes'].some((key) => role?.[key] !== undefined)
      return { modern: found.modern || modern, legacy: found.legacy || legacy }
    },
    { modern: false, legacy: false },
  )
  if (generation.modern && generation.legacy) {
    problems.push(problem('error', 'roles', 'This flow mixes old and new Agent roles. Update the old roles before starting it.'))
  }
  const roles: FlowPolicyRole[] = []
  for (const [id, raw] of Object.entries(rolesRecord ?? {})) {
    const at = `roles.${id}`
    const record = asRecord(raw)
    if (!record) { problems.push(problem('error', at, 'a role is a map')); continue }
    const kind = asText(record['kind']) ?? 'agent'
    const hasNew = ['uses', 'seats', 'grant', 'independentOf'].some((key) => record[key] !== undefined)
    const hasOld = ['seat', 'order', 'permission', 'outcomes'].some((key) => record[key] !== undefined)
    if (kind === 'agent' && hasNew && hasOld) {
      problems.push(problem('error', at, 'This role mixes old and new fields. Use uses and grant, or update the old role first.'))
      continue
    }
    if (kind === 'agent') {
      unknownKeys(record, AGENT_FIELDS, at, problems)
      const uses = words(record['uses'], `${at}.uses`, problems)
      const rawSeats = asList(record['seats']) ?? (record['seats'] === undefined || record['seats'] === null ? [] : [record['seats']])
      const parsed = parseSeatList(rawSeats)
      for (const bad of parsed.broken) problems.push(problem('error', `${at}.seats[${bad.index}]`, bad.text))
      const count = record['count'] === undefined ? undefined : integer(record['count'], `${at}.count`, problems, 1, 1, SLOT_LIMIT)
      const specSeats = parsed.seats.map(seatSpec)
      try { expandSlots({ uses, seats: specSeats, ...(count === undefined ? {} : { count }) }) } catch (error) {
        problems.push(problem('error', `${at}.count`, error instanceof Error ? error.message : String(error)))
      }
      const grant = asText(record['grant'])?.trim() || 'read'
      if (!isCeilingLevel(grant)) problems.push(problem('error', `${at}.grant`, 'grant is read, edit, publish or merge'))
      const independentOf = words(record['independentOf'], `${at}.independentOf`, problems)
      // Blind unless the file says otherwise; anything but true or false is refused rather than read as either.
      const blind = record['blind']
      if (blind !== undefined && typeof blind !== 'boolean') problems.push(problem('error', `${at}.blind`, 'blind is true or false'))
      roles.push({ id, kind: 'agent', uses, seats: parsed.seats, ...(count === undefined ? {} : { count }), isolate: record['isolate'] === true, grant: isCeilingLevel(grant) ? grant : 'read', independentOf, ...(typeof blind === 'boolean' ? { blind } : {}) })
    } else if (kind === 'check') {
      unknownKeys(record, CHECK_FIELDS, at, problems)
      const check = readCheck(record, at, problems)
      if (check) roles.push({ id, kind: 'check', check })
    } else if (kind === 'person') {
      unknownKeys(record, PERSON_FIELDS, at, problems)
      roles.push({ id, kind: 'person', outcomes: words(record['outcomes'], `${at}.outcomes`, problems) })
    } else problems.push(problem('error', `${at}.kind`, `"${kind}" is not a kind — it is agent, person or check`))
  }
  // Absent means no rules; anything else that is not a list is refused rather than read as none.
  const rawRules = root['rules'] === undefined ? [] : asList(root['rules'])
  if (!rawRules) problems.push(problem('error', 'rules', 'rules is a list of rules, each starting with "- "'))
  if (rawRules && rawRules.length > RULE_LIMIT) problems.push(problem('error', 'rules', 'a flow may name at most 256 rules'))
  const rules: FlowPolicyRule[] = []
  const ruleList = rawRules ?? []
  ruleList.slice(0, RULE_LIMIT).forEach((raw, index) => {
    const at = `rules[${index}]`
    const record = asRecord(raw)
    if (!record) { problems.push(problem('error', at, 'a rule is a map')); return }
    unknownKeys(record, RULE_FIELDS, at, problems)
    const on = asText(record['on'])?.trim()
    const then = readThen(record['then'], `${at}.then`, problems)
    if (!on || !then) { if (!on) problems.push(problem('error', `${at}.on`, 'which role finishing a round does this rule watch?')); return }
    const when = asRecord(record['when'])
    if (record['when'] !== undefined && !when) problems.push(problem('error', `${at}.when`, 'a condition is a map'))
    if (when) unknownKeys(when, WHEN_FIELDS, `${at}.when`, problems)
    const every = words(when?.['every'], `${at}.when.every`, problems)
    const any = words(when?.['any'], `${at}.when.any`, problems)
    const evidence = when?.['evidence'] === undefined ? [] : readEvidence(when['evidence'], `${at}.when.evidence`, problems)
    rules.push({ id: asText(record['id'])?.trim() || `${on}-${index + 1}`, on, ...(every.length ? { when: { every, ...(any.length ? { any } : {}), ...(evidence.length ? { evidence } : {}) } } : any.length || evidence.length ? { when: { ...(any.length ? { any } : {}), ...(evidence.length ? { evidence } : {}) } } : {}), then })
  })
  const seed = readThen(root['seed'], 'seed', problems)
  const wait = integer(root['wait'], 'wait', problems, DEFAULT_WAIT, 1, DEFAULT_TIMEOUT)
  const rearm = root['rearm'] === undefined ? undefined : integer(root['rearm'], 'rearm', problems, DEFAULT_REARM, 0, REARM_LIMIT)
  // Absent stays absent: a document read back from a run saved before budgets must read exactly as it was written.
  const budget = root['budget'] === undefined ? undefined : readBudget(root['budget'], problems)
  const messaging = root['messaging'] === undefined ? 'board-only' : root['messaging']
  if (messaging !== 'board-only' && messaging !== 'members') problems.push(problem('error', 'messaging', 'messaging is board-only or members'))
  const inputs = readInputs(root['inputs'], problems)
  if (!seed || problems.some((one) => one.level === 'error')) return null
  const policy: FlowPolicy = { version: 2, name: asText(root['name'])?.trim() || 'Flow', ...(asText(root['description'])?.trim() ? { description: asText(root['description'])!.trim() } : {}), inputs, roles, rules, seed, messaging: messaging === 'members' ? 'members' : 'board-only', wait, ...(rearm === undefined ? {} : { rearm }), ...(budget === undefined ? {} : { budget }), ...(root['layout'] === undefined ? {} : { layout: root['layout'] }) }
  validatePolicy(policy, problems)
  return problems.some((one) => one.level === 'error') ? null : policy
}

/**
 * How each round's cards come to own their files (#1015), judged when a flow
 * is compiled — the dry run and the start — never when its text is parsed:
 * a run saved before these rules re-parses its own source on every launch,
 * and a parse refusal would block its Goal with a false "could not be read".
 *
 * One list of files for a round of several cards gives every card the same
 * paths, and the board lets only one of them be claimed: the split was never
 * enforced, because there was none. Each card needs its own part, from a
 * split an earlier round of an Agent role agreed.
 */
const fileProblems = (policy: FlowPolicy, problems: FlowProblem[]): void => {
  const byId = new Map(policy.roles.map((role) => [role.id, role]))
  const edges = new Map<string, Set<string>>()
  for (const rule of policy.rules) edges.set(rule.on, (edges.get(rule.on) ?? new Set<string>()).add(rule.then.role))
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>()
    const walk = (role: string): boolean => {
      if (role === target) return true
      if (seen.has(role)) return false
      seen.add(role)
      return [...(edges.get(role) ?? [])].some(walk)
    }
    return walk(from)
  }
  const check = (then: FlowThen, at: string, seed: boolean): void => {
    if (then.files?.length && then.split !== undefined) {
      problems.push(problem('error', `${at}.split`, 'a round takes its files from files or from split, not both'))
      return
    }
    const target = byId.get(then.role)
    if (target?.kind === 'agent' && then.files?.length) {
      let width = 1
      try { width = expandSlots({ uses: target.uses, seats: target.seats.map(seatSpec), ...(target.count === undefined ? {} : { count: target.count }) }).length } catch { /* reported with the role */ }
      if (width > 1) {
        problems.push(problem('error', `${at}.files`, `all ${width} cards of "${target.id}" would own the same paths, and two cards whose paths overlap are never both worked — give each card its own part with split: naming the role that agrees it`))
      }
    }
    const source = then.split
    if (source === undefined) return
    if (seed) problems.push(problem('error', `${at}.split`, 'the seed opens the first round, so no round before it can have agreed a split'))
    else if (byId.get(source)?.kind !== 'agent') problems.push(problem('error', `${at}.split`, `"${source}" is not an Agent role, so it cannot agree a split`))
  }
  for (const [index, rule] of policy.rules.entries()) {
    check(rule.then, `rules[${index}].then`, false)
    if (rule.then.split !== undefined && byId.get(rule.then.split)?.kind === 'agent' && !reaches(rule.then.split, rule.on)) {
      problems.push(problem('error', `rules[${index}].then.split`, `"${rule.then.split}" never finishes before this rule, so no split of its would be recorded yet`))
    }
  }
  check(policy.seed, 'seed', true)
}

const validatePolicy = (policy: FlowPolicy, problems: FlowProblem[]): void => {
  const byId = new Map(policy.roles.map((role) => [role.id, role]))
  const edges = new Map<string, Set<string>>()
  for (const rule of policy.rules) {
    const targets = edges.get(rule.on) ?? new Set<string>()
    targets.add(rule.then.role)
    edges.set(rule.on, targets)
  }
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>()
    const walk = (role: string): boolean => {
      if (role === target) return true
      if (seen.has(role)) return false
      seen.add(role)
      return [...(edges.get(role) ?? [])].some(walk)
    }
    return walk(from)
  }
  if (!byId.has(policy.seed.role)) problems.push(problem('error', 'seed.role', `there is no role called "${policy.seed.role}"`))
  for (const role of policy.roles) {
    if (role.kind !== 'agent') continue
    for (const parent of role.independentOf) {
      if (parent === role.id) problems.push(problem('error', `roles.${role.id}.independentOf`, 'a role cannot be independent of itself'))
      else if (byId.get(parent)?.kind !== 'agent') problems.push(problem('error', `roles.${role.id}.independentOf`, `"${parent}" is not an Agent role`))
      else if (!reaches(parent, role.id)) problems.push(problem('error', `roles.${role.id}.independentOf`, `"${parent}" has no predecessor path to ${role.id}`))
    }
  }
  for (const [index, rule] of policy.rules.entries()) {
    if (!byId.has(rule.on)) problems.push(problem('error', `rules[${index}].on`, `there is no role called "${rule.on}"`))
    const target = byId.get(rule.then.role)
    if (!target) problems.push(problem('error', `rules[${index}].then.role`, `there is no role called "${rule.then.role}"`))
    if (target?.kind === 'agent' && target.grant === 'merge' && (!rule.when?.evidence?.length || rule.when.every?.length || rule.when.any?.length)) {
      problems.push(problem('error', `rules[${index}]`, 'This merge step needs fresh evidence. Add an evidence guard before starting it.'))
    }
  }
  const seed = byId.get(policy.seed.role)
  if (seed?.kind === 'agent' && seed.grant === 'merge') problems.push(problem('error', 'seed', 'This merge step needs fresh evidence. Add an evidence guard before starting it.'))
}

/** Parse v2 documents while deliberately retaining the old parser for old files. */
export const parseFlowPolicy = (source: string): { document: FlowDocument | null; problems: readonly FlowProblem[] } => {
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) return { document: null, problems: [problem('error', 'file', 'A flow file cannot exceed 256 KiB.')] }
  let root: Record<string, unknown> | null
  try { root = asRecord(parseYaml(source)) } catch (error) {
    return { document: null, problems: [problem('error', error instanceof YamlError ? `line ${error.line}` : 'file', error instanceof Error ? error.message.replace(/^line \d+: /, '') : String(error))] }
  }
  if (!root) return { document: null, problems: [problem('error', 'file', 'a flow file is a map')] }
  const roles = asRecord(root['roles'])
  const agentFields = Object.values(roles ?? {}).some((raw) => {
    const role = asRecord(raw)
    return role && (role['uses'] !== undefined || role['grant'] !== undefined)
  })
  const agents = root['version'] === 2 || agentFields
  if (!agents) {
    const legacy = parseFlow(source)
    const compatibility = legacy.flow
      ? [
          problem('warning', 'format', 'This flow uses the old format'),
          ...(legacy.flow.roles.some((role) => role.kind === 'agent' && role.permission === 'read')
            ? [problem('warning', 'roles', 'Old read permission allows editing and committing.')]
            : []),
        ]
      : []
    return { document: legacy.flow ? { format: 'legacy', flow: legacy.flow } : null, problems: [...legacy.problems, ...compatibility] }
  }
  const problems: FlowProblem[] = []
  const policy = parseAgents(root, problems)
  return { document: policy ? { format: 'agents', flow: policy } : null, problems }
}

/**
 * Whether a Seat of this Agent, under this grant, may commit: the grant is
 * capped by the Agent's own ceiling, and `edit` is the first level that
 * commits (`read` changes nothing).
 */
const mayCommit = (agent: AgentDefinition, grant: CeilingLevel): boolean => ceilingReaches(narrower(agent.ceiling, grant), 'edit')

/**
 * Whether a Seat of this binding is there to review — what makes its round a
 * review series's round, and its card one a finding is raised from. An Agent
 * that produces reviews and nothing it writes always is. One that produces
 * both diffs and reviews (a requirements analyst writes positions and later
 * judges against them) reviews only where it may not commit: seated to
 * commit, it is writing, and its round is a plain one (#1014).
 */
export const reviewsIn = (binding: Pick<FlowBinding, 'agent' | 'grant'>): boolean =>
  binding.agent.produces.includes('review') && !(binding.agent.produces.includes('diff') && mayCommit(binding.agent, binding.grant))

/** Resolve frozen Agent content for a v2 policy. Broken higher-precedence entries never fall back. */
export const compileFlowPolicy = (document: FlowDocument, agents: readonly AgentEntry[]): CompiledFlow => {
  if (document.format === 'legacy') return { document, bindings: [], problems: [] }
  const problems: FlowProblem[] = []
  fileProblems(document.flow, problems)
  const bindings: CompiledFlow['bindings'][number][] = []
  const entries = new Map<string, AgentEntry>()
  for (const entry of agents) if (!entries.has(entry.id)) entries.set(entry.id, entry)
  for (const role of document.flow.roles) {
    if (role.kind !== 'agent') continue
    let slots: Slot[] = []
    try { slots = expandSlots({ uses: role.uses, seats: role.seats.map(seatSpec), ...(role.count === undefined ? {} : { count: role.count }) }) } catch (error) {
      problems.push(problem('error', `roles.${role.id}.count`, error instanceof Error ? error.message : String(error)))
      continue
    }
    for (const slot of slots) {
      const entry = entries.get(slot.agent)
      if (!entry?.definition || !entry.digest) {
        const detail = entry?.problems.find((one) => one.level === 'error')?.text
        problems.push(problem('error', `roles.${role.id}.uses`, detail ? `Agent "${slot.agent}" is unavailable: ${detail}` : `There is no usable Agent called "${slot.agent}".`))
        continue
      }
      bindings.push({ role: role.id, index: slot.index, agent: entry.definition, origin: entry.origin, digest: entry.digest, seats: slot.seat === null ? [] : [role.seats[slot.index] ?? role.seats[0]!], grant: role.grant })
    }
    /* Every Seat of a round is seated and handed its card at once, and a
       round that is not isolated seats them all in the one working tree: two
       that may commit there move each other's HEAD and land on each other's
       work (#1014). Refused rather than isolated silently, so the file says
       what runs. A Seat that may only read shares a tree safely, so it takes
       two that may commit: one writer beside readers has the tree to itself. */
    const committing = role.isolate ? 0 : bindings.filter((binding) => binding.role === role.id && mayCommit(binding.agent, binding.grant)).length
    if (committing > 1) {
      const which = committing === slots.length ? `The ${committing} Seats` : `${committing} of the ${slots.length} Seats`
      problems.push(problem('error', `roles.${role.id}`, `${which} of "${role.id}" run at once in one working tree and may commit over each other's work, so add isolate: true, or lower its grant to read.`))
    }
  }
  const roleById = new Map(document.flow.roles.map((role) => [role.id, role]))
  for (const [index, rule] of document.flow.rules.entries()) {
    const role = roleById.get(rule.on)
    if (!role || role.kind !== 'agent' || !rule.when) continue
    const candidates = bindings.filter((binding) => binding.role === role.id).map((binding) => binding.agent)
    for (const answer of rule.when.every ?? []) {
      for (const candidate of candidates) {
        if (!candidate.answers.includes(answer)) {
          problems.push(problem('error', `rules[${index}].when.every`, `${candidate.id} never answers "${answer}"`))
        }
      }
    }
    for (const answer of rule.when.any ?? []) {
      if (candidates.length > 0 && !candidates.some((candidate) => candidate.answers.includes(answer))) {
        problems.push(problem('error', `rules[${index}].when.any`, `${role.id} has no Agent that answers "${answer}"`))
      }
    }
  }
  if (bindings.length > COMPILED_SLOT_LIMIT) problems.push(problem('error', 'roles', 'A flow may compile at most 1,024 slots.'))
  return { document, bindings, problems }
}

const scalar = (value: string): string => JSON.stringify(value)
/** The compact spec where it reads back as the same seat, the long form where the compact grammar would split a name. */
const seatValue = (seat: FlowSeat): string => seatWritesCompactly(seat)
  ? scalar(seatSpec(seat))
  : `{ ${[`runtime: ${scalar(seat.runtime)}`, ...(seat.model ? [`model: ${scalar(seat.model)}`] : []), ...(seat.effort ? [`effort: ${scalar(seat.effort)}`] : []), ...(seat.thinking ? ['thinking: true'] : [])].join(', ')} }`
const thenValue = (then: FlowThen): string => `{ role: ${scalar(then.role)}, title: ${scalar(then.title)}${then.detail ? `, detail: ${scalar(then.detail)}` : ''}${then.files?.length ? `, files: [${then.files.map(scalar).join(', ')}]` : ''}${then.split ? `, split: ${scalar(then.split)}` : ''} }`

/** A deliberately normalized serializer. The conversion preview shows formatting loss before it writes. */
export const serializeFlowPolicy = (policy: FlowPolicy): string => {
  const lines = ['version: 2', `name: ${scalar(policy.name)}`]
  if (policy.description) lines.push(`description: ${scalar(policy.description)}`)
  if (policy.inputs.length) {
    lines.push('inputs:')
    for (const input of policy.inputs) {
      lines.push(`  ${input.id}:`, `    label: ${scalar(input.label)}`)
      if (input.default !== undefined && input.default !== null) lines.push(`    default: ${scalar(input.default)}`)
    }
  }
  lines.push('roles:')
  for (const role of policy.roles) {
    lines.push(`  ${role.id}:`, `    kind: ${role.kind}`)
    if (role.kind === 'agent') {
      lines.push(`    uses: [${role.uses.map(scalar).join(', ')}]`)
      if (role.seats.length) lines.push(`    seats: [${role.seats.map(seatValue).join(', ')}]`)
      if (role.count !== undefined) lines.push(`    count: ${role.count}`)
      if (role.isolate) lines.push('    isolate: true')
      lines.push(`    grant: ${role.grant}`)
      if (role.independentOf.length) lines.push(`    independentOf: [${role.independentOf.map(scalar).join(', ')}]`)
      if (role.blind !== undefined) lines.push(`    blind: ${role.blind}`)
    } else if (role.kind === 'person') lines.push(`    outcomes: [${role.outcomes.map(scalar).join(', ')}]`)
    else {
      lines.push(`    run: ${scalar(role.check.run)}`, `    exits: { ${Object.entries(role.check.exits).map(([code, outcome]) => `${code}: ${scalar(outcome)}`).join(', ')} }`, `    otherwise: ${scalar(role.check.otherwise)}`, `    timeout: ${role.check.timeout}`)
      if (role.check.cwd) lines.push(`    cwd: ${scalar(role.check.cwd)}`)
    }
  }
  // An empty list still has to read back as one: a bare `rules:` key is a
  // null scalar to the parser, not `[]`, and "rules is a list" would refuse
  // exactly the shape a fresh, ruleless draft is.
  lines.push(`seed: ${thenValue(policy.seed)}`, policy.rules.length === 0 ? 'rules: []' : 'rules:')
  for (const rule of policy.rules) {
    lines.push(`  - id: ${scalar(rule.id)}`, `    on: ${scalar(rule.on)}`)
    if (rule.when) {
      const fields: string[] = []
      if (rule.when.every?.length) fields.push(`every: [${rule.when.every.map(scalar).join(', ')}]`)
      if (rule.when.any?.length) fields.push(`any: [${rule.when.any.map(scalar).join(', ')}]`)
      if (rule.when.evidence?.length) fields.push(`evidence: [${rule.when.evidence.map((guard) => {
        const [key, value] = Object.entries(guard)[0]!
        return `{ ${key}: ${typeof value === 'string' ? scalar(value) : value} }`
      }).join(', ')}]`)
      lines.push(`    when: { ${fields.join(', ')} }`)
    }
    lines.push(`    then: ${thenValue(rule.then)}`)
  }
  lines.push(`messaging: ${policy.messaging}`, `wait: ${policy.wait}`)
  if (policy.rearm !== undefined) lines.push(`rearm: ${policy.rearm}`)
  // Written out on every save, the default included: the file then says what its runs will stop at.
  const budget = policy.budget ?? DEFAULT_FLOW_BUDGET
  lines.push(`budget: { rounds: ${budget.rounds}, without-progress: ${budget.withoutProgress} }`)
  if (policy.layout !== undefined) lines.push(`layout: ${JSON.stringify(policy.layout)}`)
  return `${lines.join('\n')}\n`
}
