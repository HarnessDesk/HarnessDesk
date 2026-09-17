import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  /** `~/.harnessdesk/agents` — this machine. */
  readonly user: string
  /** Ships with the build. */
  readonly builtin: string
}

/** Where a project keeps the Agents it shares with everyone who clones it. */
export const PROJECT_AGENT_DIR = join('.harnessdesk', 'agents')

const FILE = 'AGENT.md'

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

const idsIn = async (dir: string): Promise<string[]> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return []
    throw error
  }
  return entries
    .filter((one) => one.isDirectory())
    .map((one) => one.name)
    .sort()
}

/** What was at a candidate's `AGENT.md`: nothing, its text, or a reason. */
type Candidate =
  | { readonly at: 'nothing' }
  | { readonly at: 'text'; readonly source: string }
  | { readonly at: 'unreadable'; readonly reason: string }

/**
 * Reads one candidate before anything asks which tier it belongs to.
 *
 * "Not there" and "there but unreadable" are different answers because they
 * deserve different ones: the first is not an Agent at all, and the second is an
 * Agent somebody needs told about.
 */
const candidateAt = async (path: string): Promise<Candidate> => {
  try {
    return { at: 'text', source: await readFile(path, 'utf8') }
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return { at: 'nothing' }
    return { at: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

export class Agents {
  constructor(private readonly roots: AgentRoots) {}

  /** Highest precedence first, so the first hit for an id is the winner. */
  private places(project?: string): { origin: AgentOrigin; dir: string }[] {
    const places: { origin: AgentOrigin; dir: string }[] = []
    if (project) places.push({ origin: 'project', dir: join(project, PROJECT_AGENT_DIR) })
    places.push({ origin: 'user', dir: this.roots.user })
    places.push({ origin: 'builtin', dir: this.roots.builtin })
    return places
  }

  async list(project?: string): Promise<AgentEntry[]> {
    const found = new Map<string, AgentEntry>()
    for (const place of this.places(project)) {
      for (const id of await idsIn(place.dir)) {
        const path = join(place.dir, id, FILE)
        /* Read first, decide second. A directory with no AGENT.md is not an
           Agent at *any* tier, and asking about the winner before asking about
           the file is how a folder somebody deleted the file out of came to be
           reported as a shadow at a path nobody can open. One check, on the one
           path, so the two cannot drift apart. */
        const candidate = await candidateAt(path)
        if (candidate.at === 'nothing') continue

        const winner = found.get(id)
        if (winner) {
          /* Marked on the winner rather than dropped, and in the order the
             places were walked, so the list reads as the precedence it is. */
          found.set(id, { ...winner, shadows: [...winner.shadows, { origin: place.origin, path }] })
          continue
        }

        if (candidate.at === 'unreadable') {
          /* The shape a file that does not parse already arrives in, so a reader
             has one case and not two: no definition, and a problem saying what
             happened. Losing the rest of the roster over one unreadable file
             would be the same defect as hiding a shadowed one. */
          found.set(id, {
            definition: null,
            id,
            origin: place.origin,
            path,
            // Nothing was read, so there is nothing to hash — and an empty
            // digest cannot be mistaken for the digest of an empty file.
            digest: '',
            shadows: [],
            problems: [problem('error', FILE, `this file could not be read — ${candidate.reason}`)],
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
