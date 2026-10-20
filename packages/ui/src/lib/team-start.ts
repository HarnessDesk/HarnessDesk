import type { FlowEntry, FlowPolicy, FlowSeat } from '@harnessdesk/protocol'

export const supportsComparisonJudge = (flow: FlowPolicy): boolean =>
  flow.roles.some(role => role.id === 'competitor' && role.kind === 'agent') &&
  flow.roles.some(role => role.id === 'judge' && role.kind === 'agent') &&
  flow.roles.some(role => role.id === 'referee' && role.kind === 'person') &&
  flow.rules.some(rule => (rule.on === 'competitor' || rule.on === 'verify') && rule.then.role === 'judge') &&
  flow.rules.some(rule => rule.on === 'judge' && rule.then.role === 'referee')

/** Both entry points freeze the same optional judge and person-choice routes as ordinary policy data. */
export const withComparisonJudge = (flow: FlowPolicy, template: FlowPolicy, seat: FlowSeat | null): FlowPolicy => {
  if (!supportsComparisonJudge(template)) return flow
  const judge = flow.roles.find(role => role.id === 'judge' && role.kind === 'agent') ?? template.roles.find(role => role.id === 'judge' && role.kind === 'agent')
  if (!judge || judge.kind !== 'agent') return flow
  const before = flow.roles.some(role => role.id === 'verify' && role.kind === 'check') ? 'verify' : 'competitor'
  const incoming = flow.rules.find(rule => rule.on === before && (rule.then.role === 'judge' || rule.then.role === 'referee'))
  const roles = flow.roles.filter(role => role.id !== 'judge').map(role => {
    if (role.id !== 'referee' || role.kind !== 'person') return role
    const { review: _review, ...person } = role
    const declared = template.roles.find(one => one.id === role.id)
    return seat ? { ...person, ...(declared?.kind === 'person' && declared.review !== undefined ? { review: declared.review } : {}) } : { ...person, review: true }
  })
  if (!seat) return { ...flow, roles, rules: [
    ...flow.rules.filter(rule => rule.on !== 'judge' && rule.then.role !== 'judge' && rule.id !== incoming?.id),
    { id: 'to-person', on: before, ...(incoming?.when ? { when: incoming.when } : {}), then: { role: 'referee', title: 'Choose and merge an attempt' } },
  ] }
  roles.splice(roles.findIndex(role => role.id === 'referee'), 0, { ...judge, seats: [seat] })
  if (flow.roles.some(role => role.id === 'judge')) return { ...flow, roles }
  return { ...flow, roles, rules: [
    ...flow.rules.filter(rule => rule.id !== incoming?.id),
    ...template.rules.filter(rule => rule.on === 'judge' || rule.then.role === 'judge').map(rule => {
      if (rule.then.role !== 'judge') return rule
      const when = before === 'verify' ? (rule.on === 'verify' ? rule.when : { any: ['pass'] }) : incoming?.when
      return { ...rule, on: before, ...(when ? { when } : { when: undefined }) }
    }),
  ] }
}

/** Both attempt forms edit ordinary policy data; the engine receives only concrete commands and routes. */
export const supportsAttemptCheck = (flow: FlowPolicy): boolean =>
  flow.roles.some(role => role.id === 'competitor' && role.kind === 'agent') &&
  flow.rules.some(rule => (rule.on === 'competitor' || rule.on === 'verify') && (rule.then.role === 'judge' || rule.then.role === 'referee'))

export const withAttemptCheck = (flow: FlowPolicy, template: FlowPolicy, command: string): FlowPolicy => {
  const run = command.trim() ? command : ''
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
  const most = other.filter(one => (starts[one.id] ?? 0) > 0).sort((a, b) => (starts[b.id] ?? 0) - (starts[a.id] ?? 0) || rank(a.id) - rank(b.id) || ordered.indexOf(a) - ordered.indexOf(b)).slice(0, 4)
  const needle = query.trim().toLocaleLowerCase()
  const matches = (one: FlowEntry): boolean => !needle || `${one.name} ${shapeSummary(one)}`.toLocaleLowerCase().includes(needle)
  return { project: project.filter(matches), most: most.filter(matches), more: other.filter(one => !most.includes(one)).filter(matches) }
}

/** A small front door; the searchable catalogue remains the complete source of choices. */
export const quickFlowChoices = (entries: readonly FlowEntry[], starts: Readonly<Record<string, number>>): readonly FlowEntry[] => {
  const sections = pickerSections(entries, starts, '')
  const candidates = [
    ...sections.project.slice(0, 1), ...sections.most.slice(0, 2),
    ...FRESH.flatMap(id => entries.filter(entry => entry.id === id && entry.origin !== 'project')),
    ...sections.project, ...sections.more,
  ]
  return candidates.filter((entry, index) => candidates.findIndex(one => one.id === entry.id && one.origin === entry.origin) === index).slice(0, 3)
}

/** Keep the edit-first publication handoff when the review option is toggled. */
export const withReviewHandoff = (flow: FlowPolicy, value: string): FlowPolicy => {
  const editFirst = flow.roles.some(role => role.id === flow.seed.role && role.kind === 'agent' && role.grant === 'edit')
  const publish = value !== 'merge' && editFirst
  return { ...flow,
    roles: flow.roles.map(one => one.id !== 'referee' ? one : value === 'merge'
      ? { id: 'referee', kind: 'agent', uses: ['merger'], seats: [], isolate: false, grant: 'merge', independentOf: [] }
      : { id: 'referee', kind: 'person', outcomes: ['merged', 'dropped'] }),
    rules: flow.rules.map(rule => rule.then.role !== 'referee' ? rule : {
      ...rule,
      when: value === 'merge' ? { evidence: [{ review: 'approve' }, { pr: 'open' }] } : { every: ['approve'], evidence: [{ review: 'approve' }] },
      then: { ...rule.then,
        title: value === 'merge' ? 'Merge the reviewed pull request' : publish ? 'Approve publishing the reviewed change' : 'Merge it — the reviewer approved',
        detail: value === 'merge' ? 'Merge only the approved revision after its required checks pass.' : publish
          ? 'Review and approve publishing revision {{evidence.review.at}} from the branch named in the writer’s context package. You decide whether to push that branch and open a pull request, then merge after its checks pass, or drop the change. No agent in this Team may push or merge.'
          : 'Merging is yours; no agent in this Team may do it.',
      },
    }),
  }
}
