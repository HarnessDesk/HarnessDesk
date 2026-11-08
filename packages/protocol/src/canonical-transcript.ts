import type { Turn } from './session.js'

/** Versioned identity of ordered turns only. Other rendered session state needs separate protection. Never log the returned body. */
export function canonicalTranscriptBody(turns: readonly Turn[]): { readonly canonical: string; readonly bytes: number } {
  const canonical = JSON.stringify(turns, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  })
  const versioned = `v1:${canonical}`
  return { canonical: versioned, bytes: new TextEncoder().encode(versioned).byteLength }
}
