import { createHash } from 'node:crypto'

import { ceilingOfPermission, type Flow, type FlowProblem, type FlowPolicy, type FlowPolicyRole, type FlowSeat } from '@harnessdesk/protocol'

import { agentIdOf } from './agent-files.js'
import { AGENT_FILE_LIMIT, AGENT_TEMP_PREFIX, PROJECT_AGENT_DIR } from './agents.js'
import { ConfinedTree, type TreeIdentity } from './confined-tree.js'
import { errnoOf } from './errno.js'
import { FLOW_FILE_LIMIT, type FlowCatalog } from './flow-catalog.js'
import { parseFlowPolicy, serializeFlowPolicy } from './flow-policy.js'

export interface FlowFileEdit {
  readonly path: string
  readonly before: string | null
  readonly after: string
}
export interface FlowUpdatePreview {
  readonly token: string
  readonly resuming: boolean
  readonly edits: readonly FlowFileEdit[]
  readonly problems: readonly FlowProblem[]
}
export interface FlowUpdateResult {
  readonly state: 'applied' | 'partial' | 'refused'
  readonly written: readonly string[]
  readonly message: string
}
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
}

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

const CHANGED = 'This flow changed after the preview. Preview the update again.'
const ROOT_CHANGED = 'The project folder changed after the preview. Preview the update again.'
const EXISTS = 'An Agent file already exists. Choose another flow name and preview again.'

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
  '---', '', role.order ?? '', '',
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
  #tokens = new Map<string, Token>()
  constructor(options: FlowUpdatesOptions) {
    this.#stateDir = options.stateDir
    this.#catalogue = options.catalogue
    this.#now = options.now ?? Date.now
    this.#platform = options.platform
  }

  /** The journal's name: a digest, so no project path ever becomes (or overflows) a file name. */
  #journalName(root: string, id: string): string {
    return `flow-updates/${createHash('sha256').update(`${root}\0${id}`).digest('hex')}.json`
  }

  async #state(create: boolean): Promise<ConfinedTree> {
    return ConfinedTree.open(this.#stateDir, { create, ...(this.#platform ? { platform: this.#platform } : {}) })
  }

  /** Written whole through the state tree: a crash leaves the previous journal or this one, never a torn file. */
  async #save(journal: Journal): Promise<void> {
    const state = await this.#state(true)
    await state.ensureDir('flow-updates')
    await state.put(this.#journalName(journal.root, journal.id), JSON.stringify(journal))
  }

  async #load(root: string, id: string): Promise<Journal | null> {
    let source: string | null
    try {
      source = await (await this.#state(false)).read(this.#journalName(root, id), JOURNAL_LIMIT)
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null
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
      return { state: 'refused', written: [], message: error instanceof Error ? error.message : String(error) }
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
    const agentsDir = PROJECT_AGENT_DIR.split(/[\\/]/).join('/')
    const port: MigrationPort = {
      read: (path) => project.read(path, path.startsWith(`${agentsDir}/`) ? AGENT_FILE_LIMIT : FLOW_FILE_LIMIT),
      recorded: async (path) => intended.has(path),
      record: async (path) => { intended.add(path); await this.#save(journal()) },
      create: async (path, after) => {
        const match = JOURNAL_AGENT.exec(path)
        if (!match) throw new Error('The update may create Agent files only.')
        await project.ensureDir(agentsDir)
        try {
          await project.createFolder(`${agentsDir}/${match[1]!}`, [['AGENT.md', after]], AGENT_TEMP_PREFIX)
        } catch (error) {
          if (errnoOf(error) === 'EEXIST') throw new Error(EXISTS)
          throw error
        }
        written.add(path)
        await this.#save(journal())
      },
      replace: async (path, before, after) => {
        if (!JOURNAL_FLOW.test(path)) throw new Error('The update may replace one project flow only.')
        if (await project.replace(path, before, after) === 'changed') throw new Error(CHANGED)
      },
    }
    try {
      await applyMigration(heldJournal.edits, port)
      const done = { ...journal(), done: true }
      await this.#save(done)
      return { state: 'applied', written: [...written], message: 'The flow update was applied.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#save(journal()).catch(() => {})
      return written.size
        ? { state: 'partial', written: [...written], message: 'The flow was not replaced. Some Agent files were created; review them, then continue the update.' }
        : { state: 'refused', written: [], message }
    }
  }
}
