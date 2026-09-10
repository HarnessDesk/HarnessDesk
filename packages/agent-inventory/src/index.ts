import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { digestOf } from './digest.js'
import { canHostMcp, canonicalMcp, decodeMcpEntry, dialectFor, type McpServerSpec } from './mcp.js'
import {
  expand,
  extraSkillRoots,
  insideRoots,
  knownRoots,
  locate,
  LOCATIONS,
  type LocationSpec,
  type McpFileSpec,
} from './locations.js'

export { unifiedDiff } from './diff.js'
export { LibraryManifest, type ManifestEntry } from './manifest.js'
export {
  canHostMcp,
  decodeMcpEntry,
  dialectFor,
  readRawMcpEntry,
  type McpDialect,
  type McpServerSpec,
} from './mcp.js'
export {
  applyLibrary,
  planLibrary,
  type WriteAgent,
  type WriteContext,
} from './writes.js'

import type {
  Library,
  LibraryCopy,
  LibraryDefinition,
  LibraryEntry,
  LibraryFile,
  LibraryGap,
  LibraryKind,
  LibraryLocation,
  LibraryReach,
  ReachState,
  RuntimeId,
} from '@harnessdesk/protocol'

/**
 * The library scanner.
 *
 * **This package holds no HarnessDesk.** It imports node builtins and the
 * protocol's types, and what it needs from a running agent is the one
 * interface below rather than an `AgentRuntime`. That is deliberate: the read
 * model is the half of the control plane that can run without the desk, and
 * keeping the seam honest while the only caller is ours costs nothing, where
 * discovering it later costs a rewrite. What cannot leave — observing turns,
 * composing a launch — never enters here.
 *
 * Two sources, and the order between them is the whole design:
 *
 * 1. **What each runtime says it loaded.** `AgentRuntime.listSkills` is the
 *    agent's own answer, so where a runtime implements it the reach of every
 *    skill is *measured* and no path table is consulted at all.
 * 2. **What is on disk.** The table below says where each agent keeps things.
 *    It is a fallback for runtimes that cannot be asked, and — for every
 *    runtime — the only way to find a copy that exists but is not loaded,
 *    which is the finding the library exists to surface.
 *
 * The table is written knowing it will go stale. Agents move their directories
 * between releases without announcement, which is exactly why (1) outranks it.
 *
 * **On `.agents/`.** Published guidance says `~/.agents/skills` is the shared
 * cross-agent location and that eight or more agents read it. Measured, it is
 * read by one: Claude Code 2.1.240 and the Gemini CLI bundle carry no
 * reference to it at all, Cursor's single reference sits in its import
 * machinery beside the other agents' directories — and Codex 0.149.0 *loads*
 * it, which the table said it did not until a real app-server was asked
 * `skills/list` against a temporary `$HOME` on 2026-09-06 and answered with
 * those skills, paths and all. Reading a binary for the string had found only
 * the import path and concluded the wrong thing. So: `scanned` per build, and
 * per build **measured by asking it**, not by grepping it.
 */

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const readDir = (path: string): readonly string[] => {
  try {
    return readdirSync(path).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}


/**
 * The frontmatter fields the Agent Skills format puts at the top of a bundle.
 *
 * Deliberately not a YAML parser, and deliberately lenient in the two ways
 * real skills need:
 *
 * **Unquoted colons.** `description: Use this when: the user asks` is invalid
 * YAML that every agent's parser accepts in practice. Taking the remainder of
 * the line verbatim reads it the way they do; rejecting it would drop real
 * skills out of the report.
 *
 * **Block scalars.** `description: |` puts the text on the following indented
 * lines. Found by running this against a real machine, where sixty skills
 * showed a description of `|` — the literal marker, read as the value.
 */
const frontmatter = (body: string): { name?: string; description?: string } => {
  if (!body.startsWith('---')) return {}
  const end = body.indexOf('\n---', 3)
  if (end === -1) return {}
  const out: { name?: string; description?: string } = {}
  const lines = body.slice(3, end).split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    // Only a top-level key: an indented line belongs to the value above it.
    if (/^\s/.test(line)) continue
    const at = line.indexOf(':')
    if (at === -1) continue
    const key = line.slice(0, at).trim()
    if (key !== 'name' && key !== 'description') continue

    const raw = line.slice(at + 1).trim()
    let value: string
    if (/^[|>][+-]?$/.test(raw)) {
      // A block scalar: every following indented line, folded to one line so
      // it fits a table row the way a one-line description would.
      const block: string[] = []
      let next = index + 1
      while (next < lines.length && (lines[next] === '' || /^\s/.test(lines[next] ?? ''))) {
        block.push((lines[next] ?? '').trim())
        next += 1
      }
      index = next - 1
      value = block.join(' ').replace(/\s+/g, ' ').trim()
    } else {
      value = raw.replace(/^["']|["']$/g, '')
    }
    if (key === 'name') out.name = value
    else out.description = value
  }
  return out
}

interface FoundCopy {
  readonly name: string
  readonly path: string
  readonly scope: 'user' | 'project'
  readonly hollow: boolean
  readonly digest: string | null
  readonly readOnly: boolean
  readonly title?: string
  readonly description?: string
}

/**
 * One skills directory, read.
 *
 * A subdirectory with no `SKILL.md` and no flat definition is `hollow` rather
 * than skipped: an agent scanning the parent lists the name and loads nothing,
 * so silence here would hide exactly the failure worth reporting.
 */
const readSkillRoot = (root: string, spec: LocationSpec): readonly FoundCopy[] => {
  const out: FoundCopy[] = []
  for (const name of readDir(root)) {
    const path = join(root, name)
    if (isDir(path)) {
      let body: string | null = null
      try {
        body = readFileSync(join(path, 'SKILL.md'), 'utf8')
      } catch {
        body = null
      }
      const meta = body === null ? {} : frontmatter(body)
      out.push({
        name,
        path,
        scope: spec.scope,
        hollow: body === null,
        digest: body === null ? null : digestOf(body),
        readOnly: spec.readOnly === true,
        ...(meta.name ? { title: meta.name } : {}),
        ...(meta.description ? { description: meta.description } : {}),
      })
      continue
    }
    if (!name.endsWith('.md')) continue
    let body = ''
    try {
      body = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const meta = frontmatter(body)
    out.push({
      name: name.slice(0, -3),
      path,
      scope: spec.scope,
      hollow: false,
      digest: digestOf(body),
      readOnly: spec.readOnly === true,
      ...(meta.name ? { title: meta.name } : {}),
      ...(meta.description ? { description: meta.description } : {}),
    })
  }
  return out
}

/**
 * MCP servers out of one configuration file.
 *
 * The schema is shared even where the file is not: `mcpServers` in JSON and
 * `mcp_servers` in TOML carry the same object of name → declaration in every
 * agent measured. Only the location and the serialisation differ, so one
 * minimal reader covers all of them, and a file it cannot parse contributes
 * nothing rather than throwing the whole scan away.
 */
const readMcpFile = (path: string, spec: McpFileSpec): readonly FoundCopy[] => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  let servers: Record<string, unknown> = {}
  if (spec.format === 'json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const found = parsed[spec.key]
      if (found && typeof found === 'object') servers = found as Record<string, unknown>
    } catch {
      return []
    }
  } else {
    // A dependency-free reader for the one shape that matters: the
    // `[mcp_servers.<name>]` tables. Anything else in the file is ignored.
    //
    // The name is the FIRST segment only. A server that declares sub-tables —
    // `[mcp_servers.browser.tools.click]` is a real shape in the wild — would
    // otherwise arrive as one library row per tool, which reads as six servers
    // where the user configured one.
    const head = new RegExp(`^\\s*\\[${spec.key}\\.([^\\]]+)\\]`)
    let current: string | null = null
    const body: Record<string, string[]> = {}
    for (const line of text.split('\n')) {
      const match = head.exec(line)
      if (match?.[1]) {
        const first = /^\s*(?:"([^"]+)"|'([^']+)'|([^.\s]+))/.exec(match[1])
        current = first?.[1] ?? first?.[2] ?? first?.[3] ?? null
        if (current !== null) body[current] ??= []
        continue
      }
      if (/^\s*\[/.test(line)) {
        current = null
        continue
      }
      if (current) body[current]?.push(line)
    }
    servers = Object.fromEntries(
      Object.entries(body).map(([name, lines]) => [name, lines.join('\n')]),
    )
  }

  return Object.entries(servers).map(([name, value]) => ({
    name,
    path,
    scope: spec.scope,
    hollow: false,
    digest: digestOf(typeof value === 'string' ? value : JSON.stringify(value)),
    readOnly: false,
    ...(describeServer(value) ? { description: describeServer(value) } : {}),
  }))
}

/** A one-line summary of a server declaration, in the user's terms, not the wire's. */
const describeServer = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const command = /command\s*=\s*"([^"]+)"/.exec(value)?.[1]
    const url = /url\s*=\s*"([^"]+)"/.exec(value)?.[1]
    return url ? `Remote · ${url}` : command ? `Runs ${command}` : undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record['url'] === 'string') return `Remote · ${record['url']}`
  if (typeof record['command'] === 'string') return `Runs ${record['command']}`
  return undefined
}

interface RuntimeScan {
  readonly runtime: RuntimeId
  readonly brand: string
  readonly locations: readonly LibraryLocation[]
  /** Names the runtime itself reported, when it could be asked. */
  readonly reported: ReadonlySet<string> | null
  /**
   * Of those, the ones it reported as switched off. A subset of `reported`,
   * never a separate list: a skill the agent did not mention at all is not
   * "off", it is one of the four states the disk explains.
   */
  readonly reportedOff: ReadonlySet<string>
  /** Name → the path the runtime itself gave for it, where it gave one. */
  readonly reportedPaths: ReadonlyMap<string, string>
  /** Names the runtime said a client may not switch. */
  readonly reportedFixed: ReadonlySet<string>
  /**
   * Definition paths the runtime read and refused, with its reason. Keyed by
   * the agent's own spelling of the path, which is the `SKILL.md` rather than
   * the bundle directory.
   */
  readonly reportedProblems: ReadonlyMap<string, string>
  readonly reportedFailure?: string
}

/**
 * What the scanner needs from an agent, which is much less than an agent.
 *
 * Two fields and one optional method. A caller that has real runtimes adapts
 * them to this (the host does); a caller that has none — a command line run
 * against a machine with nothing started — passes an empty list and gets a
 * report read entirely from disk, which is weaker and says so through
 * `ReachBasis`.
 */
export interface InventoryAgent {
  readonly id: RuntimeId
  /**
   * The vendor key the location table is written against — `codex`, `claude`,
   * `cursor`. Not the runtime id, which for an ACP agent is whatever the
   * user's registry happened to call it.
   */
  readonly brand: string
  /**
   * What the agent itself says it loaded. The whole reason reach is measured
   * rather than assumed: where this answers, no path table is consulted.
   *
   * `enabled` is read where the agent reports it. It was in this answer all
   * along — `SkillInfo` has carried it since the per-agent settings page was
   * built — and narrowing the parameter to `{ name }` is precisely how the
   * library came to report a switched-off skill as one the agent loads.
   * Absent means on, because an agent that does not model the distinction
   * has nothing switched off.
   */
  listSkills?(
    cwd?: string,
  ): Promise<
    readonly {
      readonly name: string
      readonly enabled?: boolean
      /**
       * What the agent calls this skill's location. Carried through to
       * `LibraryReach.reportedPath` because an agent asked to act on one of
       * its own skills must be addressed in its own spelling — see the note
       * there for the silent failure this exists to prevent.
       */
      readonly path?: string | null
      /**
       * Whether the agent will let a client switch it off. Absent means yes;
       * an agent that only *declares* what it has says false, and the library
       * must not offer a control that agent would refuse.
       */
      readonly toggleable?: boolean
    }[]
  >
  /**
   * Definitions the agent read and refused, with its own reason for each.
   *
   * Optional, and the difference between a library that can tell "not
   * re-read yet" from "will never load" and one that cannot. Measured on
   * Codex 0.149.0: `skills/list` returns these beside the skills, naming the
   * file and the fault. An agent that does not report them leaves the method
   * out and its rejected definitions go on looking merely unread — which is
   * where every agent was before this.
   */
  listSkillProblems?(cwd?: string): Promise<readonly { readonly path: string; readonly message: string }[]>
}

const scanRuntime = async (
  runtime: InventoryAgent,
  cwd: string | undefined,
  home: string,
): Promise<RuntimeScan> => {
  const brand = runtime.brand
  const table = LOCATIONS[brand]
  const specs: readonly (LocationSpec & { kind: LibraryKind })[] = [
    ...(table?.skills ?? []).map((one) => ({ ...one, kind: 'skill' as const })),
  ]

  const locations: LibraryLocation[] = []
  for (const spec of specs) {
    const path = spec.scope === 'project' ? (cwd ? resolve(cwd, spec.path) : null) : expand(spec.path, home)
    if (path === null) continue
    locations.push({
      runtime: runtime.id,
      kind: spec.kind,
      path,
      scope: spec.scope,
      scanned: spec.scanned,
      exists: isDir(path),
      readOnly: spec.readOnly === true,
    })
  }
  for (const spec of table?.mcp ?? []) {
    const path = spec.scope === 'project' ? (cwd ? resolve(cwd, spec.path) : null) : expand(spec.path, home)
    if (path === null) continue
    let exists = false
    try {
      exists = statSync(path).isFile()
    } catch {
      exists = false
    }
    locations.push({
      runtime: runtime.id,
      kind: 'mcp',
      path,
      scope: spec.scope,
      scanned: spec.scanned,
      exists,
      readOnly: false,
    })
  }

  // The agent's own answer, where there is one. A runtime that throws here is
  // recorded as a gap rather than being allowed to read as "has no skills".
  let reported: ReadonlySet<string> | null = null
  let reportedOff: ReadonlySet<string> = new Set()
  let reportedPaths: ReadonlyMap<string, string> = new Map()
  let reportedFixed: ReadonlySet<string> = new Set()
  let reportedProblems: ReadonlyMap<string, string> = new Map()
  let reportedFailure: string | undefined
  if (runtime.listSkills) {
    try {
      const skills = await runtime.listSkills(cwd)
      reported = new Set(skills.map((skill) => skill.name))
      reportedOff = new Set(
        skills.filter((skill) => skill.enabled === false).map((skill) => skill.name),
      )
      reportedPaths = new Map(
        skills
          .filter((skill) => typeof skill.path === 'string' && skill.path !== '')
          .map((skill) => [skill.name, skill.path as string]),
      )
      reportedFixed = new Set(
        skills.filter((skill) => skill.toggleable === false).map((skill) => skill.name),
      )
    } catch (error) {
      reportedFailure = error instanceof Error ? error.message : String(error)
    }
  }
  // Asked separately, and never allowed to fail the scan: the skills list is
  // the answer whose silence would be a lie, and this one is an extra. A
  // runtime that cannot produce it leaves the library exactly as informed as
  // it was before the method existed.
  if (runtime.listSkillProblems && reported !== null) {
    try {
      const problems = await runtime.listSkillProblems(cwd)
      reportedProblems = new Map(
        problems
          .filter((one) => typeof one.path === 'string' && one.path !== '')
          .map((one) => [one.path, one.message]),
      )
    } catch {
      // Nothing is claimed on a failure here.
    }
  }

  return {
    runtime: runtime.id,
    brand,
    locations,
    reported,
    reportedOff,
    reportedPaths,
    reportedFixed,
    reportedProblems,
    ...(reportedFailure ? { reportedFailure } : {}),
  }
}

/** Where a copy sits, for the runtimes that read that directory. */
const readersOf = (
  path: string,
  scans: readonly RuntimeScan[],
  kind: LibraryKind,
): readonly RuntimeId[] =>
  scans
    .filter((scan) =>
      scan.locations.some(
        (one) => one.kind === kind && one.scanned && (one.path === path || path.startsWith(`${one.path}/`)),
      ),
    )
    .map((scan) => scan.runtime)

/**
 * One (entry, runtime) verdict.
 *
 * `reported` outranks everything: if the agent said it loaded the skill, it
 * reaches, whatever the paths suggest. The disk is then only consulted to
 * explain a name the agent did *not* report.
 */
/**
 * The agent's reason for refusing a copy, if it gave one.
 *
 * An agent names the *definition file* and this package tracks the *bundle
 * directory*, which is the same difference `LibraryReach.reportedPath`
 * documents — so a problem inside the directory counts as a problem with it.
 */
const rejectionFor = (path: string, scan: RuntimeScan): string | null => {
  const exact = scan.reportedProblems.get(path)
  if (exact !== undefined) return exact
  for (const [reported, message] of scan.reportedProblems) {
    if (reported.startsWith(`${path}/`)) return message
  }
  return null
}

const reachFor = (
  name: string,
  copies: readonly LibraryCopy[],
  scan: RuntimeScan,
  kind: LibraryKind,
  spec?: McpServerSpec,
): LibraryReach => {
  const mine = copies.filter((copy) => copy.readBy.includes(scan.runtime))
  const loadable = mine.filter((copy) => !copy.hollow)

  if (kind === 'skill' && scan.reported !== null) {
    // Switched off is checked before loaded, because an agent lists a
    // disabled skill among the ones it knows about — that is what makes it
    // reportable at all — and reading the list without the flag is exactly
    // the bug this branch exists to fix.
    const reportedPath = scan.reportedPaths.get(name)
    // Absent means yes, matching `SkillInfo.toggleable`: an agent that does
    // not model the distinction has nothing it refuses to switch.
    const toggleable = !scan.reportedFixed.has(name)
    if (scan.reportedOff.has(name)) {
      return {
        runtime: scan.runtime,
        state: 'off',
        basis: 'reported',
        note: 'Installed and switched off in this agent’s own settings, so nothing loads it here.',
        toggleable,
        ...(reportedPath !== undefined ? { reportedPath } : {}),
      }
    }
    if (scan.reported.has(name)) {
      const digests = new Set(loadable.map((copy) => copy.digest))
      if (digests.size > 1) {
        return {
          runtime: scan.runtime,
          state: 'differs',
          basis: 'reported',
          note: `Loaded, but ${digests.size} copies in its own directories disagree — which one wins depends on scan order.`,
        }
      }
      return {
        runtime: scan.runtime,
        state: 'reaches',
        basis: 'reported',
        toggleable,
        ...(reportedPath !== undefined ? { reportedPath } : {}),
      }
    }
    // The agent was asked and did not name it. Anything on disk is therefore
    // somewhere it does not look, or unloadable — both worth saying precisely.
    if (mine.some((copy) => copy.hollow)) {
      return {
        runtime: scan.runtime,
        state: 'hollow',
        basis: 'reported',
        note: 'A directory of this name sits where this agent looks, with no definition inside it.',
      }
    }
    // Asked, and it told us why it would not take this one. That is a
    // different answer from "it has not looked yet", and the difference is
    // that looking again cannot help — so it is said in the agent's own
    // words rather than left to look transient for ever.
    const refused = loadable
      .map((copy) => rejectionFor(copy.path, scan))
      .find((message) => message !== null)
    if (refused) {
      return { runtime: scan.runtime, state: 'rejected', basis: 'reported', note: refused }
    }
    // A loadable copy sitting exactly where this agent looks, absent from the
    // list it gave us. The install worked; the agent read its directories
    // when it started and has not read them since. Calling that `unscanned`
    // — *installed where this agent does not look* — was this page telling
    // somebody their brand-new copy was in the wrong place, on the screen
    // directly after writing it into the right one.
    if (loadable.length > 0) {
      return {
        runtime: scan.runtime,
        state: 'stale',
        basis: 'reported',
        // The *fact*, not a cause. Nearly always the agent simply has not
        // re-read since — which is what the sheet offers to fix — but a
        // definition an agent refuses to load looks identical from here, and
        // a note that named the reason would be confidently wrong about it.
        note: 'Installed where this agent looks, and absent from the list it reported.',
      }
    }
    if (copies.length > 0) {
      return {
        runtime: scan.runtime,
        state: 'unscanned',
        basis: 'reported',
        note: 'On disk, but not in any directory this agent reads — it did not report it.',
      }
    }
    return { runtime: scan.runtime, state: 'absent', basis: 'reported' }
  }

  if (kind === 'mcp') {
    if (mine.length > 0) {
      return { runtime: scan.runtime, state: 'reaches', basis: 'scanned' }
    }
    // The write path's own preflight, asked in the read direction: would this
    // agent's format carry the declaration faithfully? Only a *representational*
    // refusal earns the loud state — an agent with no known configuration file
    // at all is already a column gap, and repeating it per row would put a
    // warning glyph on every server for that agent, which is the exact wall of
    // noise 35.1a removed.
    if (copies.length > 0 && spec !== undefined) {
      const dialect = dialectFor(scan.brand)
      if (dialect !== null) {
        const verdict = canHostMcp(dialect, spec)
        if (!verdict.ok) {
          return { runtime: scan.runtime, state: 'unhostable', basis: 'scanned', note: verdict.reason }
        }
      }
    }
  }

  if (loadable.length > 1) {
    const digests = new Set(loadable.map((copy) => copy.digest))
    if (digests.size > 1) {
      return {
        runtime: scan.runtime,
        state: 'differs',
        basis: 'scanned',
        note: `${digests.size} copies in this agent’s directories disagree.`,
      }
    }
  }
  if (loadable.length > 0) return { runtime: scan.runtime, state: 'reaches', basis: 'scanned' }
  if (mine.length > 0) {
    return {
      runtime: scan.runtime,
      state: 'hollow',
      basis: 'scanned',
      note: 'A directory of this name, with no definition inside it.',
    }
  }
  if (copies.length > 0) {
    return {
      runtime: scan.runtime,
      state: 'unscanned',
      basis: 'scanned',
      // A server lives in a configuration file and a skill in a directory;
      // one sentence for both would be wrong for whichever it was not written
      // for, and this note is the page's evidence rather than its decoration.
      note:
        kind === 'mcp'
          ? 'Configured for another agent, in a file this one does not read.'
          : 'On disk, but not in any directory this agent reads.',
    }
  }
  return { runtime: scan.runtime, state: 'absent', basis: 'scanned' }
}

/**
 * Build the library.
 *
 * Runtimes are asked in parallel and a failure to answer never fails the
 * report — it becomes a `LibraryGap`, so a column that is weaker than the
 * others says so instead of looking empty.
 */
export const readLibrary = async (
  runtimes: readonly InventoryAgent[],
  options: { readonly cwd?: string; readonly home?: string } = {},
): Promise<Library> => {
  const cwd = normaliseCwd(options.cwd)
  const home = options.home ?? homedir()
  const scans = await Promise.all(runtimes.map((runtime) => scanRuntime(runtime, cwd, home)))

  // Every skills directory anyone might use, including the ones nobody loads.
  const roots = new Map<string, LocationSpec>()
  for (const scan of scans) {
    for (const location of scan.locations) {
      if (location.kind !== 'skill') continue
      roots.set(location.path, {
        path: location.path,
        scope: location.scope,
        scanned: location.scanned,
        readOnly: location.readOnly,
      })
    }
  }
  for (const spec of extraSkillRoots) {
    const path = spec.scope === 'project' ? (cwd ? resolve(cwd, spec.path) : null) : expand(spec.path, home)
    if (path !== null && !roots.has(path)) roots.set(path, { ...spec, path })
  }

  const found = new Map<string, { kind: LibraryKind; copies: FoundCopy[] }>()
  const add = (kind: LibraryKind, copy: FoundCopy) => {
    const key = `${kind}:${copy.name}`
    const bucket = found.get(key) ?? { kind, copies: [] }
    bucket.copies.push(copy)
    found.set(key, bucket)
  }

  for (const [path, spec] of roots) {
    if (!isDir(path)) continue
    for (const copy of readSkillRoot(path, spec)) add('skill', copy)
  }

  const seenMcp = new Set<string>()
  // One canonical spec per server name, decoded from the first file that
  // declares it — what `reachFor` asks canHostMcp about.
  const mcpSpecs = new Map<string, McpServerSpec>()
  // The canonical digest of each individual copy, keyed by file + name. The
  // raw per-dialect text is not comparable across brands, so digesting it made
  // one server correctly present in two agents read as `differs` forever;
  // digesting the decoded spec makes identical servers compare equal.
  const mcpDigests = new Map<string, string>()
  for (const scan of scans) {
    const table = LOCATIONS[scan.brand]
    for (const spec of table?.mcp ?? []) {
      const path =
        spec.scope === 'project' ? (cwd ? resolve(cwd, spec.path) : null) : expand(spec.path, home)
      if (path === null || seenMcp.has(path)) continue
      seenMcp.add(path)
      const copies = readMcpFile(path, spec)
      for (const copy of copies) add('mcp', copy)
      const dialect = dialectFor(scan.brand)
      if (dialect === null) continue
      let text: string | null = null
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        text = null
      }
      for (const copy of copies) {
        const decoded = decodeMcpEntry(text, spec.format, spec.key, copy.name, dialect)
        if (decoded === null) continue
        mcpDigests.set(JSON.stringify([copy.path, copy.name]), digestOf(canonicalMcp(decoded)))
        if (!mcpSpecs.has(copy.name)) mcpSpecs.set(copy.name, decoded)
      }
    }
  }

  const entries: LibraryEntry[] = []
  for (const [, bucket] of found) {
    const copies: LibraryCopy[] = bucket.copies.map((copy) => ({
      path: copy.path,
      scope: copy.scope,
      readBy: readersOf(copy.path, scans, bucket.kind),
      hollow: copy.hollow,
      // MCP copies compare by their decoded spec, not their per-dialect text,
      // so the same server across two brands is not falsely `differs`. Skills
      // keep their definition-text digest. A copy that could not be decoded
      // faithfully falls back to its raw digest — genuinely its own state.
      digest:
        bucket.kind === 'mcp'
          ? (mcpDigests.get(JSON.stringify([copy.path, copy.name])) ?? copy.digest)
          : copy.digest,
      readOnly: copy.readOnly,
    }))
    const named = bucket.copies.find((copy) => copy.title ?? copy.description)
    const name = bucket.copies[0]?.name ?? ''
    // The catalogue line an agent carries for this skill on every turn is its
    // name and description; ÷3.6 is the measured chars-per-token rate for
    // this frontmatter (66 skills, 24,612 chars, ~6,836 tokens). An estimate,
    // and labelled as one wherever it is shown. MCP servers pay in tool
    // schemas this scanner never sees, so they get null, not a guess.
    const advertised =
      bucket.kind === 'skill' && (named?.title ?? named?.description ?? name) !== ''
        ? `${named?.title ?? name} ${named?.description ?? ''}`.trim()
        : null
    entries.push({
      kind: bucket.kind,
      name,
      title: named?.title ?? null,
      description: named?.description ?? null,
      copies,
      reach: scans.map((scan) =>
        reachFor(
          name,
          copies,
          scan,
          bucket.kind,
          bucket.kind === 'mcp' ? mcpSpecs.get(name) : undefined,
        ),
      ),
      catalogTokens: advertised === null ? null : Math.round(advertised.length / 3.6),
    })
  }

  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))

  const gaps: LibraryGap[] = []
  for (const scan of scans) {
    if (scan.reportedFailure !== undefined) {
      gaps.push({
        runtime: scan.runtime,
        kind: 'skill',
        reason: `This agent could not be asked what it loaded, so its column is read from disk: ${scan.reportedFailure}`,
      })
    } else if (scan.reported === null) {
      gaps.push({
        runtime: scan.runtime,
        kind: 'skill',
        reason:
          'This agent does not report what it loaded, so its column is read from disk and is only as current as the directories this build knows about.',
      })
    }
    if (!LOCATIONS[scan.brand]) {
      gaps.push({
        runtime: scan.runtime,
        kind: 'mcp',
        reason: 'No configuration location is known for this agent, so its servers cannot be read.',
      })
    }
  }

  return {
    generatedAt: Date.now(),
    home,
    runtimes: scans.map((scan) => scan.runtime),
    locations: scans.flatMap((scan) => scan.locations),
    entries,
    gaps,
  }
}

/**
 * The activation detector: which skills does this text show being loaded?
 *
 * A skill activation, in every shape the stored conversations actually take,
 * is a path ending `/<name>/SKILL.md` — Codex `cat`s the file in a `command`
 * item, Claude Code reads it in a tool call, a slash-command echo links it in
 * a user message. The immediate parent directory *is* the skill's identity
 * (the specification says so, and it is what survives `.system/` and
 * bundled-skill paths where the segment after `skills/` is not the name). So
 * one conservative pattern covers every agent, and what it cannot see — an
 * agent that inlines skill bodies without naming the file — it does not
 * guess at.
 */
const ACTIVATION = /\/([A-Za-z0-9._-]+)\/SKILL\.md/g

export const detectSkillActivations = (text: string): readonly string[] => {
  const names = new Set<string>()
  for (const match of text.matchAll(ACTIVATION)) {
    const name = match[1]
    if (name !== undefined && name !== '.' && name !== '..') names.add(name)
  }
  return [...names]
}

/**
 * ——— One entry, read ———
 *
 * `readLibrary` answers where every skill is; this answers what one of them
 * says. The split is deliberate: the report walks every root on every call
 * and must stay cheap, and a definition is only wanted for the one entry
 * somebody opened.
 */

/** Bundle files past this are counted, not listed. A tree is not a filesystem. */
const MAX_BUNDLE_FILES = 200

/** How deep into a bundle the listing walks before it stops descending. */
const MAX_BUNDLE_DEPTH = 4

/**
 * How much of a definition travels.
 *
 * A `SKILL.md` is prose a model reads; the ones measured on this machine run
 * to a few thousand characters and the largest is under 40k. Past the cap
 * what is there is a generated payload rather than something a person is
 * reading in a sheet, so it is cut and *said to be cut* — a reader who
 * cannot tell a truncated document from a complete one has been lied to
 * about what the agent loads.
 */
const MAX_DEFINITION_BYTES = 256 * 1024

/** Every file under a bundle, breadth-first, bounded in both count and depth. */
const walkBundle = (root: string): { files: LibraryFile[]; more: number } => {
  const files: LibraryFile[] = []
  let more = 0
  const queue: { dir: string; prefix: string; depth: number }[] = [
    { dir: root, prefix: '', depth: 0 },
  ]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    for (const name of readDir(next.dir)) {
      const full = join(next.dir, name)
      const relative = next.prefix === '' ? name : `${next.prefix}/${name}`
      if (isDir(full)) {
        if (next.depth + 1 <= MAX_BUNDLE_DEPTH) {
          queue.push({ dir: full, prefix: relative, depth: next.depth + 1 })
        }
        continue
      }
      if (files.length >= MAX_BUNDLE_FILES) {
        more += 1
        continue
      }
      let bytes = 0
      try {
        bytes = statSync(full).size
      } catch {
        continue
      }
      files.push({ path: relative, bytes })
    }
  }
  // `SKILL.md` first — it is the definition, and everything else in the
  // bundle exists to be referenced by it. The rest sort by path so a bundle
  // reads the same on every platform, `readdir` order being neither sorted
  // nor stable across filesystems.
  files.sort((a, b) => {
    if (a.path === 'SKILL.md') return -1
    if (b.path === 'SKILL.md') return 1
    return a.path.localeCompare(b.path)
  })
  return { files, more }
}

/**
 * One copy's definition and the files beside it.
 *
 * The path is checked against the same roots the write path is confined to
 * before anything is opened. The renderer read it out of a `LibraryEntry`,
 * but it crossed a socket on the way here, and a read confined by the
 * caller's honesty is not confined.
 *
 * Answers null rather than throwing for every ordinary miss — outside the
 * roots, no definition inside, gone since the report was made — because the
 * sheet asking for it has a perfectly good thing to say about a definition
 * it cannot read, and an exception would take the whole page instead.
 */
export const readDefinition = (
  request: { readonly kind: LibraryKind; readonly name: string; readonly path: string },
  options: { readonly cwd?: string; readonly home?: string } = {},
): LibraryDefinition | null => {
  const cwd = normaliseCwd(options.cwd)
  const home = options.home ?? homedir()
  // Both kinds are checked against the skill roots as well: a `.md` sitting
  // in a skills directory is a legitimate flat definition, and an MCP
  // config file is only ever read from its own table.
  const roots = [...knownRoots('skill', home, cwd), ...knownRoots('mcp', home, cwd)]
  if (!insideRoots(request.path, roots)) return null

  const bundle = isDir(request.path)
  const definitionPath = bundle ? join(request.path, 'SKILL.md') : request.path

  let text: string
  try {
    text = readFileSync(definitionPath, 'utf8')
  } catch {
    return null
  }

  const truncated = text.length > MAX_DEFINITION_BYTES
  const { files, more } = bundle
    ? walkBundle(request.path)
    : // A flat `<name>.md` is its own bundle of one. Listing nothing would
      // read as "the bundle is empty", which is the hollow state's sentence
      // and not true of a file that holds the whole definition.
      {
        files: [
          {
            /* `basename`, not a slice at the last `/`. On Windows the
               separator is `\\`, `lastIndexOf('/')` answers -1, and
               `slice(0)` hands back the whole absolute path where a bare
               filename was wanted — so the bundle manifest listed
               `C:\\Users\\…\\skill.md` as the file's name. `basename`
               is the platform's own rule for this and needs no branch. */
            path: basename(request.path),
            bytes: Buffer.byteLength(text),
          },
        ],
        more: 0,
      }

  return {
    name: request.name,
    kind: request.kind,
    path: request.path,
    text: truncated ? text.slice(0, MAX_DEFINITION_BYTES) : text,
    truncated,
    files,
    moreFiles: more,
  }
}

/** Exported for the tests, which drive the readers directly. */
export const internals = { frontmatter, digestOf, readSkillRoot, readMcpFile, expand, walkBundle }

/** Guard against a caller handing a relative cwd to a scan that resolves paths. */
export const normaliseCwd = (cwd: string | undefined): string | undefined =>
  cwd === undefined ? undefined : isAbsolute(cwd) ? cwd : resolve(cwd)
