import { basename, isAbsolute } from 'node:path'
import type { RuntimeLoadout, RuntimeLoadoutItem, RuntimeLoadoutPart } from '@harnessdesk/protocol'

const invalid = (): never => { throw new Error('The agent returned an invalid loadout.') }
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const text = (value: unknown, max = 256): string =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : invalid()
const tokens = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid()
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) && value.length <= 10_000 ? value.map(record) : invalid()
export const loadoutItem = (name: string, extra: Partial<RuntimeLoadoutItem> = {}): RuntimeLoadoutItem => ({
  name, group: null, origin: null, path: null, tokens: null, count: null, enabled: null, ...extra,
})
export const loadoutPart = (items: readonly RuntimeLoadoutItem[]): RuntimeLoadoutPart => ({
  reported: true, items: items.slice(0, 500), more: Math.max(0, items.length - 500),
})

/** Validate the whole response before retaining any of it, including rows past the display bound. */
export function decodeLoadout(value: unknown): RuntimeLoadout {
  const raw = record(value)
  const common = { approximate: true, source: 'getContextUsage (summary)' }
  if (raw['ready'] === false) {
    const part = { reported: false, reason: text(raw['reason'], 4096), notReady: true } as const
    return { ...common, skills: part, mcp: part, memory: part, agents: part }
  }
  if (raw['ready'] !== true) return invalid()
  const skills: RuntimeLoadoutPart = raw['skills'] === null
    ? { reported: false, reason: 'This agent did not report its skills.' }
    : loadoutPart(list(raw['skills']).map(one => loadoutItem(text(one['name']), { origin: text(one['source']), tokens: tokens(one['tokens']) })))
  const servers = new Map<string, { count: number; tokens: number }>()
  for (const one of list(raw['mcpTools'])) {
    text(one['name'])
    const name = text(one['serverName'])
    const size = tokens(one['tokens'])
    if (one['isLoaded'] !== undefined && typeof one['isLoaded'] !== 'boolean') return invalid()
    const server = servers.get(name) ?? { count: 0, tokens: 0 }
    server.count++
    if (one['isLoaded'] !== false) server.tokens = tokens(server.tokens + size)
    servers.set(name, server)
  }
  const memory = loadoutPart(list(raw['memoryFiles']).map(one => {
    const path = text(one['path'], 4096)
    if (!isAbsolute(path)) return invalid()
    return loadoutItem(basename(path), { path, group: text(one['type']), tokens: tokens(one['tokens']) })
  }))
  const agents = loadoutPart(list(raw['agents']).map(one => loadoutItem(text(one['agentType']), { origin: text(one['source']), tokens: tokens(one['tokens']) })))
  return { ...common, skills, mcp: loadoutPart([...servers].map(([name, size]) => loadoutItem(name, size))), memory, agents }
}
