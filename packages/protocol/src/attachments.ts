import type { AgentOrigin } from './agent.js'
import type { CeilingLevel } from './evidence.js'

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
