import { hash } from 'fast-sha256'

/** Private, bounded equality key. Never log event bytes or their digest. */
export const transcriptFingerprint = (text: string): string =>
  Array.from(hash(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('')

/** An equality fence for all renderer-held session fields, separate from the wire turns identity. */
export const transcriptSessionFingerprint = (value: unknown): string => transcriptFingerprint(JSON.stringify(value, (_key, entry: unknown) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}))
