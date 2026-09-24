import type { AgentOrigin } from './agent.js'
import type { CeilingLevel, SeatId } from './evidence.js'

/**
 * What an Agent may carry beyond its brief: skills, MCP servers, and its own
 * notes file — declared by name, never by command or path.
 *
 * Phase 12's whole design turns on one line: a declared name is a catalogue
 * identifier, not an executable spec. Reading a cloned repository's `AGENT.md`
 * and its `skills/` folder starts no process, no network request and no
 * script — it only ever produces the identities and bytes below, which a
 * person reviews before anything is trusted to load. See
 * `docs/superpowers/plans/2026-09-19-agents-memory.md` for the decisions this
 * shape answers to.
 */

export type AttachmentKind = 'skill' | 'mcp' | 'notes'

/**
 * One bundle or server, identified by what it actually is rather than by the
 * name that pointed at it: two Agents naming the same catalogue entry get the
 * same identity, and one repository editing its bundle gets a new one.
 */
export interface AttachmentIdentity {
  readonly kind: AttachmentKind
  readonly name: string
  /** The whole bundle's digest (Task 1's bounded reader), never just its `SKILL.md`. */
  readonly digest: string
  /** Whether this came from the Agent's own folder or a Library copy. */
  readonly source: 'agent' | 'library'
  /** Where a person can go look, already shortened for display. */
  readonly pathLabel: string
}

/** What a runtime can do with a kind of attachment, on this build, for this Seat. */
export interface AttachmentSupport {
  readonly runtime: string
  readonly build: string
  readonly skills: 'scoped' | 'unsupported'
  readonly mcp: 'scoped-gated' | 'unsupported'
  /** Whether this runtime's own auto-loading of repository content can be suppressed for one Seat. */
  readonly suppressUnapproved: boolean
  readonly reason: string | null
}

/** One name an Agent wrote, resolved or not, exactly as a person would want it explained. */
export interface AttachmentDeclaration {
  readonly kind: AttachmentKind
  readonly name: string
  /** Null when this name could not be resolved to one loadable identity. */
  readonly identity: AttachmentIdentity | null
  /** Why `identity` is null; also set, informationally, when it is not. */
  readonly problem: string | null
}

/**
 * What a person is being asked to approve: the exact bytes, never a promise
 * to fetch them again later.
 */
export interface AttachmentReview {
  readonly token: string
  readonly expiresAt: number
  readonly declarations: readonly AttachmentDeclaration[]
  readonly files: readonly { readonly path: string; readonly text: string }[]
  readonly runtime: string
  readonly effectiveCeiling: CeilingLevel
  readonly consequence: string
}

/** An Agent's declarations and what a Seat would find loadable, for the Agent page and the Library. */
export interface AgentAttachmentsView {
  readonly agent: string
  readonly origin: AgentOrigin
  readonly agentDigest: string
  readonly skillsMode: 'runtime-defaults' | 'allowlist'
  readonly mcpMode: 'runtime-defaults' | 'allowlist'
  readonly declarations: readonly AttachmentDeclaration[]
  readonly support: readonly AttachmentSupport[]
}

/**
 * Phase 12 Task 3: what a Seat froze at open, and what its runtime actually
 * loaded.
 *
 * A Seat's attachments never change after it opens — a shadowed Agent
 * editing its file, a newly approved grant, a Library copy changing, none of
 * it reaches a Seat that already exists. Reconnect and resume revalidate
 * these exact frozen inputs; they never re-read the Agent's current wishes.
 */

/** One binding's outcome, kept forever once observed: a later epoch never rewrites an earlier one. */
export interface AttachmentLoadResult {
  readonly identity: AttachmentIdentity
  readonly status: 'loaded' | 'not-loaded'
  readonly reason: string | null
}

/** The full history of one Seat's attachments: every observation epoch, oldest first. */
export interface SeatAttachmentsRecord {
  readonly version: 1
  readonly seat: SeatId
  readonly agentDigest: string
  readonly runtime: string
  readonly build: string
  /** 0 at first open; a reconnect or resume appends a new epoch, never rewriting an old one. */
  readonly epoch: number
  readonly observedAt: number
  readonly skillsMode: 'runtime-defaults' | 'allowlist'
  readonly mcpMode: 'runtime-defaults' | 'allowlist'
  readonly declarations: readonly AttachmentDeclaration[]
  readonly results: readonly AttachmentLoadResult[]
  /** True when this record was read back from a restored (imported) sidecar rather than observed live by this install. */
  readonly restored: boolean
}

/**
 * Host-to-adapter data only — never accepted in a public session-creation
 * payload, because only host-generated input carries approval. `null` means
 * native defaults (the runtime's own, unfiltered behavior); an array is an
 * explicit filter computed after trust resolution. An empty array is not the
 * same as `null`: it means every declared name was refused, never "use
 * defaults".
 */
export interface SessionAttachments {
  readonly key: string
  /**
   * `path` is the host's own staged copy of exactly the approved bytes, under
   * machine state (`attachments/staged/skill/<digest>/`) — never the Agent's
   * or the Library's folder, which can change after the approval.
   */
  readonly skills: readonly { readonly name: string; readonly digest: string; readonly path: string }[] | null
  readonly mcp: readonly { readonly name: string; readonly digest: string; readonly endpoint: string }[] | null
  // Agent notes are not carried: decision 17 wants approved notes as
  // labeled context, never a system instruction, and this phase has no
  // approval for notes. The field is absent rather than always null, so no
  // runtime ever grows a path that would fold them in unapproved.
}

/** What a runtime says it loaded, in answer to `SessionAttachments` — the readback `activateBindings` checks. */
export interface SessionAttachmentReceipt {
  readonly key: string
  readonly loaded: readonly { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly digest: string }[]
  readonly refused: readonly { readonly kind: 'skill' | 'mcp'; readonly name: string; readonly reason: string }[]
}

/**
 * Task 5: a previewed `skills:`/`mcp:` rewrite, before anything is written.
 *
 * Shaped like the existing `CeilingUpdate` this desk already ships for the
 * one line phase 3 edits — `digest` of the file exactly as previewed, and a
 * unified `diff` a person reads before choosing to write it — rather than
 * the plan's own literal `{token, before, after}` sketch: this repository
 * already has a working, tested pattern for "preview one front-matter edit,
 * write it bound to its digest" (`agent-def.ts`'s `ceilingEdit`), and this
 * follows it rather than inventing a second one. There is no separate
 * server-held token; the digest a preview shows is exactly what `.../write`
 * must be given back, the same way `agent/ceiling/write` already works.
 */
export interface AttachmentEditPreview {
  readonly path: string
  readonly digest: string
  readonly diff: string
}

/** `NOTES.md` beside an Agent's file, as the Agent page shows and clears it. */
export interface AgentNotesView {
  readonly path: string
  readonly text: string | null
  readonly digest: string | null
  readonly writable: boolean
  readonly problem: string | null
}
