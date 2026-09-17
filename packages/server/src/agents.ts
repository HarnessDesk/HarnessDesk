import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { digestOf } from '@harnessdesk/agent-inventory'
import type { AgentEntry, AgentOrigin } from '@harnessdesk/protocol'

import { parseAgentDefinition } from './agent-def.js'

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

const idsIn = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((one) => one.isDirectory())
      .map((one) => one.name)
      .sort()
  } catch {
    // A roster directory nobody has made yet is an empty roster.
    return []
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
        const winner = found.get(id)
        if (winner) {
          /* Marked on the winner rather than dropped, and in the order the
             places were walked, so the list reads as the precedence it is. */
          found.set(id, { ...winner, shadows: [...winner.shadows, { origin: place.origin, path }] })
          continue
        }
        let source: string
        try {
          source = await readFile(path, 'utf8')
        } catch {
          // A directory with no AGENT.md is not an Agent.
          continue
        }
        const { agent, problems } = parseAgentDefinition(source, id)
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
          digest: digestOf(source),
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
