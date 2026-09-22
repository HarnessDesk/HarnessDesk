import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { FlowProblem } from '@harnessdesk/protocol'

import { errnoOf, NOTHING_HERE } from './errno.js'
import { parseFlowPolicy } from './flow-policy.js'
import type { FlowUpdateResult } from './flow-update.js'
const FILE_LIMIT = 256 * 1024
const LAYER_LIMIT = 256
const FLOW_NAME = /^[^/\\\0]+\.ya?ml$/i
const FLOW_DIR = '.harnessdesk/flows'

export type FlowOrigin = 'project' | 'user' | 'builtin'

export interface FlowEntry {
  readonly id: string
  readonly origin: FlowOrigin
  readonly path: string
  readonly name: string
  readonly description: string | null
  readonly format: 'legacy' | 'agents' | null
  readonly problem: string | null
  readonly shadows: readonly { readonly origin: FlowOrigin; readonly path: string }[]
}

export interface FlowCatalogOptions {
  readonly userRoot?: string
  readonly builtinRoot?: string
  readonly confine: (root: string) => Promise<void>
  /** Legacy callers historically raise a project-folder refusal; new catalogue rows retain it. */
  readonly legacyStrict?: boolean
  /** The update surface owns confirmation tokens; catalogue selection itself never writes. */
  readonly customize?: (root: string, id: string, token: string) => Promise<FlowUpdateResult>
}

interface FoundFlow {
  readonly origin: FlowOrigin
  readonly name: string
  readonly id: string
  readonly path: string
  readonly absolute: string
  readonly problem?: string
}

const identity = (info: { readonly dev: number | bigint; readonly ino: number | bigint }) => `${info.dev}:${info.ino}`

const directName = (name: string): string => {
  if (!FLOW_NAME.test(name) || basename(name) !== name || name === '.' || name === '..') throw new Error('Choose a flow file directly inside .harnessdesk/flows.')
  return name
}

const idOf = (name: string): string => name.replace(/\.ya?ml$/i, '')

/** A bounded no-follow read, with every parent and file identity checked before accepting bytes. */
export const readConfinedFlow = async (base: string, name: string): Promise<string> => {
  directName(name)
  const root = await realpath(base)
  const rootInfo = await lstat(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('A flow folder must be a real directory, not a link.')
  const path = join(root, name)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('A flow must be a regular file with no links.')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(opened) !== identity(before)) throw new Error('The flow changed while it was read. Open it again.')
    const bytes = Buffer.alloc(FILE_LIMIT + 1)
    let used = 0
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used)
      if (read.bytesRead === 0) break
      used += read.bytesRead
    }
    if (used > FILE_LIMIT) throw new Error('A flow file cannot exceed 256 KiB.')
    const after = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    const rootAfter = await lstat(root, { bigint: true })
    if (identity(after) !== identity(opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
      || identity(named) !== identity(opened) || named.isSymbolicLink() || identity(rootAfter) !== identity(rootInfo)
      || rootAfter.isSymbolicLink()) throw new Error('The flow changed while it was read. Open it again.')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))
  } finally {
    await handle.close()
  }
}

const problemText = (problems: readonly FlowProblem[]): string | null => {
  const problem = problems.find((one) => one.level === 'error')
  return problem ? `${problem.at}: ${problem.text}` : null
}

/** Lists a trusted layer without treating a broken or linked layer as empty. */
const layer = async (origin: FlowOrigin, base: string | undefined, project = false, strict = false): Promise<FoundFlow[]> => {
  if (!base) return []
  const folder = project ? join(base, FLOW_DIR) : base
  let entries
  try {
    const info = await lstat(folder)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      if (strict) throw new Error('A flow folder must be a real directory, not a link.')
      return [{ origin, name: idOf(project ? 'flows.yml' : 'flows.yml'), id: 'flows', path: project ? FLOW_DIR : '', absolute: folder, problem: 'A flow folder must be a real directory, not a link.' }]
    }
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return []
    if (strict) throw error
    return [{ origin, name: 'Unreadable flows', id: '__unreadable__', path: project ? FLOW_DIR : '', absolute: folder, problem: error instanceof Error ? error.message : String(error) }]
  }
  const candidates = entries.filter((entry) => /\.ya?ml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
  const found: FoundFlow[] = []
  if (candidates.length > LAYER_LIMIT) {
    found.push({ origin, id: '__limit__', name: 'Too many flows', path: project ? FLOW_DIR : '', absolute: folder, problem: 'A flow layer may contain at most 256 flow files.' })
  }
  const byId = new Map<string, string[]>()
  for (const entry of candidates.slice(0, LAYER_LIMIT)) {
    const id = idOf(entry.name)
    const names = byId.get(id) ?? []
    names.push(entry.name)
    byId.set(id, names)
  }
  for (const [id, names] of byId) {
    for (const name of names) {
      const path = project ? `${FLOW_DIR}/${name}` : name
      const absolute = join(folder, name)
      const duplicate = names.length > 1
      const linked = (await lstat(absolute).catch(() => null))?.isSymbolicLink() ?? false
      found.push({ origin, id, name, path, absolute, ...(duplicate ? { problem: 'A flow id may be spelled by only one .yml or .yaml file.' } : linked ? { problem: 'A flow must be a regular file with no links.' } : {}) })
    }
  }
  return found
}

/** Three trusted layers, where the nearest entry wins even when it is broken. */
export class FlowCatalog {
  readonly #options: FlowCatalogOptions

  constructor(options: FlowCatalogOptions) { this.#options = options }

  async #all(root: string): Promise<FoundFlow[]> {
    await this.#options.confine(root)
    return (await Promise.all([
      layer('project', root, true, this.#options.legacyStrict === true),
      layer('user', this.#options.userRoot),
      layer('builtin', this.#options.builtinRoot),
    ])).flat()
  }

  async list(root: string): Promise<readonly FlowEntry[]> {
    const all = await this.#all(root)
    const grouped = new Map<string, FoundFlow[]>()
    for (const item of all) {
      const group = grouped.get(item.id) ?? []
      group.push(item)
      grouped.set(item.id, group)
    }
    const result: FlowEntry[] = []
    for (const group of [...grouped.values()].sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))) {
      const [winner, ...shadows] = group
      let sourceProblem: string | null | undefined = winner!.problem
      let format: FlowEntry['format'] = null
      let name = winner!.name.replace(/\.ya?ml$/i, '')
      let description: string | null = null
      if (!sourceProblem && winner!.path) {
        try {
          const source = await readConfinedFlow(winner!.origin === 'project' ? join(root, FLOW_DIR) : winner!.origin === 'user' ? this.#options.userRoot! : this.#options.builtinRoot!, winner!.name)
          const parsed = parseFlowPolicy(source)
          sourceProblem = problemText(parsed.problems)
          format = parsed.document?.format ?? null
          name = parsed.document?.flow.name ?? name
          description = parsed.document?.flow.description ?? null
        } catch (error) {
          sourceProblem = error instanceof Error ? error.message : String(error)
        }
      }
      result.push({ id: winner!.id, origin: winner!.origin, path: winner!.path, name, description, format, problem: sourceProblem ?? null,
        shadows: shadows.map((shadow) => ({ origin: shadow.origin, path: shadow.path })) })
    }
    return result
  }

  /** Internal trusted resolution for updates; renderer input selects only an id and optional known layer. */
  async locate(root: string, id: string, origin?: FlowOrigin): Promise<{ readonly entry: FlowEntry; readonly source: string; readonly absolute: string }> {
    const entries = await this.list(root)
    const entry = entries.find((one) => one.id === id && (origin === undefined || one.origin === origin))
    if (!entry) throw new Error(`There is no flow called "${id}".`)
    if (entry.problem) throw new Error(entry.problem)
    const name = directName(entry.path.split('/').at(-1) ?? '')
    const base = entry.origin === 'project' ? join(root, FLOW_DIR) : entry.origin === 'user' ? this.#options.userRoot : this.#options.builtinRoot
    if (!base) throw new Error('That flow layer is not configured.')
    return { entry, source: await readConfinedFlow(base, name), absolute: join(base, name) }
  }

  async read(root: string, id: string, origin?: FlowOrigin): Promise<string> {
    // Compatibility callers historically pass a path. Only a direct child remains accepted.
    const candidate = id.startsWith(`${FLOW_DIR}/`) ? id.slice(FLOW_DIR.length + 1) : id
    directName(candidate)
    const found = await this.locate(root, idOf(candidate), origin)
    if (found.entry.path.split('/').at(-1) !== candidate) throw new Error(`A flow is read from ${FLOW_DIR}; "${id}" is somewhere else.`)
    return found.source
  }

  async customize(root: string, id: string, token: string): Promise<FlowUpdateResult> {
    if (!this.#options.customize) return { state: 'refused', written: [], message: 'Preview this customization before applying it.' }
    return this.#options.customize(root, id, token)
  }
}
