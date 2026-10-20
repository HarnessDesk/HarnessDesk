import type { AppSnapshot, AppStore } from '../src/state/store'

/**
 * The preview gallery names its runtimes Alpha, Beta, Gamma and Delta, and its
 * models Model A to D, so a review frame is never read as a claim about a
 * vendor. The website does name the agents it works with, so every scene reads
 * them as the agents and models those runtime ids are.
 */
const NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAlpha\b/g, 'Codex'], [/\bBeta\b/g, 'Claude Code'], [/\bGamma\b/g, 'Cursor'], [/\bDelta\b/g, 'Codex 2'],
  [/\bAssistant A\b/g, 'Codex'], [/\bAssistant B\b/g, 'Claude Code'], [/\bAssistant C\b/g, 'Cursor'], [/\bAssistant D\b/g, 'Codex 2'],
  [/\bModel A\b/g, 'Sol'], [/\bModel B\b/g, 'Opus'], [/\bModel C\b/g, 'Auto'], [/\bModel D\b/g, 'Sol High'],
]
const rename = (text: string) => NAMES.reduce((value, [pattern, name]) => value.replace(pattern, name), text)
export const renamed = <T,>(value: T, seen = new WeakMap<object, unknown>()): T => {
  if (typeof value === 'string') return rename(value) as T
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value) as T
  if (value instanceof Map) {
    const next = new Map()
    seen.set(value, next)
    for (const [key, entry] of value) next.set(key, renamed(entry, seen))
    return next as T
  }
  if (Array.isArray(value)) {
    const next: unknown[] = []
    seen.set(value, next)
    for (const entry of value) next.push(renamed(entry, seen))
    return next as T
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const next: Record<string, unknown> = {}
  seen.set(value, next)
  for (const [key, entry] of Object.entries(value)) next[key] = renamed(entry, seen)
  return next as T
}
export const withRealNames = <S extends AppStore>(fixture: S): S => {
  const snapshot = fixture.getSnapshot() as AppSnapshot
  Object.assign(snapshot, renamed({ ...snapshot }))
  const request = fixture.transport.request.bind(fixture.transport)
  fixture.transport.request = (async (method, params) => renamed(await request(method, params as never))) as typeof fixture.transport.request
  return fixture
}


/** A store whose later `patch`es and peer lists read in real names too, as the race's stages do. */
export const withRealNamesAlways = <S extends AppStore & { patch: (partial: Partial<AppSnapshot>) => void }>(fixture: S): S => {
  withRealNames(fixture)
  const patch = fixture.patch.bind(fixture)
  fixture.patch = partial => patch(renamed(partial))
  const peers = fixture.teamPeers.bind(fixture)
  fixture.teamPeers = async room => renamed(await peers(room))
  return fixture
}
