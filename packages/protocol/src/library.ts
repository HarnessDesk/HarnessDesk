import type { RuntimeId } from './ids.js'

/**
 * The library: what instruction bundles and MCP servers exist on this machine,
 * and which agents can actually see each one.
 *
 * This is a **read model**. Nothing here writes to any agent's directory, and
 * the shapes below deliberately have no verbs — installing is a later concern
 * with its own manifest, preview and audit trail. What the library answers is
 * the question no per-agent settings page can, because each of those is scoped
 * to one runtime: *this skill reaches those two agents and not these two.*
 *
 * The distinction that makes it worth building is `unscanned`. A copy can sit
 * on disk, in a directory a tool wrote it to on purpose, and still be invisible
 * to the agent it was meant for. `~/.agents/skills` — widely published as the
 * shared cross-agent location — is read by neither Claude Code 2.1.240 nor the
 * Gemini CLI, and Cursor's one mention of it sits in its *import* path rather
 * than its load path. Codex 0.149.0 does load it. So a copy left there reaches
 * exactly one of four agents, where a view built on the published convention
 * would report four.
 *
 * So reach is measured wherever it can be. `AgentRuntime.listSkills` is what
 * the agent itself says it loaded, and where a runtime answers it, that answer
 * outranks any table of paths this repository could keep — see `ReachBasis`.
 */

/** What kind of thing a library entry is. */
export type LibraryKind = 'skill' | 'mcp'

/**
 * Whether one entry reaches one agent.
 *
 * Never a boolean, because five of these six states are indistinguishable from
 * "off" in a checkbox and each one asks for something different.
 */
export type ReachState =
  /** The agent loads it. */
  | 'reaches'
  /** No copy exists in any location this agent reads. */
  | 'absent'
  /**
   * A copy exists, but only where this agent does not look. The copy is real,
   * the directory is real, and the agent will never see it.
   */
  | 'unscanned'
  /**
   * A loadable copy sits exactly where this agent looks, and the agent did not
   * name it when asked. Nearly always nothing is wrong with the installation:
   * an agent reads its directories when it starts, and this one has not read
   * them since the copy arrived. The note says only that much, because a
   * definition an agent *refuses* to load is indistinguishable from here —
   * which is why the sheet, having asked an agent to re-read and been told it
   * did, says so when the entry is still in this state afterwards.
   *
   * This is the ordinary state of affairs in the seconds after this page
   * installs something, which is why it exists. Without it the install landed
   * and the cell beside it said `unscanned` — *installed where this agent does
   * not look* — about a file that had just been written into the one directory
   * the agent does look at. The single most important moment in the feature,
   * answered with the opposite of the truth.
   *
   * Only ever `reported`: reading directories cannot see it, because from
   * disk alone the copy simply reaches.
   */
  | 'stale'
  /**
   * The agent read the definition and would not load it, and said why.
   *
   * `stale` and this are the same bundle seen from disk — a `SKILL.md` is
   * present and the agent did not name it — and they need opposite responses:
   * one waits for the agent to look again, and looking again will never help
   * the other. The library could not tell them apart until agents were asked
   * for their rejections rather than only their skills; `SkillProblem` is
   * where that answer comes from, and the note carries the agent's own words
   * (Codex: *missing field `description`*).
   *
   * A defect, unlike `stale`: something on disk is wrong and a person can fix
   * it.
   */
  | 'rejected'
  /**
   * A directory bearing the name, holding no definition — no `SKILL.md`. An
   * agent that scans the parent lists the name and loads nothing.
   */
  | 'hollow'
  /**
   * Two or more loadable copies reach this agent's locations and their
   * contents disagree, so which one wins is a matter of scan order.
   */
  | 'differs'
  /**
   * MCP only. This agent's configuration format cannot represent the server
   * faithfully — a transport it has no spelling for. Writing it anyway would
   * persist something the agent reads back as a different server, so the
   * honest answer is that it cannot host this one.
   */
  | 'unhostable'
  /**
   * Installed, readable, and switched off in the agent itself.
   *
   * Only ever `reported`: a skill's on/off lives inside the agent's own
   * settings, and no amount of reading directories can see it. Which is how
   * this state came to be missing — `listSkills` has always answered with
   * each skill's `enabled` flag, and the scan threw it away, so a skill the
   * person had deliberately turned off was reported by the one page built to
   * be honest about reach as *Loads it*.
   *
   * Not a problem, and deliberately so. Somebody turned it off on purpose,
   * and a page that files a choice under defects teaches people to stop
   * reading its warnings.
   */
  | 'off'

/**
 * How a `ReachState` was arrived at, which is the difference between a fact
 * and a well-informed guess.
 *
 * `reported` — the runtime was asked and this is what it said it has. Ground
 * truth: no path table is consulted, so a runtime that moved its directories
 * between versions is still read correctly.
 *
 * `scanned` — the runtime could not be asked (it is not running, or it does
 * not implement `listSkills`), so the state comes from reading the disk and
 * consulting the location table. Correct until an agent changes where it
 * looks, which it does without announcement.
 */
export type ReachBasis = 'reported' | 'scanned'

/** One copy of an entry, as found on disk. */
export interface LibraryCopy {
  readonly path: string
  readonly scope: 'user' | 'project'
  /**
   * The runtimes whose *read* locations contain this path. Empty is the
   * finding, not an error: a copy nothing reads.
   */
  readonly readBy: readonly RuntimeId[]
  /** A directory holding no definition — the `hollow` state's evidence. */
  readonly hollow: boolean
  /**
   * A digest of the definition, for detecting `differs`. Null for a hollow
   * copy, which has nothing to digest.
   */
  readonly digest: string | null
  /** Shipped by an agent rather than installed by anyone. Never a write target. */
  readonly readOnly: boolean
}

/** Whether one entry reaches one runtime, and on what evidence. */
export interface LibraryReach {
  readonly runtime: RuntimeId
  readonly state: ReachState
  readonly basis: ReachBasis
  /** One sentence naming the reason, shown on the cell and in the detail. */
  readonly note?: string
  /**
   * The path *this runtime* knows the entry by, when it reported one.
   *
   * Not the same string as `LibraryCopy.path`, and the difference is not
   * cosmetic. A copy's path is the bundle directory this repository found on
   * disk (`~/.codex/skills/hatch-pet`); an agent may key the same skill by
   * its definition file (`~/.codex/skills/hatch-pet/SKILL.md`). Anything that
   * asks an agent to act on one of *its* skills has to use the agent's own
   * spelling.
   *
   * Measured, because the failure is silent: `runtime/skills/setEnabled` sent
   * with the bundle directory is accepted by Codex, written into its
   * `config.toml` as a `[[skills.config]]` entry, matched against nothing,
   * and the skill stays on. The write reports success, the config gains a
   * dead entry, and the switch springs back. Sent with this path, or with no
   * path at all so the agent matches by name, it works.
   *
   * Absent where the runtime was not asked or did not say — the caller then
   * falls back to the name, which is the only other thing both sides agree
   * on.
   */
  readonly reportedPath?: string
  /**
   * Whether this runtime will let a client switch the entry off.
   *
   * Only meaningful on a `reported` state, and false is the common answer: of
   * the four agents measured on 2026-08-31, only Codex implements the write.
   * Claude Code and Cursor answer over ACP, where a skill is a *command the
   * agent declares for the session* — there is no client-side switch, and
   * `SkillInfo.toggleable` has said so since the per-agent page was built.
   *
   * Carried here because the library is the one surface that shows several
   * agents at once, and a control drawn per agent has to know which of them
   * will accept it. Without this the sheet drew a switch on all three: Codex
   * worked, and the other two threw "This runtime does not let a client
   * toggle skills" and sprang back.
   */
  readonly toggleable?: boolean
}

/** One skill or one MCP server, wherever its copies live. */
export interface LibraryEntry {
  readonly kind: LibraryKind
  /** The identity the agents agree on: the directory name, or the server key. */
  readonly name: string
  readonly title?: string | null
  readonly description?: string | null
  readonly copies: readonly LibraryCopy[]
  /** One per runtime in `Library.runtimes`, in the same order. */
  readonly reach: readonly LibraryReach[]
  /**
   * What an agent pays, every turn, to know this exists: the catalogue line —
   * name and description — estimated in tokens (chars ÷ 3.6, the measured
   * rate for this frontmatter). Advertised is not used: the cost is paid
   * whether or not the skill ever fires, which is why it is worth a number.
   * Null where there is nothing to estimate from — a hollow entry, or an MCP
   * server, whose per-turn price is its tool schemas and not measurable here.
   */
  readonly catalogTokens?: number | null
}

/** A directory the library looked in, and what it is to the runtime that owns it. */
export interface LibraryLocation {
  readonly runtime: RuntimeId
  readonly kind: LibraryKind
  readonly path: string
  readonly scope: 'user' | 'project'
  /**
   * False for a path this runtime is known to *import* from rather than load
   * — the other agents' directories that its migration code knows about. A
   * copy found only in these is `unscanned`, and saying so is the point.
   */
  readonly scanned: boolean
  readonly exists: boolean
  readonly readOnly: boolean
}

/**
 * What the library could not establish, so that a quiet column is never
 * mistaken for an empty one.
 */
export interface LibraryGap {
  readonly runtime: RuntimeId
  readonly kind: LibraryKind
  /** Why this runtime's column is weaker than the others'. */
  readonly reason: string
}

/** The whole read model, assembled host-side on request. */
export interface Library {
  readonly generatedAt: number
  /**
   * The home directory every `~/…` row in the location table was resolved
   * against.
   *
   * Sent so the renderer can put the tilde back. Skill paths are long, deeply
   * nested and near-identical for their first forty characters, and printing
   * them in full made the sheet's evidence column a wall of the same prefix
   * eight times over — the part that identifies the copy pushed off the
   * right-hand edge by the part that identifies the machine.
   */
  readonly home: string
  /** Column order, and the index every `LibraryEntry.reach` is aligned to. */
  readonly runtimes: readonly RuntimeId[]
  readonly locations: readonly LibraryLocation[]
  readonly entries: readonly LibraryEntry[]
  readonly gaps: readonly LibraryGap[]
}

/** The counts the page leads with. Derived, so that every caller agrees. */
export interface LibrarySummary {
  readonly total: number
  /** Entries every runtime in the report can load. */
  readonly everywhere: number
  /** Entries at least one runtime cannot load, for any reason. */
  readonly partial: number
  /** Entries no runtime can load at all — present on disk, read by nobody. */
  readonly unreachable: number
  readonly hollow: number
  readonly differs: number
  /** Present in at least one agent and switched off there. */
  readonly off: number
}

/**
 * The states that are defects in the copy itself — something a person acts on.
 *
 * `unscanned` is deliberately not here. On a real machine it is the *most
 * common* state there is — this one holds sixty-five copies in a directory no
 * installed agent reads — and a "problem" that describes most of the world
 * describes nothing: with it in this set, the problems filter kept 82 of 82
 * rows and every row wore a warning glyph, which is the exact wall of noise
 * the marks were designed to avoid. A copy an agent cannot see is information,
 * and the ring still says it; it is not an alarm.
 */
/**
 * How often one skill actually fired, read from the conversations this desk
 * holds. Counted, never inferred: an activation is a `SKILL.md` load visible
 * in a stored item — a file read, a tool call, a slash-command echo. What the
 * desk never saw it never counts, and the page says so where it shows these.
 */
export interface LibraryUsageEntry {
  /** Stored conversations in which this skill fired at least once. */
  readonly sessions: number
  /** Individual activations across all of them. */
  readonly activations: number
  /** The most recent activation, epoch ms; 0 when no item carried a clock. */
  readonly lastAt: number
  /**
   * The same counts, split by the runtime id each conversation was stored
   * under. Keys are whatever id the transcript was recorded with — a retired
   * registration keeps its old id here, so the split can sum to less than
   * the totals against today's columns. A reader that shows this split must
   * show the remainder too; splitting away part of the truth is how a
   * per-agent number becomes a lie of omission.
   */
  readonly byRuntime: Readonly<Record<string, { readonly sessions: number; readonly activations: number }>>
}

/** What `library/usage` answers: per skill name, how often it really fired. */
export interface LibraryUsage {
  readonly generatedAt: number
  /** Stored conversations scanned, fired or not — the denominator's basis. */
  readonly sessionsScanned: number
  readonly skills: Readonly<Record<string, LibraryUsageEntry>>
}

/**
 * ——— The write path ———
 *
 * The read model above answers *what is*; the shapes below are how anything
 * changes. Two calls, always in this order:
 *
 * `library/plan` takes intents — what the person asked for, in their terms —
 * and answers with concrete operations: the exact path, the exact content, a
 * unified diff of what the write will do, and a digest of what the target
 * looked like when the plan was made. Nothing is touched.
 *
 * `library/apply` takes those operations back verbatim and performs them, one
 * by one, where **one failure never aborts the rest** — every op gets its own
 * result. Before each write the target is re-digested; a target that changed
 * since the preview fails that op alone, so the diff a person confirmed is
 * exactly the change that lands, or nothing is.
 *
 * The overwrite rule, host-enforced: a copy HarnessDesk wrote (its manifest
 * records path and digest) may be updated or removed freely. Anything else —
 * a copy someone else installed, or one of ours a person has since edited —
 * is never overwritten by an install. Only the explicit resolve and remove
 * flows may replace it, they say so in the plan, and they always keep a
 * backup.
 */

/** What the person asked for, before any path or diff exists. */
export type LibraryIntent =
  /** Copy a skill that exists somewhere into one agent's own directory. */
  | {
      readonly kind: 'installSkill'
      readonly name: string
      /** The copy to install from — a bundle directory or a flat `.md` file. */
      readonly sourcePath: string
      readonly targetRuntime: RuntimeId
    }
  /** A skill written in the app: full `SKILL.md` text, straight to agents. */
  | {
      readonly kind: 'authorSkill'
      readonly name: string
      readonly content: string
      readonly targetRuntimes: readonly RuntimeId[]
    }
  /**
   * The de-dupe: one copy is declared the winner and the named copies are
   * rewritten to match it. The only intent allowed to replace a copy the
   * manifest does not know, and it always backs the loser up first.
   */
  | {
      readonly kind: 'syncSkill'
      readonly name: string
      readonly sourcePath: string
      readonly targetPaths: readonly string[]
    }
  /** Remove one copy from disk — a hollow directory, or an uninstall. */
  | { readonly kind: 'removeCopy'; readonly name: string; readonly path: string }
  /**
   * Put back what an earlier operation filed: the backup becomes the copy
   * again, previewed like any other write — and whatever it replaces is
   * backed up in turn, so a restore is never the operation that loses data.
   */
  | {
      readonly kind: 'restoreCopy'
      readonly name: string
      /** The backup to restore from — always under the library's own backups. */
      readonly backupPath: string
      readonly targetPath: string
    }
  /** Copy one MCP server's declaration into another agent's configuration. */
  | {
      readonly kind: 'installMcp'
      readonly name: string
      /** The configuration file the declaration is read from. */
      readonly sourcePath: string
      readonly targetRuntime: RuntimeId
    }
  /** Remove one server's declaration from one configuration file. */
  | { readonly kind: 'removeMcp'; readonly name: string; readonly path: string }

/**
 * What one operation will do. `skip` and `refuse` are outcomes decided at
 * plan time and both carry their reason: `skip` because there is nothing to
 * do (already present, already identical), `refuse` because doing it would
 * be dishonest or destructive (a read-only root, a transport the target
 * cannot spell, a foreign copy an install may not overwrite).
 */
export type LibraryOpAction = 'create' | 'update' | 'replace' | 'remove' | 'skip' | 'refuse'

/** One concrete operation, previewed. What apply receives is exactly this. */
export interface LibraryPlannedOp {
  /** Unique within the plan; results are joined back on it. */
  readonly id: string
  readonly kind: LibraryKind
  readonly name: string
  readonly action: LibraryOpAction
  /** The bundle directory, flat file, or configuration file touched. */
  readonly targetPath: string
  readonly targetRuntime?: RuntimeId
  /** Unified diff of the definition this op writes or removes. */
  readonly preview?: string
  /** Bundle files beyond `SKILL.md` carried along, relative to the bundle. */
  readonly extraFiles?: readonly string[]
  /** Why a `skip` or `refuse` will not run; advisory notes on runnable ops. */
  readonly reason?: string
  /**
   * The definition text this op writes — `SKILL.md`, or one MCP entry as
   * canonical JSON. Carried on the wire so what was previewed is what is
   * written; apply never re-derives content from a source that may have
   * moved on.
   */
  readonly content?: string
  /** Where bundle `extraFiles` are copied from at apply time. */
  readonly sourcePath?: string
  /**
   * The target is a flat `<name>.md` definition rather than a bundle
   * directory — the spelling the copy already has is the spelling kept.
   */
  readonly flat?: boolean
  /**
   * Digest of the target's definition when the plan was made; null when the
   * plan saw nothing there. Apply re-digests and refuses this op alone on a
   * mismatch — the person confirmed a diff against this exact state.
   */
  readonly guardDigest: string | null
  /** The op will file a copy of what it replaces or removes before acting. */
  readonly backup: boolean
}

export interface LibraryPlan {
  readonly plannedAt: number
  readonly ops: readonly LibraryPlannedOp[]
}

/** What one operation did. Never aggregated: a batch answers per op. */
export interface LibraryOpResult {
  readonly id: string
  readonly outcome: 'done' | 'failed' | 'skipped'
  /** The reason, for anything that is not a plain `done`. */
  readonly detail?: string
  /** Where the replaced or removed content was filed, when it was. */
  readonly backupPath?: string
}

const PROBLEM: ReadonlySet<ReachState> = new Set<ReachState>([
  'hollow',
  'differs',
  'unhostable',
  'rejected',
])

/**
 * The states in which an agent does not load an entry *and nothing is wrong*.
 *
 * `off` is a switch somebody threw. Counting it as a failure to reach turns
 * "I turned this off in three of my four agents" into three warnings, which
 * is the fastest way to teach a person that this page's warnings are noise.
 *
 * `stale` is a skill that arrived a moment ago and an agent that has not
 * looked since. Filing the seconds after a successful install under defects
 * would make this page's own headline action generate its own warning.
 */
const NOT_A_FAULT: ReadonlySet<ReachState> = new Set<ReachState>(['off', 'stale'])

/** Whether a state is a defect — the cell wears the warning, not just a mark. */
export const isReachProblem = (state: ReachState): boolean => PROBLEM.has(state)

/**
 * Whether an entry has anything wrong with it anywhere.
 *
 * Four ways to qualify, and the last two are read off the *copies*, not the
 * cells: a hollow directory in a location no agent scans never becomes a
 * hollow cell — there is no agent to see it — and it is still a directory
 * wearing a skill's name with nothing inside. The 44 on this machine sit in
 * exactly such a location, which is how a predicate that only read cells
 * reported two problems under tiles that counted forty-eight.
 */
export const entryHasProblem = (entry: LibraryEntry): boolean => {
  if (entry.reach.some((reach) => isReachProblem(reach.state))) return true
  // On disk, loaded by nobody: nothing in it is broken, and it is still
  // exactly what the problems view exists to surface — *unless* the reason
  // nobody loads it is that somebody switched it off, which is an answer
  // rather than a finding.
  if (
    entry.reach.length > 0 &&
    entry.reach.every((reach) => reach.state !== 'reaches') &&
    !entry.reach.some((reach) => NOT_A_FAULT.has(reach.state))
  ) {
    return true
  }
  if (entry.copies.some((copy) => copy.hollow)) return true
  const digests = new Set(entry.copies.filter((copy) => !copy.hollow).map((copy) => copy.digest))
  return digests.size > 1
}

/**
 * The headline counts.
 *
 * `unreachable` is deliberately not folded into `partial`: an entry no agent
 * can load is a different kind of news from one that three of four can, and
 * collapsing them is how a page ends up reassuring rather than reporting.
 */
export const summarise = (library: Library): LibrarySummary => {
  let everywhere = 0
  let partial = 0
  let unreachable = 0
  let hollow = 0
  let differs = 0
  let off = 0

  for (const entry of library.entries) {
    if (entry.reach.some((one) => one.state === 'off')) off += 1
    const reaching = entry.reach.filter((one) => one.state === 'reaches').length
    if (reaching === entry.reach.length && reaching > 0) everywhere += 1
    else if (reaching === 0) unreachable += 1
    else partial += 1

    // Counted off the disk rather than off reach: a directory with nothing in
    // it is broken whether or not an agent currently scans its parent, and the
    // day one starts to, it breaks silently. Counting it only where some agent
    // already reads it would report the machine as healthier the fewer agents
    // are installed.
    if (entry.copies.some((copy) => copy.hollow)) hollow += 1
    const digests = new Set(
      entry.copies.filter((copy) => !copy.hollow).map((copy) => copy.digest),
    )
    if (digests.size > 1) differs += 1
  }

  return { total: library.entries.length, everywhere, partial, unreachable, hollow, differs, off }
}

/**
 * ——— Reading one entry ———
 *
 * Everything above answers *where* a skill is. None of it answers what the
 * skill actually says, and that omission is what made the library a page of
 * diagnostics rather than a page about skills: the most valuable thing on
 * disk — the instructions somebody wrote — was the one thing the app could
 * not show you.
 *
 * The two apps worth measuring against both lead with exactly this. Claude's
 * skill detail is a file tree beside the rendered `SKILL.md`; Codex's is the
 * rendered markdown with the bundle behind it. Neither shows a reach matrix,
 * and neither needs to — but neither can answer the question ours can, which
 * is why this is an addition and not a replacement.
 *
 * A read model like the rest of this file: `library/definition` takes one
 * copy's path and answers with its text and the files beside it. It writes
 * nothing, and the host confines the read to the same roots the write path
 * is confined to — the path crosses a socket, so it is checked there and not
 * trusted here.
 */

/** One file inside a skill bundle, relative to the bundle's own directory. */
export interface LibraryFile {
  /** Relative to the bundle root, `/`-separated. `SKILL.md` is always first. */
  readonly path: string
  readonly bytes: number
}

/**
 * One copy of one entry, read.
 *
 * `text` is the definition exactly as it sits on disk — frontmatter included,
 * because the frontmatter *is* what the agent reads to decide whether to fire
 * the skill, and a reader who cannot see it cannot debug that decision.
 */
export interface LibraryDefinition {
  readonly name: string
  readonly kind: LibraryKind
  /** The copy this was read from — one of the entry's own `copies`. */
  readonly path: string
  readonly text: string
  /**
   * True when `text` stops short of the file. A definition is prose meant for
   * a model to read, so anything past the cap is a generated payload rather
   * than something a person is reading here; the sheet says so where it shows
   * this rather than pretending the document ended.
   */
  readonly truncated: boolean
  /**
   * Every file in the bundle, `SKILL.md` first, then the rest depth-first by
   * path. Empty for a flat `<name>.md` definition, which is its own content
   * and has no bundle — the sheet reads that as "one file" rather than as a
   * failure to list any.
   */
  readonly files: readonly LibraryFile[]
  /** Bundle files beyond the cap, counted rather than listed. */
  readonly moreFiles: number
}

/**
 * A path as a person writes it: `~` where the home directory is.
 *
 * Lives here, in the package both sides already depend on, because both sides
 * need it and the alternative is two copies. The renderer prints these paths
 * in the sheet, the drawer and the history; the write engine prints them in
 * the `---`/`+++` labels of every diff it previews and files. Two
 * implementations of one rule is how one of them quietly stops handling a
 * `HOME` with a trailing slash while the other still does.
 *
 * `home` is a parameter rather than a lookup: this module runs in a renderer
 * that has no home directory of its own — it is drawing a report about the
 * host's, and `Library.home` says which one. Given nothing usable, the path
 * comes back untouched; a wrong tilde is worse than a long path.
 */
export const shortPath = (path: string, home: string | undefined | null): string => {
  if (!home || home === '/') return path
  const root = home.endsWith('/') ? home.slice(0, -1) : home
  if (root === '' || root === '/') return path
  if (path === root) return '~'
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}
