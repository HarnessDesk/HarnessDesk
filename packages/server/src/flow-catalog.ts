import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { FlowProblem } from '@harnessdesk/protocol'

import { errnoOf, NOTHING_HERE } from './errno.js'
import { parseFlowPolicy } from './flow-policy.js'
import type { FlowUpdateResult } from './flow-update.js'
const FILE_LIMIT = 256 * 1024
const LAYER_LIMIT = 256
const FLOW_NAME = /^[^/\\\0]+\.ya?ml$/i
const FLOW_DIR = '.harnessdesk/flows'
/* macOS's O_NOFOLLOW_ANY refuses a link in any component. Node only exports
   O_NOFOLLOW for the final component, so retain that portable floor elsewhere. */
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : 0
const openNoFollow = (path: string, flags: number) => open(path, flags | (NOFOLLOW_ANY || constants.O_NOFOLLOW))

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

interface CheckedFolder { readonly path: string; readonly info: Awaited<ReturnType<typeof lstat>> }

/** Opens a directory only after refusing a link at every component Node can name. */
const checkedFolder = async (path: string): Promise<CheckedFolder> => {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A flow folder must be a real directory, not a link.')
  const handle = await openNoFollow(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isDirectory() || identity(opened) !== identity(info)) throw new Error('The flow folder changed while it was opened.')
  } finally {
    await handle.close()
  }
  return { path, info }
}

/** A project root may be reached through an open-folder link; nothing below it may. */
const projectFlowFolder = async (project: string): Promise<string | null> => {
  const root = await realpath(project)
  await checkedFolder(root)
  const harnessdesk = join(root, '.harnessdesk')
  let home
  try { home = await lstat(harnessdesk, { bigint: true }) } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
  }
  // A pre-flow legacy project may have a file at this name; it has no flows.
  if (!home.isDirectory() && !home.isSymbolicLink()) return null
  if (home.isSymbolicLink() || !home.isDirectory()) throw new Error('A flow folder must be a real directory, not a link.')
  const folder = join(harnessdesk, 'flows')
  try { await checkedFolder(folder) } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
  }
  return folder
}

/** Read at most one more than the layer limit, then reject the whole ambiguous listing. */
const boundedEntries = async (folder: string): Promise<{ readonly names: string[]; readonly exceeded: boolean }> => {
  const before = await checkedFolder(folder)
  const directory = await opendir(folder)
  const names: string[] = []
  try {
    while (names.length <= LAYER_LIMIT) {
      const entry = await directory.read()
      if (entry === null) break
      names.push(entry.name)
    }
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as { code?: string }).code !== 'ERR_DIR_CLOSED') throw error
    })
  }
  const after = await checkedFolder(folder)
  if (identity(before.info) !== identity(after.info)) throw new Error('The flow folder changed while it was listed.')
  return { names: names.slice(0, LAYER_LIMIT), exceeded: names.length > LAYER_LIMIT }
}

/** A bounded no-follow read, with every parent and file identity checked before accepting bytes. */
export const readConfinedFlow = async (base: string, name: string): Promise<string> => {
  directName(name)
  const { path: root, info: rootInfo } = await checkedFolder(base)
  const path = join(root, name)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('A flow must be a regular file with no links.')
  const handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK)
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

/** Resolve a journaled project-relative flow name without ever following `.harnessdesk`. */
export const readProjectFlow = async (project: string, path: string): Promise<string> => {
  const match = /^\.harnessdesk\/flows\/([^/]+)$/.exec(path)
  const name = match ? directName(match[1]!) : null
  if (!name) throw new Error('A project flow must live directly inside .harnessdesk/flows.')
  const folder = await projectFlowFolder(project)
  if (!folder) throw new Error('There is no flow at that path.')
  return readConfinedFlow(folder, name)
}

/** Replace one project flow through the same no-follow boundary that read it. */
export const replaceProjectFlow = async (project: string, path: string, before: string, after: string): Promise<void> => {
  const match = /^\.harnessdesk\/flows\/([^/]+)$/.exec(path)
  const name = match ? directName(match[1]!) : null
  if (!name) throw new Error('The update may replace one project flow only.')
  const folder = await projectFlowFolder(project)
  if (!folder) throw new Error('This flow changed after the preview. Preview the update again.')
  const root = await checkedFolder(folder)
  const target = join(root.path, name)
  const handle = await openNoFollow(target, constants.O_RDWR)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) throw new Error('A flow must be a regular file with no links.')
    const bytes = Buffer.alloc(FILE_LIMIT + 1)
    let used = 0
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used)
      if (read.bytesRead === 0) break
      used += read.bytesRead
    }
    if (used > FILE_LIMIT || new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)) !== before) {
      throw new Error('This flow changed after the preview. Preview the update again.')
    }
    await handle.truncate(0)
    await handle.writeFile(after, 'utf8')
    await handle.sync()
    const named = await lstat(target, { bigint: true })
    const rootAfter = await checkedFolder(folder)
    if (identity(named) !== identity(opened) || identity(root.info) !== identity(rootAfter.info)) {
      throw new Error('The flow folder changed while it was updated.')
    }
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
  let folder = base
  let names: string[]
  let exceeded: boolean
  try {
    const resolved = project ? await projectFlowFolder(base) : await realpath(base)
    if (!resolved) return []
    folder = resolved
    const bounded = await boundedEntries(folder)
    names = bounded.names
    exceeded = bounded.exceeded
  } catch (error) {
    if (NOTHING_HERE.has(errnoOf(error))) return []
    if (strict) throw error
    return [{ origin, name: 'Unreadable flows', id: '__unreadable__', path: project ? FLOW_DIR : '', absolute: folder, problem: error instanceof Error ? error.message : String(error) }]
  }
  if (exceeded) return [{ origin, id: '__limit__', name: 'Too many flows', path: project ? FLOW_DIR : '', absolute: folder, problem: 'A flow layer may contain at most 256 entries.' }]
  const candidates = names.filter((name) => /\.ya?ml$/i.test(name)).sort((a, b) => a.localeCompare(b))
  const found: FoundFlow[] = []
  const byId = new Map<string, string[]>()
  for (const name of candidates) {
    const id = idOf(name)
    const names = byId.get(id) ?? []
    names.push(name)
    byId.set(id, names)
  }
  for (const [id, names] of byId) {
    for (const name of names) {
      const path = project ? `${FLOW_DIR}/${name}` : name
      const absolute = join(folder!, name)
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
          const source = await readConfinedFlow(dirname(winner!.absolute), winner!.name)
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
    const found = (await this.#all(root)).find((one) => one.origin === entry.origin && one.path === entry.path)
    if (!found) throw new Error(`There is no flow called "${id}".`)
    return { entry, source: await readConfinedFlow(dirname(found.absolute), name), absolute: found.absolute }
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
