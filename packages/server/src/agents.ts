import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, sep } from 'node:path'

import { digestOf } from '@harnessdesk/agent-inventory'
import type { AgentEntry, AgentOrigin } from '@harnessdesk/protocol'

import { parseAgentDefinition } from './agent-def.js'
import { problem } from './flow.js'

/**
 * The Agent roster: three directories, one winner per id.
 *
 * Project beats user beats built-in, and **what lost is listed on what won**.
 * A roster that quietly drops the copy somebody is editing is a roster that
 * costs them an afternoon, which is why the plugin roster states the same rule.
 *
 * This is the half with side effects. `agent-def.ts` decides what a file means
 * and touches nothing; this one walks the directories, the same way `flow.ts`
 * decides and `flows.ts` acts.
 */

export interface AgentRoots {
  /**
   * `agents` in the state directory: this machine's. That directory is
   * `~/.harnessdesk` unless `HARNESSDESK_HOME`, the desktop shell or a test rig
   * put it somewhere else, and this moves with it.
   */
  readonly user: string
  /** Ships with the build. */
  readonly builtin: string
}

/** Where a project keeps the Agents it shares with everyone who clones it. */
export const PROJECT_AGENT_DIR = join('.harnessdesk', 'agents')

/** A sibling used while an Agent is assembled before its one final rename. */
export const AGENT_TEMP_PREFIX = '.harnessdesk-agent-'

const FILE = 'AGENT.md'

/**
 * The most of an `AGENT.md` that is read.
 *
 * An `AGENT.md` is a brief, and 256 KiB is a generous one. A larger file is
 * refused whole rather than cut short: a brief that stops mid-sentence is a
 * different standing order from the one somebody wrote, and nothing would say
 * so.
 */
export const AGENT_FILE_LIMIT = 256 * 1024

/**
 * How an `AGENT.md` is opened: to read, and without waiting.
 *
 * Not waiting is for a named pipe, whose open otherwise blocks until something
 * writes to it — which, for a roster listed every time a screen asks, is
 * forever. It changes nothing for a regular file, the only kind that is read.
 */
const READ = constants.O_RDONLY | constants.O_NONBLOCK

/** The most links one path may pass through before it is taken for a loop: the kernel's own limit on macOS. */
const MAX_LINKS = 32

/*
 * Why something in a project that leads out of it was not read. The words are
 * the same whether anything is there or not, because a sentence that changed
 * with what is outside would be a way of asking about it.
 */
const FILE_LEADS_OUT = "this file links outside the project, so it was not read: a project's Agents are read only from inside it"
const DIR_LEADS_OUT =
  "this directory links outside the project, so nothing in it was read: a project's Agents are read only from inside it"

/**
 * The two failures that mean "no Agents here" rather than "something is wrong".
 *
 * `ENOENT` is a directory nobody has made yet. `ENOTDIR` is a `.harnessdesk`
 * somebody made a *file*, which is a project with no Agents in it and not a
 * reason to refuse every listing that project asks for.
 *
 * Everything else — a mode, a mount, a name the filesystem will not take — is a
 * real failure, and the cost of reading it as an empty roster is paid by the
 * person staring at a screen that says they have no Agents when they have ten.
 * A raised error names a path and a reason they can act on; zero rows name
 * nothing.
 */
const NOTHING_HERE = new Set(['ENOENT', 'ENOTDIR'])

const errnoOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const idsIn = async (dir: string): Promise<string[]> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return []
    throw error
  }
  /* A link is kept, and where it leads decides. A linked folder is an Agent like
     any other — a dotfiles checkout linked into place is exactly that — and a
     link to a file, or to nothing, has no AGENT.md beneath it, which the read
     answers as nothing. Dropping links here hid every linked Agent without a
     word. */
  return entries
    // Hide only this module's transaction namespace. Other dot-prefixed names
    // remain visible as broken Agents rather than silently disappearing.
    .filter((one) => !one.name.startsWith(AGENT_TEMP_PREFIX) && (one.isDirectory() || one.isSymbolicLink()))
    .map((one) => one.name)
    .sort()
}

/** A directory's real path, or null when it is not there. Anything else is raised, as a root's failure is. */
const realRoot = async (dir: string): Promise<string | null> => {
  try {
    return await realpath(dir)
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return null
    throw error
  }
}

/** Where a path inside a project led: to a real path still inside it, to nothing, or out of it. */
export type Resolved =
  | { readonly to: 'inside'; readonly path: string }
  | { readonly to: 'nothing' }
  | { readonly to: 'outside' }

/**
 * Follows `steps` from `from` without ever leaving `root`, and says where they led.
 *
 * `realpath` answers "where does this lead" by going there — through every
 * link, out of the project, and through whatever is outside — and only then can
 * its answer be compared. For a project that order is the leak. What is out
 * there would decide what the roster shows for a clone: the names in a
 * directory it links to, whether a path it names exists, whether it may be
 * searched. A clone could ask about this machine by linking to places and
 * watching the answer change.
 *
 * So this walks inside only. Each step is looked at with `lstat` beneath what is
 * already resolved; a link's target is read and walked in its place; and the
 * first step that would leave `root` — a `..` above it, or an absolute target
 * that is not beneath it as written — ends the walk as `outside`, without a
 * look at where it goes. What the roster answers for a project is then the
 * project's own tree and nothing else.
 *
 * `root` is a real path, and `from` is `root` or a real path beneath it. "Not
 * there" is `nothing`; any other failure is raised, and can only name a path
 * inside the project, because no other path is ever looked at.
 *
 * What it reached is used at once — listed, or opened. A directory on the way
 * swapped for a link in between is not caught: that takes something writing
 * inside the project while it is being listed, which a clone cannot do.
 *
 * The roster's watch (`agent-watch.ts`) judges a project's paths with this
 * same walk, so that what is watched and what is read never disagree.
 */
export const resolveWithin = async (root: string, from: string, steps: readonly string[]): Promise<Resolved> => {
  const rootSteps = root.split(sep).filter(Boolean)
  const pending = [...steps]
  let at = from
  let links = 0
  for (let step = pending.shift(); step !== undefined; step = pending.shift()) {
    if (step === '' || step === '.') continue
    if (step === '..') {
      if (at === root) return { to: 'outside' }
      at = dirname(at)
      continue
    }
    const next = join(at, step)
    let target: string
    try {
      if (!(await lstat(next)).isSymbolicLink()) {
        at = next
        continue
      }
      // A known limit, measured and deliberately left open. Node's `readlink`
      // sizes its buffer with `pathconf(_PC_PATH_MAX)`, and `pathconf` follows
      // the link — so reading the text of an in-project link that points
      // outside costs time proportional to how many links deep the *outside*
      // target is (about 2.5 µs for a missing target, 22 µs for a loop). The
      // answer is byte-identical whatever lies outside; its latency is not.
      //
      // Unexploitable under this module's threat model — a cloned repository
      // with no process on the machine cannot time a local call. It becomes
      // real the moment `agent/list` is served to a party who can also plant a
      // repository, so the cloud lane must close it before it serves this:
      // a `readlink` that does not pre-size by following, or a fixed floor on
      // the listing's latency. Node exposes neither today.
      target = await readlink(next)
    } catch (error) {
      if (NOTHING_HERE.has(errnoOf(error))) return { to: 'nothing' }
      throw error
    }
    if (++links > MAX_LINKS) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, resolving '${next}'`), {
        code: 'ELOOP',
      })
    }
    // A link to the empty string leads nowhere, as the kernel reads it.
    if (target === '') return { to: 'nothing' }
    const parts = target.split(sep)
    if (isAbsolute(target)) {
      /* Taken as written, because following it to find out where it lands is
         the look this walk exists not to take. A link that names the project's
         own real path is followed from there; one that names anything else,
         including the project by some other spelling, is outside. */
      const written = parts.filter(Boolean)
      if (!rootSteps.every((one, index) => written[index] === one)) return { to: 'outside' }
      at = root
      pending.unshift(...written.slice(rootSteps.length))
    } else {
      pending.unshift(...parts)
    }
  }
  return { to: 'inside', path: at }
}

/** What something that is not a regular file is, in the words somebody would go looking for. */
const kindOf = (info: Stats): string => {
  if (info.isDirectory()) return 'a directory'
  if (info.isFIFO()) return 'a named pipe'
  if (info.isCharacterDevice() || info.isBlockDevice()) return 'a device'
  if (info.isSocket()) return 'a socket'
  return 'something other than a file'
}

/**
 * The file's bytes, or null when there are more than `limit` of them.
 *
 * Decided by what is read, not by the size the file reports: a file can grow
 * between the two, and some report no size at all. One byte past the limit is
 * the most that is ever read, and it is enough to know.
 */
const readAtMost = async (handle: FileHandle, limit: number): Promise<Buffer | null> => {
  const buffer = Buffer.allocUnsafe(limit + 1)
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
    if (bytesRead === 0) return buffer.subarray(0, filled)
    filled += bytesRead
  }
  return null
}

/** One directory the roster reads, and how far the links in it are followed. */
interface Place {
  readonly origin: AgentOrigin
  /** The directory as a person would write it: what an entry's path is built from, so it is a path they can open. */
  readonly dir: string
  /** The directory as it resolved: what is read. For this machine's roots, the same path, and the system follows its links. */
  readonly real: string
  /**
   * The real path every file read here must resolve beneath, step by step, or
   * null where links are followed wherever they lead.
   *
   * Where an Agent came from is the trust boundary. A project arrives in a
   * clone — somebody else's input — and its brief becomes a model's standing
   * order. Followed freely, one committed symlink would have the host read a
   * file from this machine, a key or a token, into that prompt, past every
   * permission prompt the runtime would have put between the model and the
   * file; and a linked directory would list another folder's names. So in a
   * project nothing is followed out of it — not the Agent directory, not a
   * folder in it, not a file — which admits a link that stays in the repository
   * and refuses one that leaves it without looking at where it goes.
   *
   * This machine's roster and the built-in one were put there by the person
   * and by the build. A dotfiles checkout linked into place is a setup, not an
   * attack, and those links are followed.
   */
  readonly within: string | null
}

/** A project's Agent directory: where it resolved inside the project, that there is none, or why it was not read. */
type ProjectDir =
  | { readonly at: 'nothing' }
  | { readonly at: 'inside'; readonly place: Place }
  | { readonly at: 'unread'; readonly why: string }

/**
 * Finds a project's Agent directory, inside the project or not at all.
 *
 * A project cannot fail the listing. It arrives in a clone, and a clone that
 * could make `agent/list` raise — by linking its Agent directory into a folder
 * this user cannot read, or into itself — could take this machine's Agents
 * away with it. So a directory that leads out, or cannot be followed, comes
 * back as a reason and becomes one entry; this machine's roster, which nobody
 * else wrote, still raises what it cannot read.
 */
const projectDirOf = async (project: string): Promise<ProjectDir> => {
  // A project that is not there has no Agents to read, and nothing to stay inside.
  const root = await realRoot(project)
  if (root === null) return { at: 'nothing' }
  let reached: Resolved
  try {
    reached = await resolveWithin(root, root, PROJECT_AGENT_DIR.split(sep))
  } catch (error) {
    return { at: 'unread', why: `this directory could not be read — ${messageOf(error)}` }
  }
  if (reached.to === 'nothing') return { at: 'nothing' }
  if (reached.to === 'outside') return { at: 'unread', why: DIR_LEADS_OUT }
  return {
    at: 'inside',
    place: { origin: 'project', dir: join(project, PROJECT_AGENT_DIR), real: reached.path, within: root },
  }
}

/**
 * The one entry a project's Agent directory becomes when it was not read.
 *
 * One, not silence: a person whose project Agents have gone is owed the reason,
 * and zero rows would give none. Its id is the directory's place in the
 * project, which no Agent's folder can be called, so it shadows nothing and
 * nothing shadows it — this machine's Agents stay usable beside it. Its path is
 * where the person can go and look. And nothing past the directory is named:
 * not where a link leads, not what is there, not whether anything is.
 */
const unreadDirectory = (dir: string, why: string): AgentEntry => ({
  definition: null,
  id: PROJECT_AGENT_DIR,
  origin: 'project',
  path: dir,
  digest: null,
  shadows: [],
  problems: [problem('error', PROJECT_AGENT_DIR, why)],
})

/** What was at a candidate's `AGENT.md`: nothing, its text, or why it was not read. */
type Candidate =
  | { readonly at: 'nothing' }
  | { readonly at: 'text'; readonly source: string }
  | { readonly at: 'unread'; readonly why: string }

/** A failure to reach the file: nothing there at all, or something there that could not be read. */
const missed = (error: unknown): Candidate =>
  NOTHING_HERE.has(errnoOf(error))
    ? { at: 'nothing' }
    : { at: 'unread', why: `this file could not be read — ${messageOf(error)}` }

/**
 * Reads one candidate before anything asks which tier it belongs to.
 *
 * "Not there" and "there but not read" are different answers because they
 * deserve different ones: the first is not an Agent at all, and the second is
 * an Agent somebody needs told about — told why, and never told what is there.
 *
 * The file is opened once, and what is decided about it is decided on what was
 * opened: its kind from the open handle, its length from what that handle
 * gives up, its text from the same handle. A check on a path followed by a
 * read of the path is two looks at a name that can change in between.
 */
const candidateAt = async (place: Place, id: string): Promise<Candidate> => {
  let target = join(place.real, id, FILE)
  let flags = READ
  if (place.within !== null) {
    let reached: Resolved
    try {
      reached = await resolveWithin(place.within, place.real, [id, FILE])
    } catch (error) {
      return { at: 'unread', why: `this file could not be read — ${messageOf(error)}` }
    }
    if (reached.to === 'nothing') return { at: 'nothing' }
    // Refused before it is opened, and before anything past the project is looked at.
    if (reached.to === 'outside') return { at: 'unread', why: FILE_LEADS_OUT }
    /* The path the walk reached is the path opened, and a link at its last step
       is refused rather than followed, so a file swapped for a link after the
       walk cannot lead out. A directory above it swapped for a link in that
       same instant is not caught: that takes something writing inside the
       project while it is being listed, which a clone cannot do. */
    target = reached.path
    flags |= constants.O_NOFOLLOW
  }

  let handle: FileHandle
  try {
    handle = await open(target, flags)
  } catch (error) {
    return missed(error)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      return { at: 'unread', why: `this is not a regular file — it is ${kindOf(info)} — so it was not read` }
    }
    const bytes = await readAtMost(handle, AGENT_FILE_LIMIT)
    if (bytes === null) {
      return {
        at: 'unread',
        why: `this file is larger than ${AGENT_FILE_LIMIT / 1024} KiB, so it was not read: a brief is read whole or not at all`,
      }
    }
    return { at: 'text', source: bytes.toString('utf8') }
  } catch (error) {
    return { at: 'unread', why: `this file could not be read — ${messageOf(error)}` }
  } finally {
    await handle.close()
  }
}

export class Agents {
  /** Where this machine's and the built-in Agents are: what a write to one of them is made against. */
  constructor(readonly roots: AgentRoots) {}

  async list(project?: string): Promise<AgentEntry[]> {
    const found = new Map<string, AgentEntry>()

    // Highest precedence first, so the first hit for an id is the winner.
    const places: Place[] = []
    if (project) {
      const reached = await projectDirOf(project)
      if (reached.at === 'inside') places.push(reached.place)
      if (reached.at === 'unread') {
        found.set(PROJECT_AGENT_DIR, unreadDirectory(join(project, PROJECT_AGENT_DIR), reached.why))
      }
    }
    places.push({ origin: 'user', dir: this.roots.user, real: this.roots.user, within: null })
    places.push({ origin: 'builtin', dir: this.roots.builtin, real: this.roots.builtin, within: null })

    for (const place of places) {
      let ids: string[]
      try {
        ids = await idsIn(place.real)
      } catch (error) {
        // This machine's roster raises what it cannot read; a project cannot fail the listing (see `projectDirOf`).
        if (place.within === null) throw error
        const why = `this directory could not be read — ${messageOf(error)}`
        found.set(PROJECT_AGENT_DIR, unreadDirectory(place.dir, why))
        continue
      }
      for (const id of ids) {
        const path = join(place.dir, id, FILE)
        /* Read first, decide second. A directory with no AGENT.md is not an
           Agent at *any* tier, and asking about the winner before asking about
           the file is how a folder somebody deleted the file out of came to be
           reported as a shadow at a path nobody can open. One check, on the one
           path, so the two cannot drift apart. */
        const candidate = await candidateAt(place, id)
        if (candidate.at === 'nothing') continue

        const winner = found.get(id)
        if (winner) {
          /* Marked on the winner rather than dropped, and in the order the
             places were walked, so the list reads as the precedence it is. */
          found.set(id, { ...winner, shadows: [...winner.shadows, { origin: place.origin, path }] })
          continue
        }

        if (candidate.at === 'unread') {
          /* The shape a file that does not parse already arrives in, so a reader
             has one case and not two: no definition, and a problem saying why.
             Losing the rest of the roster over one file would be the same
             defect as hiding a shadowed one. */
          found.set(id, {
            definition: null,
            id,
            origin: place.origin,
            path,
            // Nothing was read, so there is nothing to hash. Null rather than a
            // sentinel string: two unrelated unread entries must not compare
            // equal to a consumer that is comparing digests.
            digest: null,
            shadows: [],
            problems: [problem('error', FILE, candidate.why)],
          })
          continue
        }

        const { agent, problems } = parseAgentDefinition(candidate.source, id)
        found.set(id, {
          // Null rather than a hollow stand-in: a definition that parsed and one
          // that did not must not be the same shape, or every later reader has
          // to guess which it got.
          definition: agent,
          id,
          origin: place.origin,
          path,
          // `digestOf` trims before hashing, so an inline copy of this would
          // disagree with every other digest in the desk on trailing whitespace.
          digest: digestOf(candidate.source),
          shadows: [],
          problems,
        })
      }
    }
    return [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  async read(id: string, project?: string): Promise<AgentEntry | null> {
    return (await this.list(project)).find((one) => one.id === id) ?? null
  }
}
