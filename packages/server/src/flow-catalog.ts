import type { FlowEntry, FlowOrigin, FlowProblem, FlowUpdateResult } from '@harnessdesk/protocol'

import { ConfinedTree } from './confined-tree.js'
import { errnoOf, NOTHING_HERE } from './errno.js'
import { parseFlowPolicy } from './flow-policy.js'

export type { FlowEntry, FlowOrigin } from '@harnessdesk/protocol'

export const FLOW_FILE_LIMIT = 256 * 1024
const LAYER_LIMIT = 256
const FLOW_NAME = /^[^/\\\0]+\.ya?ml$/i
export const FLOW_DIR = '.harnessdesk/flows'

export interface FlowCatalogOptions {
  readonly userRoot?: string
  readonly builtinRoot?: string
  readonly confine: (root: string) => Promise<void>
  /** Legacy callers historically raise a project-folder refusal; new catalogue rows retain it. */
  readonly legacyStrict?: boolean
  /** The update surface owns confirmation tokens; catalogue selection itself never writes. */
  readonly customize?: (root: string, id: string, token: string) => Promise<FlowUpdateResult>
  /** Tests only: the platform every tree this catalogue opens behaves as. */
  readonly platform?: NodeJS.Platform
}

interface FoundFlow {
  readonly origin: FlowOrigin
  readonly name: string
  readonly id: string
  /** What the person is shown: project-relative for a project flow, the bare name otherwise. */
  readonly path: string
  /** The tree the file is read through, and its path inside that tree. */
  readonly tree: ConfinedTree | null
  readonly rel: string
  readonly problem?: string
}

const directName = (name: string): string => {
  if (!FLOW_NAME.test(name) || name === '.' || name === '..') throw new Error('Choose a flow file directly inside .harnessdesk/flows.')
  return name
}

const idOf = (name: string): string => name.replace(/\.ya?ml$/i, '')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A flow read through its layer's tree: the bytes, or the reason there are none. */
const readFlow = async (tree: ConfinedTree, rel: string): Promise<string> => {
  const source = await tree.read(rel, FLOW_FILE_LIMIT)
  if (source === null) throw new Error('There is no flow at that path.')
  return source
}

const problemText = (problems: readonly FlowProblem[]): string | null => {
  const problem = problems.find((one) => one.level === 'error')
  return problem ? `${problem.at}: ${problem.text}` : null
}

/**
 * Lists one layer through its tree without treating a broken or linked layer
 * as empty. `folder` is the layer's place inside `tree`: `.harnessdesk/flows`
 * in a project, the tree's own root for the user and built-in layers.
 */
const layer = async (origin: FlowOrigin, tree: () => Promise<ConfinedTree | null>, folder: string, strict = false): Promise<FoundFlow[]> => {
  const shown = (name: string) => (folder ? `${folder}/${name}` : name)
  let opened: ConfinedTree | null = null
  let listed
  try {
    opened = await tree()
    if (!opened) return []
    listed = await opened.list(folder, LAYER_LIMIT)
    if (!listed) return []
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return []
    if (strict) throw error
    return [{ origin, name: 'Unreadable flows', id: '__unreadable__', path: folder, tree: null, rel: folder, problem: messageOf(error) }]
  }
  if (listed.exceeded) return [{ origin, id: '__limit__', name: 'Too many flows', path: folder, tree: null, rel: folder, problem: 'A flow layer may contain at most 256 entries.' }]
  const candidates = listed.entries.filter((entry) => /\.ya?ml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
  const byId = new Map<string, typeof candidates>()
  for (const entry of candidates) {
    const id = idOf(entry.name)
    byId.set(id, [...(byId.get(id) ?? []), entry])
  }
  const found: FoundFlow[] = []
  for (const [id, entries] of byId) {
    for (const entry of entries) {
      const problem = entries.length > 1 ? 'A flow id may be spelled by only one .yml or .yaml file.'
        : entry.kind === 'link' ? 'A flow must be a regular file with no links.'
          : !FLOW_NAME.test(entry.name) ? 'Choose a flow file directly inside .harnessdesk/flows.' : null
      found.push({ origin, id, name: entry.name, path: shown(entry.name), tree: opened, rel: shown(entry.name), ...(problem ? { problem } : {}) })
    }
  }
  return found
}

/** Three trusted layers, where the nearest entry wins even when it is broken. */
export class FlowCatalog {
  readonly #options: FlowCatalogOptions

  constructor(options: FlowCatalogOptions) { this.#options = options }

  /**
   * The project, confined and resolved once for one operation. Everything the
   * operation then reads or writes in the project goes through this tree.
   */
  async project(root: string): Promise<ConfinedTree> {
    await this.#options.confine(root)
    return ConfinedTree.open(root, this.#options.platform ? { platform: this.#options.platform } : {})
  }

  #host(root: string | undefined): () => Promise<ConfinedTree | null> {
    return async () => (root ? ConfinedTree.open(root, this.#options.platform ? { platform: this.#options.platform } : {}) : null)
  }

  async #all(project: ConfinedTree): Promise<FoundFlow[]> {
    return (await Promise.all([
      layer('project', async () => project, FLOW_DIR, this.#options.legacyStrict === true),
      layer('user', this.#host(this.#options.userRoot), ''),
      layer('builtin', this.#host(this.#options.builtinRoot), ''),
    ])).flat()
  }

  /** Every entry, each winner read once, with the source the winner was judged by. */
  async #entries(project: ConfinedTree): Promise<{ readonly entry: FlowEntry; readonly source: string | null }[]> {
    const grouped = new Map<string, FoundFlow[]>()
    for (const item of await this.#all(project)) grouped.set(item.id, [...(grouped.get(item.id) ?? []), item])
    const result: { entry: FlowEntry; source: string | null }[] = []
    for (const group of [...grouped.values()].sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))) {
      const [winner, ...shadows] = group
      let problem: string | null = winner!.problem ?? null
      let format: FlowEntry['format'] = null
      let name = idOf(winner!.name)
      let description: string | null = null
      let source: string | null = null
      if (!problem && winner!.tree) {
        try {
          source = await readFlow(winner!.tree, winner!.rel)
          const parsed = parseFlowPolicy(source)
          problem = problemText(parsed.problems)
          format = parsed.document?.format ?? null
          name = parsed.document?.flow.name ?? name
          description = parsed.document?.flow.description ?? null
        } catch (error) {
          problem = messageOf(error)
          source = null
        }
      }
      result.push({
        entry: { id: winner!.id, origin: winner!.origin, path: winner!.path, name, description, format, problem,
          shadows: shadows.map((shadow) => ({ origin: shadow.origin, path: shadow.path })) },
        source,
      })
    }
    return result
  }

  async list(root: string): Promise<readonly FlowEntry[]> {
    return (await this.#entries(await this.project(root))).map((one) => one.entry)
  }

  /** Internal trusted resolution for updates; renderer input selects only an id and optional known layer. */
  async locate(project: ConfinedTree, id: string, origin?: FlowOrigin): Promise<{ readonly entry: FlowEntry; readonly source: string }> {
    const found = (await this.#entries(project)).find((one) => one.entry.id === id && (origin === undefined || one.entry.origin === origin))
    if (!found) throw new Error(`There is no flow called "${id}".`)
    if (found.entry.problem || found.source === null) throw new Error(found.entry.problem ?? `There is no flow called "${id}".`)
    return { entry: found.entry, source: found.source }
  }

  async read(root: string, id: string, origin?: FlowOrigin): Promise<string> {
    // Compatibility callers historically pass a path. Only a direct child remains accepted.
    const candidate = id.startsWith(`${FLOW_DIR}/`) ? id.slice(FLOW_DIR.length + 1) : id
    directName(candidate)
    const found = await this.locate(await this.project(root), idOf(candidate), origin)
    if (found.entry.path.split('/').at(-1) !== candidate) throw new Error(`A flow is read from ${FLOW_DIR}; "${id}" is somewhere else.`)
    return found.source
  }

  /** The v2 catalogue's own read: a bare id, as `list`'s entries name it — never a path. */
  async readById(root: string, id: string, origin?: FlowOrigin): Promise<string> {
    const found = await this.locate(await this.project(root), id, origin)
    return found.source
  }

  /**
   * A trigger's `opens: { flow }`, resolved by the same id and layer rules as
   * every other catalogue read — project, then user, then built-in, the
   * nearest winning even when broken — with where the winner came from, so an
   * arm can bind which file it consented to.
   */
  async resolve(root: string, id: string): Promise<{ readonly source: string; readonly origin: FlowOrigin; readonly path: string }> {
    const found = await this.locate(await this.project(root), id)
    return { source: found.source, origin: found.entry.origin, path: found.entry.path }
  }

  async customize(root: string, id: string, token: string): Promise<FlowUpdateResult> {
    if (!this.#options.customize) return { state: 'refused', written: [], message: 'Preview this customization before applying it.' }
    return this.#options.customize(root, id, token)
  }
}
