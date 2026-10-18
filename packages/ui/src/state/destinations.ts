import type { FlowOrigin, RuntimeId, StartContext } from '@harnessdesk/protocol'
import { readView, type PaneView } from './layout'

export const SETTINGS_SECTIONS = ['profile', 'general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive', 'history', 'storage', 'runtimes', 'models', 'skills', 'extensions', 'permissions', 'browser'] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]
export type WorkView = Extract<PaneView, { kind: 'conversation' | 'room' }>
export interface FlowPageStart {
  readonly context: StartContext
  readonly goal?: { readonly id: string; readonly revision: number }
  readonly task?: string
  readonly done?: string
}
export type SettingsRoute =
  | { readonly kind: 'section'; readonly section: SettingsSection; readonly focus: string | null }
  | { readonly kind: 'project'; readonly root: string }
  | { readonly kind: 'skill'; readonly name: string }
  | { readonly kind: 'add-runtime' }
  | { readonly kind: 'runtime'; readonly runtime: RuntimeId }
  | { readonly kind: 'account'; readonly runtime: RuntimeId; readonly key: string }
export type PageDestination =
  | { readonly kind: 'settings'; readonly route: SettingsRoute }
  | { readonly kind: 'dashboard'; readonly view: 'overview' | 'plans' | 'spend' | 'activity' | 'projects'; readonly scope: RuntimeId | null }
  | { readonly kind: 'agents'; readonly id: string | null }
  | { readonly kind: 'teams'; readonly filter: 'active' | 'needs-you' | 'settled' }
  | { readonly kind: 'flows'; readonly root: string | null; readonly id: string | null; readonly origin: FlowOrigin | null; readonly start?: FlowPageStart }
  | { readonly kind: 'library'; readonly section: 'skill'; readonly id?: string }
  | { readonly kind: 'library'; readonly section: 'mcp' | 'changes'; readonly id?: never }
  | { readonly kind: 'plugins'; readonly section: 'installed' | 'capabilities'; readonly id: string | null }
  | { readonly kind: 'changes-review'; readonly root: string | null; readonly returnTo: WorkView }
export type Destination = PageDestination | { readonly kind: 'work'; readonly view: WorkView }
export interface DestinationHistory {
  readonly current: Destination
  readonly back: readonly Destination[]
  readonly forward: readonly Destination[]
}
export const destinationOf = (view: WorkView): Destination => ({ kind: 'work', view })
export const sameDestination = (a: Destination, b: Destination): boolean => JSON.stringify(readDestination(a)) === JSON.stringify(readDestination(b))
export const visitDestination = (history: DestinationHistory, target: Destination, replace = false): DestinationHistory =>
  sameDestination(history.current, target) ? history : {
    current: target,
    back: replace ? history.back : [...history.back, history.current].slice(-50),
    forward: replace ? history.forward : [],
  }
export const stepDestination = (history: DestinationHistory, direction: 'back' | 'forward'): DestinationHistory | null => {
  const from = history[direction], target = from.at(-1)
  if (!target) return null
  const other = direction === 'back' ? 'forward' : 'back'
  return { ...history, current: target, [direction]: from.slice(0, -1), [other]: [...history[other], history.current].slice(-50) }
}

/** Leave the Settings section stack in one move while retaining each route for Forward. */
export const leaveSettingsDestination = (history: DestinationHistory): DestinationHistory | null => {
  if (history.current.kind !== 'settings') return null
  let destinationIndex = -1
  for (let index = history.back.length - 1; index >= 0; index--) {
    if (history.back[index]?.kind !== 'settings') { destinationIndex = index; break }
  }
  if (destinationIndex < 0) return null
  return {
    current: history.back[destinationIndex]!,
    back: history.back.slice(0, destinationIndex),
    forward: [...history.forward, history.current, ...history.back.slice(destinationIndex + 1).reverse()].slice(-50),
  }
}

const object = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const string = (raw: unknown): raw is string => typeof raw === 'string' && raw.length > 0
const nullable = (raw: unknown): raw is string | null => raw === null || string(raw)
const oneOf = <T extends string>(raw: unknown, values: readonly T[]): raw is T => typeof raw === 'string' && values.includes(raw as T)
const flowPageStart = (raw: unknown, root: string | null): FlowPageStart | null => {
  const data = object(raw), input = object(data?.context)
  if (!root || !data || !input || input.root !== root) return null
  let context: StartContext
  switch (input.kind) {
    case 'project': case 'working-diff': context = { kind: input.kind, root }; break
    case 'branch': if (!string(input.branch)) return null; context = { kind: input.kind, root, branch: input.branch }; break
    case 'diff': if (!string(input.from) || !string(input.to)) return null; context = { kind: input.kind, root, from: input.from, to: input.to }; break
    case 'pull-request': if (typeof input.number !== 'number' || !Number.isSafeInteger(input.number) || input.number < 1) return null; context = { kind: input.kind, root, number: input.number }; break
    default: return null
  }
  const goal = object(data.goal)
  if (data.goal !== undefined && (!goal || !string(goal.id) || typeof goal.revision !== 'number' || !Number.isSafeInteger(goal.revision) || goal.revision < 0)) return null
  if ((data.task !== undefined && typeof data.task !== 'string') || (data.done !== undefined && typeof data.done !== 'string')) return null
  return { context, ...(goal ? { goal: { id: goal.id as string, revision: goal.revision as number } } : {}),
    ...(typeof data.task === 'string' ? { task: data.task } : {}), ...(typeof data.done === 'string' ? { done: data.done } : {}) }
}
const workView = (raw: unknown): WorkView | null => {
  const record = object(raw)
  if (!record || !oneOf(record.kind, ['conversation', 'room'])) return null
  if (record.kind === 'room' && !string(record.room)) return null
  if (record.kind === 'conversation' && !nullable(record.session)) return null
  const view = readView(raw)
  return view.kind === 'conversation' || view.kind === 'room' ? view : null
}
export const readDestination = (raw: unknown): Destination | null => {
  const data = object(raw)
  if (!data) return null
  switch (data.kind) {
    case 'work': { const view = workView(data.view); return view ? destinationOf(view) : null }
    case 'settings': {
      const route = object(data.route)
      if (!route) return null
      switch (route.kind) {
        case 'section': return oneOf(route.section, SETTINGS_SECTIONS) && nullable(route.focus)
          ? { kind: 'settings', route: { kind: 'section', section: route.section, focus: route.focus } } : null
        case 'project': return string(route.root) ? { kind: 'settings', route: { kind: 'project', root: route.root } } : null
        case 'skill': return string(route.name) ? { kind: 'settings', route: { kind: 'skill', name: route.name } } : null
        case 'add-runtime': return { kind: 'settings', route: { kind: 'add-runtime' } }
        case 'runtime': return string(route.runtime) ? { kind: 'settings', route: { kind: 'runtime', runtime: route.runtime as RuntimeId } } : null
        case 'account': return string(route.runtime) && string(route.key)
          ? { kind: 'settings', route: { kind: 'account', runtime: route.runtime as RuntimeId, key: route.key } } : null
        default: return null
      }
    }
    case 'dashboard': return oneOf(data.view, ['overview', 'plans', 'spend', 'activity', 'projects']) && nullable(data.scope)
      ? { kind: 'dashboard', view: data.view, scope: data.scope as RuntimeId | null } : null
    case 'agents': return nullable(data.id) ? { kind: 'agents', id: data.id } : null
    case 'teams': return oneOf(data.filter, ['active', 'needs-you', 'settled']) ? { kind: 'teams', filter: data.filter } : null
    case 'flows': {
      if (!(nullable(data.root) && nullable(data.id)
      && (data.origin === null || oneOf(data.origin, ['project', 'user', 'builtin']))
      && (data.id === null ? data.origin === null : data.root !== null && data.origin !== null))) return null
      const start = data.start === undefined ? undefined : flowPageStart(data.start, data.root)
      if (start === null) return null
      return { kind: 'flows', root: data.root, id: data.id, origin: data.origin, ...(start ? { start } : {}) }
    }
    case 'library': {
      if (data.section === 'skill') return data.id === undefined ? { kind: 'library', section: 'skill' }
        : string(data.id) ? { kind: 'library', section: 'skill', id: data.id } : null
      return oneOf(data.section, ['mcp', 'changes']) && data.id === undefined ? { kind: 'library', section: data.section } : null
    }
    case 'plugins': return oneOf(data.section, ['installed', 'capabilities']) && nullable(data.id)
      ? { kind: 'plugins', section: data.section, id: data.id } : null
    case 'changes-review': { const view = workView(data.returnTo); return nullable(data.root) && view
      ? { kind: 'changes-review', root: data.root, returnTo: view } : null }
    default: return null
  }
}
export const readDestinationHistory = (raw: unknown, fallback: Destination): DestinationHistory => {
  const record = object(raw)
  const entries = (value: unknown): Destination[] => Array.isArray(value)
    ? value.flatMap(item => { const read = readDestination(item); return read ? [read] : [] }).slice(-50) : []
  return { current: readDestination(record?.current) ?? fallback, back: entries(record?.back), forward: entries(record?.forward) }
}
