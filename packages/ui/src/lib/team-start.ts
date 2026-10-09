import type { FlowEntry } from '@harnessdesk/protocol'

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
