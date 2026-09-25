import type { AttachmentSupport } from '@harnessdesk/protocol'

/**
 * Phase 12's attachment contract, Codex side: explicitly unsupported.
 *
 * Codex's generated `ThreadStartParams` exposes `selectedCapabilityRoots` and
 * a generic per-thread `config`, and `SkillsListParams` is cwd-scoped rather
 * than thread-scoped — none of which is a measured, per-Seat filtering
 * contract with suppression of unapproved defaults and an exact readback on
 * create, resume and fork. Advertising `scoped` on the strength of those
 * shapes would be exactly the "capability nobody confirmed" this phase
 * refuses to report, so this returns unsupported for every build until a
 * newer Codex's native contract is actually measured and this function is
 * rewritten to decode it — never by inventing a `skills.allowlist` key or
 * calling the global `skills/config/write`, which would widen every other
 * session on the same account rather than scope this one.
 */
export function codexAttachmentSupport(build: string): AttachmentSupport {
  return {
    runtime: 'codex',
    build,
    skills: 'unsupported',
    mcp: 'unsupported',
    // Codex's own skill/MCP auto-discovery cannot be suppressed for one
    // Seat without global config that would affect every other session on
    // the same account — decision 15's isolation condition is not met.
    suppressUnapproved: false,
    reason: 'Codex has no measured per-Seat attachment contract yet; declared skills and servers are not loaded through it.',
  }
}
