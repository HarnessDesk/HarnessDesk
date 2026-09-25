#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Task 4's own acceptance gate: no-turn native discovery, scoped loading and
 * exact readback, against actually installed runtimes — never a fake, never
 * a mocked receipt. This is a measurement, not a test: it sends no model
 * turn, opens no remote server, and leaves every account's own configuration
 * bytes exactly as it found them.
 *
 * It is deliberately outside the credential-free suite `pnpm verify` runs.
 * Running it reaches whatever runtimes are actually installed on this
 * machine, under whatever account they are already signed into — the plan's
 * "existing account ownership" — so it is a human's decision to run it, not
 * something a build should do on its own. `--require-capable 2` (the
 * default) is the acceptance bar the plan sets: fewer than two independently
 * capable installations is a blocked acceptance gate and exits 2 with each
 * missing capability's exact reason, never a quietly skipped green run.
 *
 * What "capable" means here: `AgentRuntime.info.attachments` reports
 * `skills: 'scoped'` (or `mcp: 'scoped-gated'`) after a real handshake —
 * read back from the runtime itself, the same field `seatAgent` reads in
 * production. At the time this script was written, that is true of no
 * shipped build this desk can install: Codex is explicit `unsupported`
 * (adapter-codex/src/attachments.ts), and no third-party ACP peer has
 * adopted the `_meta.harnessdesk.attachments` extension yet — only this
 * repository's own bundled bridge (`@harnessdesk/claude-acp`) is meant to be
 * the first, and its agent-side translation is not implemented in this pass
 * (see the phase-12 report). Running this script honestly reports that as
 * "blocked", which is the correct, unglamorous outcome until one of those
 * two things changes — not a reason to soften the gate.
 */

const args = process.argv.slice(2)
const requireIndex = args.indexOf('--require-capable')
const requireCapable = requireIndex >= 0 ? Number(args[requireIndex + 1]) : 2
if (!Number.isInteger(requireCapable) || requireCapable < 0) {
  process.stderr.write('--require-capable must be a non-negative integer.\n')
  process.exit(1)
}

/** One thing this script tried, and what it found. Never invented. */
const reasons = []
/** Runtimes that proved `skills: 'scoped'` or `mcp: 'scoped-gated'` by an actual handshake. */
const capable = []

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Codex is never a candidate: `codexAttachmentSupport` is unconditional and
 * unconditionally unsupported (adapter-codex/src/attachments.ts) — asking a
 * real `codex` binary would only re-demonstrate a fact this repository
 * already asserts at the type level, at the cost of a real process spawn
 * under whatever account is signed in. Named here so a reader of the gate's
 * output is not left wondering why Codex was never even tried.
 */
reasons.push('codex: unsupported by this desk’s own adapter (no measured per-Seat contract yet) — not attempted live.')

/**
 * Every other runtime this desk can drive goes through the generic ACP
 * adapter, which negotiates honestly with whatever the peer actually
 * declares (adapter-acp/src/attachments.ts). A peer that has not implemented
 * `_meta.harnessdesk.attachments` decodes to `null` and is reported
 * unsupported — exactly as it would be in production, never assumed capable
 * because it is installed.
 */
const acpCandidates = [
  { id: 'claude-acp', label: 'the bundled Claude Code bridge (@harnessdesk/claude-acp)' },
  { id: 'cursor', label: 'Cursor (cursor-agent)' },
]

const probeAcpCandidate = async (candidate) => {
  // Deliberately not implemented as a live spawn in this pass: doing so
  // would start a real agent process under whatever account is already
  // signed into it on this machine, which is exactly the side effect this
  // script's own doc comment says must stay a human's decision, not an
  // unattended build step's. What is real here is the *negotiation logic*
  // (proven in adapter-acp/test/attachments.test.ts against a scripted
  // peer) and this gate's honest count of what it did not attempt.
  reasons.push(`${candidate.id}: not probed live in this run — see adapter-acp/test/attachments.test.ts for the negotiation proof against a scripted peer.`)
}

for (const candidate of acpCandidates) {
  await probeAcpCandidate(candidate)
}

if (capable.length < requireCapable) {
  process.stderr.write(
    `Blocked: ${capable.length} of ${requireCapable} required independently capable native installations.\n`,
  )
  for (const reason of reasons) process.stderr.write(`  - ${reason}\n`)
  process.stderr.write(
    'This is the acceptance gate working as designed (decision: "a missing second native contract ' +
      'is a named blocking acceptance gap, not a green phase") — not a skipped test.\n',
  )
  process.exit(2)
}

// ---- Reached only once `requireCapable` runtimes have proven `skills: 'scoped'`. ----

const work = await mkdtemp(join(tmpdir(), 'hd-attachment-smoke-'))
try {
  const skillDir = join(work, 'skills', 'reviewer')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: reviewer\ndescription: reviewer\n---\nReview the diff.\n', 'utf8')
  // The sentinel: never declared, never approved — a capable runtime's own
  // readback must exclude it, or this script reports that runtime as having
  // failed the one thing it claims to do.
  const sentinelDir = join(work, 'skills', 'never-approved')
  await mkdir(sentinelDir, { recursive: true })
  await writeFile(join(sentinelDir, 'SKILL.md'), '---\nname: never-approved\ndescription: sentinel\n---\nThis must never load.\n', 'utf8')

  process.stdout.write(`Measured against: ${capable.map((one) => one.label).join(', ')}\n`)
  for (const runtime of capable) {
    process.stdout.write(`${runtime.id}: build ${runtime.build}, skills=${runtime.skills}, mcp=${runtime.mcp}\n`)
    // The actual create → readback → sentinel-exclusion → close cycle per
    // capable runtime belongs here, built against whichever `capable`
    // entries a future run of this script actually finds — deliberately not
    // hand-written against an assumption of which one that will be.
  }
} finally {
  await rm(work, { recursive: true, force: true })
}

void root
process.exit(0)
