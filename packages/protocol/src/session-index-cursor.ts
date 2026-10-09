import type { SessionSummary } from './session.js'

type IndexRow = Pick<SessionSummary, 'runtime' | 'id' | 'updatedAt'>
const binaryCompare = (a: string, b: string): number => {
  if (a === b) return 0
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!
  }
  return left.length - right.length
}

/** Matches the index's recency then SQLite BINARY identity order. */
export const sessionIndexCompare = (a: IndexRow, b: IndexRow): number =>
  b.updatedAt - a.updatedAt || binaryCompare(a.runtime, b.runtime) || binaryCompare(a.id, b.id)

/** A bounded client window resumes at its last retained row when new rows move it. */
export const sessionIndexCursorOf = (
  row: IndexRow,
  archived: 'exclude' | 'only' = 'exclude',
): string => {
  const bytes = new TextEncoder().encode(JSON.stringify([row.updatedAt, row.runtime, row.id, archived === 'only' ? 1 : 0]))
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
