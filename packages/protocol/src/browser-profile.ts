import { sha256Hex } from './digest.js'
import { runtimeId, sessionId, type RuntimeId, type SessionId } from './ids.js'

/** A reversible identity: neither folders, branch names nor account display names own a browser. */
export function sessionBrowserProfile(runtime: RuntimeId | string, session: SessionId | string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([runtime, session]))
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `session-${encoded}`
}

/** Decode only the canonical encoding, so an alternate spelling cannot allocate another partition. */
export function browserProfileSession(profile: string): { runtime: RuntimeId; sessionId: SessionId } | null {
  if (!/^session-[A-Za-z0-9_-]+$/.test(profile) || profile.endsWith('\n')) return null
  try {
    const binary = atob(profile.slice('session-'.length).replaceAll('-', '+').replaceAll('_', '/'))
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))))
    if (!Array.isArray(value) || value.length !== 2 || !value.every(part => typeof part === 'string')) return null
    const [runtime, id] = value as [string, string]
    return sessionBrowserProfile(runtime, id) === profile ? { runtime: runtimeId(runtime), sessionId: sessionId(id) } : null
  } catch { return null }
}

/** Syntax only. The host separately authorizes the session or retained lane before desktop use. */
export const isBrowserProfile = (profile: unknown): profile is string => typeof profile === 'string' &&
  ((!profile.endsWith('\n') && /^lane-[A-Za-z0-9-]{1,100}$/.test(profile)) || browserProfileSession(profile) !== null)

/** A filesystem component: Electron lowercases partitions, and filesystems cap component lengths. */
export const browserProfileStorageName = (profile: string): string =>
  profile.startsWith('session-') ? `session-${sha256Hex(new TextEncoder().encode(profile))}` : profile
