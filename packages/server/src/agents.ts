import { constants, type Stats } from 'node:fs'
import { open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

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

const FILE = 'AGENT.md'

/**
 * The most of an `AGENT.md` that is read.
 *
 * An `AGENT.md` is a brief, and 256 KiB is a generous one. A larger file is
 * refused whole rather than cut short: a brief that stops mid-sentence is a
 * different standing order from the one somebody wrote, and nothing would say
 * so.
 */
const LIMIT = 256 * 1024

/**
 * How an `AGENT.md` is opened: to read, and without waiting.
 *
 * Not waiting is for a named pipe, whose open otherwise blocks until something
 * writes to it — which, for a roster listed every time a screen asks, is
 * forever. It changes nothing for a regular file, the only kind that is read.
 */
const READ = constants.O_RDONLY | constants.O_NONBLOCK

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

const idsIn = async (dir: string): Promise<string[]> => {
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
    .filter((one) => one.isDirectory() || one.isSymbolicLink())
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

/** Whether `path` lies beneath `root`. Both are real paths, so the arithmetic on their text means what it says. */
const beneath = (path: string, root: string): boolean => {
  const rest = relative(root, path)
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest)
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
  readonly dir: string
  /**
   * The real path every file read here must stay beneath, or null where links
   * are followed wherever they lead.
   *
   * Where an Agent came from is the trust boundary. A project arrives in a
   * clone — somebody else's input — and its brief becomes a model's standing
   * order. Followed freely, one committed symlink would have the host read a
   * file from this machine, a key or a token, into that prompt, past every
   * permission prompt the runtime would have put between the model and the
   * file. So a project's `AGENT.md` is read only if its real path is inside the
   * project's, which admits a link that stays in the repository and refuses one
   * that leaves it — a linked `.harnessdesk/agents` included.
   *
   * This machine's roster and the built-in one were put there by the person
   * and by the build. A dotfiles checkout linked into place is a setup, not an
   * attack, and those links are followed.
   */
  readonly within: string | null
}

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
const candidateAt = async (path: string, within: string | null): Promise<Candidate> => {
  let target = path
  let flags = READ
  if (within !== null) {
    let real: string
    try {
      real = await realpath(path)
    } catch (error) {
      return missed(error)
    }
    // Refused before it is opened, because opening is already an act on whatever is at the far end.
    if (!beneath(real, within)) {
      return {
        at: 'unread',
        why: "this file links outside the project, so it was not read: a project's Agents are read only from inside it",
      }
    }
    /* The path that was checked is the path opened, and a link at its last step
       is refused rather than followed, so a file swapped for a link after the
       check cannot lead out. A directory above it swapped for a link in that
       same instant is not caught: that takes something writing inside the
       project while it is being listed, which a clone cannot do. */
    target = real
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
    const bytes = await readAtMost(handle, LIMIT)
    if (bytes === null) {
      return {
        at: 'unread',
        why: `this file is larger than ${LIMIT / 1024} KiB, so it was not read: a brief is read whole or not at all`,
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
  constructor(private readonly roots: AgentRoots) {}

  /** Highest precedence first, so the first hit for an id is the winner. */
  private async places(project?: string): Promise<Place[]> {
    const places: Place[] = []
    if (project) {
      // A project that is not there has no Agents to read, and nothing to stay inside.
      const within = await realRoot(project)
      if (within !== null) places.push({ origin: 'project', dir: join(project, PROJECT_AGENT_DIR), within })
    }
    places.push({ origin: 'user', dir: this.roots.user, within: null })
    places.push({ origin: 'builtin', dir: this.roots.builtin, within: null })
    return places
  }

  async list(project?: string): Promise<AgentEntry[]> {
    const found = new Map<string, AgentEntry>()
    for (const place of await this.places(project)) {
      for (const id of await idsIn(place.dir)) {
        const path = join(place.dir, id, FILE)
        /* Read first, decide second. A directory with no AGENT.md is not an
           Agent at *any* tier, and asking about the winner before asking about
           the file is how a folder somebody deleted the file out of came to be
           reported as a shadow at a path nobody can open. One check, on the one
           path, so the two cannot drift apart. */
        const candidate = await candidateAt(path, place.within)
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
