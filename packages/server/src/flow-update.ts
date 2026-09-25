import { createHash } from 'node:crypto'

import {
  ceilingOfPermission,
  type Flow,
  type FlowFileEdit,
  type FlowProblem,
  type FlowPolicy,
  type FlowPolicyRole,
  type FlowSeat,
  type FlowUpdatePreview,
  type FlowUpdateResult,
} from '@harnessdesk/protocol'

import { agentIdOf } from './agent-files.js'
import { AGENT_FILE_LIMIT, AGENT_TEMP_PREFIX, PROJECT_AGENT_DIR } from './agents.js'
import { ConfinedTree, type TreeIdentity } from './confined-tree.js'
import { errnoOf } from './errno.js'
import { legacyBrief } from './flow.js'
import { FLOW_FILE_LIMIT, type FlowCatalog } from './flow-catalog.js'
import { parseFlowPolicy, serializeFlowPolicy } from './flow-policy.js'

export type { FlowFileEdit, FlowUpdatePreview, FlowUpdateResult } from '@harnessdesk/protocol'

export interface MigrationEdit { readonly path: string; readonly before: string | null; readonly after: string }
export interface MigrationPort {
  read(path: string): Promise<string | null>
  create(path: string, after: string): Promise<void>
  replace(path: string, before: string, after: string): Promise<void>
  recorded(path: string): Promise<boolean>
  record(path: string): Promise<void>
}

/** The ordered, replay-safe core: creates are journaled and complete before the source is replaced. */
export const applyMigration = async (edits: readonly MigrationEdit[], port: MigrationPort): Promise<void> => {
  const flow = edits.at(-1)
  if (!flow || flow.before === null || edits.slice(0, -1).some((edit) => edit.before !== null)) throw new Error('The update must create Agents before replacing one flow.')
  const current = await port.read(flow.path)
  if (current !== flow.before && current !== flow.after) throw new Error('This flow changed after the preview. Preview the update again.')
  for (const edit of edits.slice(0, -1)) {
    const found = await port.read(edit.path)
    if (found !== null && (!(await port.recorded(edit.path)) || found !== edit.after)) throw new Error('An Agent file already exists. Choose another flow name and preview again.')
  }
  for (const edit of edits.slice(0, -1)) {
    if (await port.read(edit.path) === null) {
      await port.record(edit.path)
      await port.create(edit.path, edit.after)
    }
  }
  if (current === flow.before) await port.replace(flow.path, flow.before, flow.after)
}

interface Journal {
  readonly version: 1
  readonly root: string
  /** The project root's identity when the update was previewed: a replaced root is refused, not written into. */
  readonly rootIdentity: TreeIdentity
  readonly id: string
  readonly source: string
  readonly created: number
  readonly edits: readonly FlowFileEdit[]
  /** Creates this journal authorized, before their exclusive writes begin. */
  readonly intended: readonly string[]
  /** Files whose creation returned successfully. This is the truthful partial-result list. */
  readonly written: readonly string[]
  readonly done: boolean
}
interface Token { readonly expires: number; readonly root: string; readonly journal: Journal | null }
export interface FlowUpdatesOptions {
  readonly stateDir: string
  readonly catalogue: FlowCatalog
  readonly now?: () => number
  /** Tests only: the platform the host's own state tree behaves as. */
  readonly platform?: NodeJS.Platform
  /**
   * The desk's one queue of configuration writes, keyed by the canonical
   * tree they land in. The host hands the same queue to authoring saves, so
   * a conversion and a save into one project never interleave. Absent, this
   * updater keeps a queue of its own.
   */
  readonly queue?: TreeQueue
}

// ------------------------------------------------ the shared transaction parts

/**
 * One queue per canonical tree: every configuration write into a project, or
 * into the desk's own folder, runs behind the one before it. A leaf in the
 * host's lock order — a holder asks for nothing else while it holds this.
 */
export class TreeQueue {
  readonly #tails = new Map<string, { tail: Promise<unknown>; depth: number }>()

  /** `waiting` is told when this call queues behind another on the same tree: what a test gates a race on. */
  run<T>(key: string, fn: () => Promise<T>, waiting?: (key: string) => void): Promise<T> {
    const entry = this.#tails.get(key) ?? { tail: Promise.resolve(), depth: 0 }
    this.#tails.set(key, entry)
    if (entry.depth > 0) waiting?.(key)
    entry.depth += 1
    const result = entry.tail.then(fn)
    entry.tail = result.catch(() => {}).finally(() => {
      entry.depth -= 1
      if (entry.depth === 0 && this.#tails.get(key) === entry) this.#tails.delete(key)
    })
    return result
  }
}

/**
 * The desk's own journals: whole JSON documents in its state folder, each
 * written as a synced sibling renamed over the last, so a crash leaves the
 * previous record or this one and never a torn file. Flow conversions and
 * authoring saves keep theirs here, each under its own folder.
 */
export class StateJournal {
  readonly #stateDir: string
  readonly #platform: NodeJS.Platform | undefined
  constructor(stateDir: string, platform?: NodeJS.Platform) {
    this.#stateDir = stateDir
    this.#platform = platform
  }

  async #tree(create: boolean): Promise<ConfinedTree> {
    return ConfinedTree.open(this.#stateDir, { create, ...(this.#platform ? { platform: this.#platform } : {}) })
  }

  /** Answers only once the record is durable. */
  async save(rel: string, value: unknown): Promise<void> {
    const tree = await this.#tree(true)
    const folder = rel.split('/').slice(0, -1).join('/')
    if (folder) await tree.ensureDir(folder)
    await tree.put(rel, JSON.stringify(value))
  }

  /** The record's text, or null when there is none. A record that cannot be read throws. */
  async load(rel: string, limit: number): Promise<string | null> {
    try {
      return await (await this.#tree(false)).read(rel, limit)
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null
      throw error
    }
  }

  /** The names of the records in one folder, at most `limit`; empty when there is no folder yet. */
  async list(folder: string, limit: number): Promise<readonly string[]> {
    let tree: ConfinedTree
    try {
      tree = await this.#tree(false)
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return []
      throw error
    }
    const listed = await tree.list(folder, limit)
    if (!listed) return []
    if (listed.exceeded) throw new Error('There are too many saved records to read. Remove finished ones before saving again.')
    return listed.entries.filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json')).map((entry) => entry.name)
  }
}

/** Where a tree keeps its Agents: `.harnessdesk/agents` in a project, `agents` in the desk's own folder. */
export interface ConfinedLayout { readonly agents: string }

/**
 * The confined write adapter every configuration save goes through: reads
 * bounded and link-refusing, an Agent created as a whole folder renamed into
 * place, any other new file created whole and never over anything, and a
 * replacement only while the file still holds the previewed bytes. Nothing
 * here follows a link or writes on a platform that cannot refuse one.
 */
export interface ConfinedWrites {
  read(rel: string): Promise<string | null>
  /** Creates `rel`; refuses with `EEXIST` when anything is there. */
  create(rel: string, after: string): Promise<void>
  /** Replaces `rel` only while it holds `before`; refuses with `HD_TREE_CHANGED_BYTES` when it holds anything else. */
  replace(rel: string, before: string, after: string): Promise<void>
}

const agentFileIn = (layout: ConfinedLayout, rel: string): string | null => {
  const prefix = `${layout.agents}/`
  if (!rel.startsWith(prefix)) return null
  const match = /^([a-z0-9][a-z0-9-]{0,47})\/AGENT\.md$/.exec(rel.slice(prefix.length))
  return match ? match[1]! : null
}

export const confinedWrites = (tree: ConfinedTree, layout: ConfinedLayout): ConfinedWrites => ({
  read: (rel) => tree.read(rel, agentFileIn(layout, rel) !== null ? AGENT_FILE_LIMIT : FLOW_FILE_LIMIT),
  create: async (rel, after) => {
    const agent = agentFileIn(layout, rel)
    if (agent !== null) {
      await tree.ensureDir(layout.agents)
      await tree.createFolder(`${layout.agents}/${agent}`, [['AGENT.md', after]], AGENT_TEMP_PREFIX)
      return
    }
    const folder = rel.split('/').slice(0, -1).join('/')
    if (folder) await tree.ensureDir(folder)
    await tree.createAtomic(rel, after)
  },
  replace: async (rel, before, after) => {
    if (await tree.replace(rel, before, after) === 'changed') {
      throw Object.assign(new Error(`"${rel}" changed after it was previewed, so it was not written.`), { code: 'HD_TREE_CHANGED_BYTES' })
    }
  },
})

const JOURNAL_LIMIT = 4 * 1024 * 1024
const JOURNAL_AGENT = /^\.harnessdesk\/agents\/([a-z0-9][a-z0-9-]{0,47})\/AGENT\.md$/
const JOURNAL_FLOW = /^\.harnessdesk\/flows\/([^/\\\0]+\.ya?ml)$/i
const isIdentity = (value: unknown): value is TreeIdentity =>
  !!value && typeof value === 'object' && typeof (value as TreeIdentity).dev === 'string' && typeof (value as TreeIdentity).ino === 'string'
const journalIsSafe = (value: unknown, root: string, id: string): value is Journal => {
  if (!value || typeof value !== 'object') return false
  const journal = value as Partial<Journal>
  if (journal.version !== 1 || journal.root !== root || journal.id !== id || typeof journal.source !== 'string' || !isIdentity(journal.rootIdentity)
    || !Number.isSafeInteger(journal.created) || typeof journal.done !== 'boolean' || !Array.isArray(journal.edits)
    || journal.edits.length === 0 || !Array.isArray(journal.intended) || !Array.isArray(journal.written)) return false
  const edits = journal.edits as readonly Partial<FlowFileEdit>[]
  const flow = edits.at(-1)
  const flowName = typeof flow?.path === 'string' ? JOURNAL_FLOW.exec(flow.path)?.[1] : null
  if (!flow || !flowName || flowName.replace(/\.ya?ml$/i, '') !== id || typeof flow.before !== 'string' || flow.before !== journal.source || typeof flow.after !== 'string') return false
  const creates = edits.slice(0, -1)
  if (creates.some((edit) => typeof edit.path !== 'string' || !JOURNAL_AGENT.test(edit.path) || edit.before !== null || typeof edit.after !== 'string')) return false
  const permitted = new Set(creates.map((edit) => edit.path!))
  return journal.intended.every((path) => typeof path === 'string' && permitted.has(path))
    && journal.written.every((path) => typeof path === 'string' && permitted.has(path))
}

const FLOWS_DIR = '.harnessdesk/flows'
const CHANGED = 'This flow changed after the preview. Preview the update again.'
const ROOT_CHANGED = 'The project folder changed after the preview. Preview the update again.'
const EXISTS = 'An Agent file already exists. Choose another flow name and preview again.'

/**
 * A refusal as a sentence a window may show: never a path on this machine.
 * The confined tree's own refusals name project-relative paths only; an error
 * straight from the file system names the absolute one, so it is replaced by
 * what happened and its code.
 */
export const refusalOf = (error: unknown, root: string): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const fromFs = typeof error === 'object' && error !== null && ('syscall' in error || 'path' in error)
  if (!fromFs && !raw.includes(root) && !/(^|[\s'"(])\/[^\s'"]/.test(raw)) return raw
  const code = errnoOf(error)
  return `The file system refused to write the flow into the project${code ? ` (${code})` : ''}, so nothing was written.`
}

const q = (text: string): string => JSON.stringify(text)
const safeId = (flow: string, role: string): string => {
  const raw = `${flow}-${role}`
  const id = agentIdOf(raw)
  if (!id || id !== raw) throw new Error('Choose a safe flow name and role name before updating this flow.')
  return id
}
const agentText = (name: string, role: Flow['roles'][number], prefer: readonly FlowSeat[]): string => [
  '---', `name: ${q(name)}`, `ceiling: ${ceilingOfPermission(role.permission)}`,
  `answers: [${role.outcomes.map(q).join(', ')}]`,
  ...(prefer.length ? ['prefer:', ...prefer.map((seat) => `  - ${q(`${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}${seat.thinking ? '+' : ''}`)}`)] : []),
  '---', '', legacyBrief(role), '',
].join('\n')

const converted = (id: string, flow: Flow): readonly FlowFileEdit[] => {
  const edits: FlowFileEdit[] = []
  const roles: FlowPolicyRole[] = flow.roles.map((role) => {
    if (role.kind !== 'agent') return role.kind === 'person'
      ? { id: role.id, kind: 'person', outcomes: role.outcomes }
      : { id: role.id, kind: 'check', check: role.check! }
    const agent = safeId(id, role.id)
    const listed = role.seats.length > 1
    edits.push({ path: `.harnessdesk/agents/${agent}/AGENT.md`, before: null, after: agentText(`${flow.name} — ${role.id}`, role, listed ? [] : role.seats) })
    return { id: role.id, kind: 'agent', uses: [agent], seats: listed ? role.seats : [], ...(listed ? {} : { count: role.count }), isolate: role.isolate === true, grant: ceilingOfPermission(role.permission), independentOf: [] }
  })
  const policy: FlowPolicy = { version: 2, name: flow.name, ...(flow.description ? { description: flow.description } : {}), inputs: flow.inputs, roles, rules: flow.rules.map((rule) => ({ id: rule.id, on: rule.on, ...(rule.when ? { when: rule.when } : {}), then: rule.then })), seed: flow.seed, messaging: 'board-only', wait: flow.wait, ...(flow.rearm ? { rearm: flow.rearm } : {}), ...(flow.layout === undefined ? {} : { layout: flow.layout }) }
  edits.push({ path: `.harnessdesk/flows/${id}.yml`, before: null, after: serializeFlowPolicy(policy) })
  return edits
}

const updateProblems = (source: string): { readonly flow: Flow | null; readonly problems: readonly FlowProblem[] } => {
  const parsed = parseFlowPolicy(source)
  if (!parsed.document) return { flow: null, problems: parsed.problems }
  if (parsed.document.format !== 'legacy') return { flow: null, problems: [{ level: 'error', at: 'format', text: 'This flow already uses the Agent format.' }] }
  return { flow: parsed.document.flow, problems: parsed.problems }
}

export class FlowUpdates {
  readonly #stateDir: string
  readonly #catalogue: FlowCatalog
  readonly #now: () => number
  readonly #platform: NodeJS.Platform | undefined
  readonly #queue: TreeQueue
  readonly #journal: StateJournal
  #tokens = new Map<string, Token>()
  #customizeTokens = new Map<string, { readonly expires: number; readonly root: string; readonly path: string; readonly source: string }>()
  constructor(options: FlowUpdatesOptions) {
    this.#stateDir = options.stateDir
    this.#catalogue = options.catalogue
    this.#now = options.now ?? Date.now
    this.#platform = options.platform
    this.#queue = options.queue ?? new TreeQueue()
    this.#journal = new StateJournal(options.stateDir, options.platform)
  }

  /** The journal's name: a digest, so no project path ever becomes (or overflows) a file name. */
  #journalName(root: string, id: string): string {
    return `flow-updates/${createHash('sha256').update(`${root}\0${id}`).digest('hex')}.json`
  }

  /** Written whole through the state tree: a crash leaves the previous journal or this one, never a torn file. */
  async #save(journal: Journal): Promise<void> {
    await this.#journal.save(this.#journalName(journal.root, journal.id), journal)
  }

  async #load(root: string, id: string): Promise<Journal | null> {
    let source: string | null
    try {
      source = await this.#journal.load(this.#journalName(root, id), JOURNAL_LIMIT)
    } catch {
      throw new Error('The saved flow update is unreadable. Remove it only after reviewing any partially created Agents.')
    }
    if (source === null) return null
    let journal: unknown
    try { journal = JSON.parse(source) } catch {
      throw new Error('The saved flow update is invalid. Remove it only after reviewing any partially created Agents.')
    }
    if (!journalIsSafe(journal, root, id)) throw new Error('The saved flow update is invalid. Remove it only after reviewing any partially created Agents.')
    return journal
  }

  #mint(root: string, journal: Journal | null): string { const token = crypto.randomUUID(); this.#tokens.set(token, { expires: this.#now() + 10 * 60_000, root, journal }); return token }

  // ------------------------------------------------------------- customize

  /**
   * A user or built-in flow, copied into the project verbatim — no format
   * conversion, unlike `preview`/`apply` above. Never overwrites: a project
   * layer already holding this id is edited in place through the normal
   * editor, not customized over.
   */
  async customizePreview(root: string, id: string): Promise<FlowUpdatePreview> {
    const project = await this.#catalogue.project(root)
    const found = await this.#catalogue.locate(project, id)
    if (found.entry.origin === 'project') throw new Error('This flow is already a project flow. Edit it directly.')
    const path = `${FLOWS_DIR}/${id}.yml`
    const problems: FlowProblem[] = []
    if (!project.writable) {
      problems.push({ level: 'error', at: 'update', text: 'HarnessDesk cannot change project files on this system, so this cannot be applied.' })
    }
    const edits: readonly FlowFileEdit[] = [{ path, before: null, after: found.source }]
    if (problems.some((one) => one.level === 'error')) return { token: this.#mint(project.root, null), resuming: false, edits, problems }
    const token = crypto.randomUUID()
    this.#customizeTokens.set(token, { expires: this.#now() + 10 * 60_000, root: project.root, path, source: found.source })
    return { token, resuming: false, edits, problems }
  }

  async customizeApply(root: string, id: string, token: string): Promise<FlowUpdateResult> {
    const held = this.#customizeTokens.get(token)
    this.#customizeTokens.delete(token)
    const expired: FlowUpdateResult = { state: 'refused', written: [], message: 'This update preview expired. Preview the update again.' }
    if (!held || held.expires < this.#now() || held.path !== `${FLOWS_DIR}/${id}.yml`) return expired
    let project: ConfinedTree
    try {
      project = await this.#catalogue.project(root)
    } catch (error) {
      return { state: 'refused', written: [], message: refusalOf(error, root) }
    }
    if (held.root !== project.root) return expired
    if (!project.writable) return { state: 'refused', written: [], message: 'HarnessDesk cannot change project files on this system, so nothing was written.' }
    return this.#queue.run(project.root, async () => {
      try {
        // A project that never had a flow of its own has no folder for one yet: made through the same confined writer.
        await confinedWrites(project, { agents: PROJECT_AGENT_DIR.split(/[\\/]/).join('/') }).create(held.path, held.source)
        return { state: 'applied', written: [held.path], message: 'The flow was copied into the project.' }
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') {
          return { state: 'refused', written: [], message: 'A project flow already exists at that name. Edit it directly, or choose another name.' }
        }
        return { state: 'refused', written: [], message: refusalOf(error, project.root) }
      }
    })
  }

  async preview(root: string, id: string): Promise<FlowUpdatePreview> {
    // One confinement and one canonical root for the whole preview.
    const project = await this.#catalogue.project(root)
    const previous = await this.#load(project.root, id)
    if (previous && !previous.done) {
      const flow = previous.edits.at(-1)!
      if (previous.rootIdentity.dev !== project.identity.dev || previous.rootIdentity.ino !== project.identity.ino) throw new Error(ROOT_CHANGED)
      const source = await project.read(flow.path, FLOW_FILE_LIMIT)
      if (source !== flow.before && source !== flow.after) throw new Error(CHANGED)
      // Only a file this journal meant to create, holding exactly its bytes, is adopted on resume.
      const intended = new Set(previous.intended)
      for (const edit of previous.edits.slice(0, -1)) {
        const found = await project.read(edit.path, AGENT_FILE_LIMIT)
        if (found !== null && (!intended.has(edit.path) || found !== edit.after)) throw new Error(EXISTS)
      }
      return { token: this.#mint(project.root, previous), resuming: true, edits: previous.edits, problems: [] }
    }
    const found = await this.#catalogue.locate(project, id)
    if (found.entry.origin !== 'project') throw new Error('Customize this flow into the project before updating it.')
    const parsed = updateProblems(found.source)
    if (!parsed.flow) return { token: this.#mint(project.root, null), resuming: false, edits: [], problems: parsed.problems }
    let edits: readonly FlowFileEdit[] = []
    let problems = parsed.problems
    try {
      const creates = converted(id, parsed.flow)
      edits = [...creates.slice(0, -1), { ...creates.at(-1)!, path: found.entry.path, before: found.source }]
      const verified = parseFlowPolicy(edits.at(-1)!.after)
      problems = [...problems, ...verified.problems]
    } catch (error) {
      problems = [...problems, { level: 'error', at: 'update', text: error instanceof Error ? error.message : String(error) }]
    }
    if (!project.writable) {
      problems = [...problems, { level: 'error', at: 'update', text: 'HarnessDesk cannot change project files on this system, so this update can be read but not applied.' }]
    }
    if (problems.some((problem) => problem.level === 'error')) return { token: this.#mint(project.root, null), resuming: false, edits, problems }
    const journal: Journal = { version: 1, root: project.root, rootIdentity: project.identity, id, source: found.source, created: this.#now(), edits, intended: [], written: [], done: false }
    await this.#save(journal)
    return { token: this.#mint(project.root, journal), resuming: false, edits, problems }
  }

  async apply(root: string, token: string): Promise<FlowUpdateResult> {
    const held = this.#tokens.get(token)
    this.#tokens.delete(token)
    const expired: FlowUpdateResult = { state: 'refused', written: [], message: 'This update preview expired. Preview the update again.' }
    if (!held || held.expires < this.#now() || !held.journal) return expired
    // One confinement and one canonical root for the whole apply, pinned to the previewed root's identity.
    let project: ConfinedTree
    try {
      project = await this.#catalogue.project(root)
    } catch (error) {
      return { state: 'refused', written: [], message: refusalOf(error, root) }
    }
    if (held.root !== project.root) return expired
    const heldJournal = held.journal
    if (heldJournal.rootIdentity.dev !== project.identity.dev || heldJournal.rootIdentity.ino !== project.identity.ino) {
      return { state: 'refused', written: [], message: ROOT_CHANGED }
    }
    if (!project.writable) return { state: 'refused', written: [], message: 'HarnessDesk cannot change project files on this system, so nothing was written.' }
    const errors = heldJournal.edits.length === 0 ? ['There is no valid update to apply.'] : parseFlowPolicy(heldJournal.edits.at(-1)!.after).problems.filter((one) => one.level === 'error').map((one) => one.text)
    if (errors.length) return { state: 'refused', written: [], message: errors[0]! }
    const intended = new Set(heldJournal.intended ?? [])
    const written = new Set(heldJournal.written)
    const journal = (): Journal => ({ ...heldJournal, intended: [...intended], written: [...written] })
    const writes = confinedWrites(project, { agents: PROJECT_AGENT_DIR.split(/[\\/]/).join('/') })
    const port: MigrationPort = {
      read: (path) => writes.read(path),
      recorded: async (path) => intended.has(path),
      record: async (path) => { intended.add(path); await this.#save(journal()) },
      create: async (path, after) => {
        if (!JOURNAL_AGENT.test(path)) throw new Error('The update may create Agent files only.')
        try {
          await writes.create(path, after)
        } catch (error) {
          if (errnoOf(error) === 'EEXIST') throw new Error(EXISTS)
          throw error
        }
        written.add(path)
        await this.#save(journal())
      },
      replace: async (path, before, after) => {
        if (!JOURNAL_FLOW.test(path)) throw new Error('The update may replace one project flow only.')
        try {
          await writes.replace(path, before, after)
        } catch (error) {
          if (errnoOf(error) === 'HD_TREE_CHANGED_BYTES') throw new Error(CHANGED)
          throw error
        }
      },
    }
    // The same queue an authoring save into this project takes: a conversion and a save never interleave.
    return this.#queue.run(project.root, async () => {
      try {
        await applyMigration(heldJournal.edits, port)
        const done = { ...journal(), done: true }
        await this.#save(done)
        return { state: 'applied', written: [...written], message: 'The flow update was applied.' }
      } catch (error) {
        const message = refusalOf(error, project.root)
        await this.#save(journal()).catch(() => {})
        return written.size
          ? { state: 'partial', written: [...written], message: 'The flow was not replaced. Some Agent files were created; review them, then continue the update.' }
          : { state: 'refused', written: [], message }
      }
    })
  }
}
