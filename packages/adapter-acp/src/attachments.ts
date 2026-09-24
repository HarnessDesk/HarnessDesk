import {
  ACP_ATTACHMENTS_CAPABILITY,
  type AcpAttachmentCapability,
  type AcpAttachmentInput,
  type AcpInitializeResult,
} from '@harnessdesk/transport-acp'
import type { AttachmentSupport, SessionAttachmentReceipt, SessionAttachments } from '@harnessdesk/protocol'

/**
 * The ACP side of phase 12's attachment contract: strict decoding of what a
 * peer claims in `initialize`, strict validation of what it answers to
 * `_harnessdesk/attachment_receipt`, and the one place `_meta.harnessdesk`'s
 * shape for both is written down once rather than three times across
 * `runtime.ts`.
 *
 * Every function here treats the peer as hostile by default: a missing
 * field, an extra one, a wrong type or an unrequested name is `null` (for a
 * capability) or a rejection (for a receipt) — never a best-effort repair. A
 * peer that cannot be read exactly is a peer this contract calls unsupported,
 * which is the honest answer decision 16 asks for.
 */

// ------------------------------------------------------------ capability

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/**
 * Strictly decodes `initialize`'s `agentCapabilities._meta.harnessdesk.attachments`.
 * Anything other than exactly `{version: 1, skills: boolean, mcp: boolean,
 * suppressUnapproved: boolean}` — a missing extension, a different version, an
 * extra key, a non-boolean field — is unsupported. No optimistic feature
 * detection by brand name: this is the only path that may return a capability.
 */
export function decodeAttachmentCapability(initialized: AcpInitializeResult | null | undefined): AcpAttachmentCapability | null {
  const meta = initialized?._meta as { readonly harnessdesk?: Record<string, unknown> } | undefined
  const declared = meta?.harnessdesk?.[ACP_ATTACHMENTS_CAPABILITY]
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return null
  const value = declared as Record<string, unknown>
  const keys = Object.keys(value)
  if (keys.length !== 4 || value['version'] !== 1) return null
  if (!isBoolean(value['skills']) || !isBoolean(value['mcp']) || !isBoolean(value['suppressUnapproved'])) return null
  return { version: 1, skills: value['skills'], mcp: value['mcp'], suppressUnapproved: value['suppressUnapproved'] }
}

/**
 * The protocol-facing `AttachmentSupport` a decoded capability (or its
 * absence) produces for one runtime build.
 *
 * `mcp` now trusts a peer's own claim exactly the way `skills` already does
 * (decision: gate on capability, never on which backend is running). That
 * used to be an unconditional `'unsupported'` here, because the host side had
 * nothing real behind it — an approved external server had no route to the
 * agent at all. It does now: `bootstrap.ts` wires every ACP peer's existing
 * `harnessdesk` gateway server (the same one plugin tools already use) to
 * `McpToolGateway`'s `mcp/list`/`mcp/call`, gated exactly like every other
 * tool call. A peer that claims `mcp: true` is claiming it can suppress its
 * *own* other MCP auto-discovery (`strictMcpConfig`-equivalent) so that
 * gateway is the only server a scoped Seat's session can reach — which is
 * the one thing this decoder cannot verify from `initialize` alone, so it is
 * still exactly a claim, admitted no more optimistically than skills already
 * are.
 */
export function toAttachmentSupport(
  capability: AcpAttachmentCapability | null,
  runtime: string,
  build: string,
): AttachmentSupport {
  if (!capability) {
    return {
      runtime,
      build,
      skills: 'unsupported',
      mcp: 'unsupported',
      suppressUnapproved: false,
      reason: `${runtime} does not declare phase 12's attachment extension.`,
    }
  }
  return {
    runtime,
    build,
    skills: capability.skills ? 'scoped' : 'unsupported',
    mcp: capability.mcp ? 'scoped-gated' : 'unsupported',
    suppressUnapproved: capability.suppressUnapproved,
    reason: null,
  }
}

// ------------------------------------------------------------ session/new, session/load

/** `AttachmentInput`'s ACP wire shape — identical fields, just the name this extension uses. */
const wireInputOf = (input: SessionAttachments): AcpAttachmentInput => ({
  key: input.key,
  skills: input.skills,
  mcp: input.mcp,
})

/**
 * The open's `_meta` with the prepared attachment input added under
 * `harnessdesk.attachments`, beside whatever else (`#briefed`'s instruction,
 * a caller's own `_meta`) is already there — never in place of it. Mirrors
 * `#briefed`'s own merge exactly, so the two extensions compose regardless
 * of which is applied first.
 */
export function attachmentsMeta(
  params: Readonly<Record<string, unknown>>,
  input: SessionAttachments | undefined,
): { readonly _meta?: Record<string, unknown> } {
  if (!input) return {}
  const meta = (params['_meta'] ?? {}) as Record<string, unknown>
  const ours = (meta['harnessdesk'] ?? {}) as Record<string, unknown>
  return { _meta: { ...meta, harnessdesk: { ...ours, [ACP_ATTACHMENTS_CAPABILITY]: { version: 1, input: wireInputOf(input) } } } }
}

// ------------------------------------------------------------ attachment_receipt

const MAX_COMBINED_ENTRIES = 192
const MAX_NAME_BYTES = 128
const MAX_REASON_BYTES = 512
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validName = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_NAME_BYTES && value.length > 0
const validReason = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_REASON_BYTES
const validKind = (value: unknown): value is 'skill' | 'mcp' => value === 'skill' || value === 'mcp'

interface IntendedSet {
  readonly key: string
  readonly skills: readonly { readonly name: string; readonly digest: string }[] | null
  readonly mcp: readonly { readonly name: string; readonly digest: string }[] | null
}

/** Every `kind:name` this Seat's prepared input actually named — the only names a receipt may claim as loaded. */
const intendedNames = (intended: IntendedSet): Set<string> => {
  const names = new Set<string>()
  for (const one of intended.skills ?? []) names.add(`skill:${one.name}`)
  for (const one of intended.mcp ?? []) names.add(`mcp:${one.name}`)
  return names
}

/**
 * Strict validation of `_harnessdesk/attachment_receipt`'s result: bounded
 * before anything is allocated from it, matched to exactly the key and the
 * set of names this Seat was actually prepared with, and rejected whole —
 * never salvaged in part — on the first thing that does not hold. A peer
 * that answers something this function refuses is exactly as capable, for
 * this Seat, as one that never answered at all.
 */
export function validateAttachmentReceipt(raw: unknown, intended: IntendedSet): SessionAttachmentReceipt | null {
  if (!isPlainObject(raw)) return null
  if (raw['key'] !== intended.key) return null
  const loadedRaw = raw['loaded']
  const refusedRaw = raw['refused']
  if (!Array.isArray(loadedRaw) || !Array.isArray(refusedRaw)) return null
  if (loadedRaw.length + refusedRaw.length > MAX_COMBINED_ENTRIES) return null
  const allowed = intendedNames(intended)
  const seen = new Set<string>()

  const loaded: { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly digest: string }[] = []
  for (const entry of loadedRaw) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 3) return null
    const { kind, name, digest } = entry
    if (!validKind(kind) || !validName(name) || typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) return null
    const identity = `${kind}:${name}`
    // An unknown extra loaded item — never named in what this Seat was
    // actually prepared with — invalidates the whole receipt rather than
    // being dropped: decision 4 is explicit that this closes the session,
    // which only happens if the caller cannot tell the difference between
    // "this receipt is fine, minus one entry" and "do not trust this at all".
    if (!allowed.has(identity) || seen.has(identity)) return null
    seen.add(identity)
    loaded.push({ kind, name, digest })
  }

  const refused: { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly reason: string }[] = []
  for (const entry of refusedRaw) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 3) return null
    const { kind, name, reason } = entry
    if (!validKind(kind) || !validName(name) || !validReason(reason)) return null
    const identity = `${kind}:${name}`
    if (seen.has(identity)) return null // named as both loaded and refused: not a receipt this function will guess about
    seen.add(identity)
    refused.push({ kind, name, reason })
  }

  return { key: raw['key'], loaded, refused }
}
