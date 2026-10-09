import type { FlowEntry, FlowPolicy } from '@harnessdesk/protocol'

/** The existing comparison form edits the policy itself; the engine receives only concrete commands and routes. */
export const withAttemptCheck = (flow: FlowPolicy, template: FlowPolicy, command: string): FlowPolicy => {
  const run = command.trim()
  const previous = flow.roles.find(role => role.id === 'verify' && role.kind === 'check')
  if (run && previous?.kind === 'check') return { ...flow, roles: flow.roles.map(role => role === previous ? { ...previous, check: { ...previous.check, run } } : role) }
  const fallback = template.roles.find(role => role.id === 'verify' && role.kind === 'check')
  const destination = flow.rules.find(rule => (rule.on === 'competitor' || rule.on === 'verify') && (rule.then.role === 'judge' || rule.then.role === 'referee'))
  if (!destination) return flow
  const entryWhen = flow.rules.find(rule => rule.on === 'competitor' && rule.then.role === 'verify')?.when
    ?? (destination.on === 'competitor' ? destination.when : undefined)
  const rules = flow.rules.filter(rule => rule.on !== 'verify' && rule.then.role !== 'verify' && rule.id !== destination.id)
  const roles = flow.roles.filter(role => role.id !== 'verify')
  if (!run) return { ...flow, roles, rules: [{ id: destination.id, on: 'competitor', ...(entryWhen ? { when: entryWhen } : {}), then: destination.then }, ...rules] }
  const check = previous?.kind === 'check' ? previous.check : fallback?.kind === 'check' ? fallback.check
    : { onRequest: true, timeout: 900, exits: { '0': 'pass' }, otherwise: 'fail' }
  const before = roles.findIndex(role => role.id === destination.then.role)
  roles.splice(before < 0 ? roles.length : before, 0, { id: 'verify', kind: 'check', check: { ...check, run } })
  const declared = fallback?.kind === 'check' ? template.rules.filter(rule => rule.on === 'verify' || rule.then.role === 'verify') : []
  const handoff = declared.find(rule => rule.on === 'verify' && (rule.then.role === 'judge' || rule.then.role === 'referee'))
  if (handoff) return { ...flow, roles, rules: [
    ...declared.map(rule => rule === handoff ? { ...rule, id: destination.id, then: destination.then } : rule),
    ...rules,
  ] }
  return { ...flow, roles, rules: [
    { id: 'to-verify', on: 'competitor', ...(entryWhen ? { when: entryWhen } : {}), then: { role: 'verify', title: 'Check the attempt' } },
    { ...destination, on: 'verify', when: { any: ['pass'] } },
    ...rules,
  ] }
}

const FRESH = ['fix-and-review', 'comparison', 'independent-review', 'investigation']
const USAGE = 'hd-team-shape-starts'

export const shapeSummary = (entry: FlowEntry): string =>
  entry.summary ?? entry.description?.match(/^.*?[.!?](?:\s|$)/s)?.[0].trim() ?? entry.description ?? ''

export const readShapeStarts = (): Readonly<Record<string, number>> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(USAGE) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, count]) => typeof count === 'number' && Number.isSafeInteger(count) && count > 0))
  } catch { return {} }
}

export const recordShapeStart = (id: string): void => {
  try {
    const starts = readShapeStarts()
    localStorage.setItem(USAGE, JSON.stringify({ ...starts, [id]: (starts[id] ?? 0) + 1 }))
  } catch { /* An unavailable preference store never refuses a Team start. */ }
}

export const pickerSections = (entries: readonly FlowEntry[], starts: Readonly<Record<string, number>>, query: string) => {
  const rank = (id: string): number => FRESH.indexOf(id) < 0 ? FRESH.length : FRESH.indexOf(id)
  const ordered = [...entries].sort((a, b) => (a.frontDoor?.order ?? Infinity) - (b.frontDoor?.order ?? Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const project = ordered.filter(one => one.origin === 'project')
  const other = ordered.filter(one => one.origin !== 'project')
  const most = [...other].sort((a, b) => (starts[b.id] ?? 0) - (starts[a.id] ?? 0) || rank(a.id) - rank(b.id) || ordered.indexOf(a) - ordered.indexOf(b)).slice(0, 4)
  const needle = query.trim().toLocaleLowerCase()
  const matches = (one: FlowEntry): boolean => !needle || `${one.name} ${shapeSummary(one)}`.toLocaleLowerCase().includes(needle)
  return { project: project.filter(matches), most: most.filter(matches), more: other.filter(one => !most.includes(one)).filter(matches) }
}
