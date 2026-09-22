import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ceilingOfPermission, type Flow, type FlowProblem, type FlowPolicy, type FlowPolicyRole, type FlowSeat } from '@harnessdesk/protocol'

import { agentIdOf, createAgentFolder, projectAgentDir } from './agent-files.js'
import { FlowCatalog, readProjectFlow, replaceProjectFlow } from './flow-catalog.js'
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
export interface FlowUpdatesOptions { readonly stateDir: string; readonly catalogue: FlowCatalog; readonly now?: () => number }

const JOURNAL_AGENT = /^\.harnessdesk\/agents\/([a-z0-9][a-z0-9-]{0,47})\/AGENT\.md$/
const JOURNAL_FLOW = /^\.harnessdesk\/flows\/([^/\\\0]+\.ya?ml)$/i
const journalIsSafe = (value: unknown, root: string, id: string): value is Journal => {
  if (!value || typeof value !== 'object') return false
  const journal = value as Partial<Journal>
  if (journal.version !== 1 || journal.root !== root || journal.id !== id || typeof journal.source !== 'string'
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
  readonly #state: string
  readonly #catalogue: FlowCatalog
  readonly #now: () => number
  #tokens = new Map<string, Token>()
  constructor(options: FlowUpdatesOptions) { this.#state = options.stateDir; this.#catalogue = options.catalogue; this.#now = options.now ?? Date.now }
  #journalPath(root: string, id: string): string {
    // State is host-owned; encoding keeps source paths out of a state filename.
    return join(this.#state, 'flow-updates', Buffer.from(`${root}\0${id}`).toString('base64url') + '.json')
  }
  async #save(journal: Journal): Promise<void> {
    const path = this.#journalPath(journal.root, journal.id)
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
    try { await handle.writeFile(JSON.stringify(journal)); await handle.sync() } finally { await handle.close() }
  }
  async #load(root: string, id: string): Promise<Journal | null> {
    let source: string
    try { source = await readFile(this.#journalPath(root, id), 'utf8') } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null
      throw new Error('The saved flow update is unreadable. Remove it only after reviewing any partially created Agents.')
    }
    let journal: unknown
    try { journal = JSON.parse(source) } catch {
      throw new Error('The saved flow update is invalid. Remove it only after reviewing any partially created Agents.')
    }
    if (!journalIsSafe(journal, root, id)) throw new Error('The saved flow update is invalid. Remove it only after reviewing any partially created Agents.')
    return journal
  }
  #mint(root: string, journal: Journal | null): string { const token = crypto.randomUUID(); this.#tokens.set(token, { expires: this.#now() + 10 * 60_000, root, journal }); return token }

  async preview(root: string, id: string): Promise<FlowUpdatePreview> {
    const canonical = await realpath(root)
    const previous = await this.#load(canonical, id)
    if (previous && !previous.done) {
      const source = await this.#catalogue.read(canonical, previous.edits.at(-1)!.path, 'project')
      const flow = previous.edits.at(-1)!
      if (source !== flow.before && source !== flow.after) throw new Error('This flow changed after the preview. Preview the update again.')
      return { token: this.#mint(canonical, previous), resuming: true, edits: previous.edits, problems: [] }
    }
    const found = await this.#catalogue.locate(canonical, id)
    if (found.entry.origin !== 'project') throw new Error('Customize this flow into the project before updating it.')
    const parsed = updateProblems(found.source)
    if (!parsed.flow) return { token: this.#mint(canonical, null), resuming: false, edits: [], problems: parsed.problems }
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
    if (problems.some((problem) => problem.level === 'error')) return { token: this.#mint(canonical, null), resuming: false, edits, problems }
    const journal: Journal = { version: 1, root: canonical, id, source: found.source, created: this.#now(), edits, intended: [], written: [], done: false }
    await this.#save(journal)
    return { token: this.#mint(canonical, journal), resuming: false, edits, problems }
  }

  async apply(root: string, token: string): Promise<FlowUpdateResult> {
    const canonical = await realpath(root)
    const held = this.#tokens.get(token)
    this.#tokens.delete(token)
    if (!held || held.root !== canonical || held.expires < this.#now() || !held.journal) return { state: 'refused', written: [], message: 'This update preview expired. Preview the update again.' }
    const heldJournal = held.journal
    const errors = heldJournal.edits.length === 0 ? ['There is no valid update to apply.'] : parseFlowPolicy(heldJournal.edits.at(-1)!.after).problems.filter((one) => one.level === 'error').map((one) => one.text)
    if (errors.length) return { state: 'refused', written: [], message: errors[0]! }
    const intended = new Set(heldJournal.intended ?? [])
    const written = new Set(heldJournal.written)
    const journal = (): Journal => ({ ...heldJournal, intended: [...intended], written: [...written] })
    const port: MigrationPort = {
      read: async (path) => {
        try {
          return path.startsWith('.harnessdesk/flows/')
            ? await readProjectFlow(canonical, path)
            : await readFile(join(canonical, path), 'utf8')
        } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error }
      },
      recorded: async (path) => intended.has(path),
      record: async (path) => { intended.add(path); await this.#save(journal()) },
      create: async (path, after) => {
        const match = /^\.harnessdesk\/agents\/([^/]+)\/AGENT\.md$/.exec(path)
        if (!match) throw new Error('The update may create Agent files only.')
        await createAgentFolder(await projectAgentDir(canonical), match[1]!, after)
        written.add(path)
        await this.#save(journal())
      },
      replace: async (path, before, after) => {
        await replaceProjectFlow(canonical, path, before, after)
      },
    }
    try {
      await applyMigration(heldJournal.edits, port)
      const done = { ...journal(), done: true }
      await this.#save(done)
      return { state: 'applied', written: [...written], message: 'The flow update was applied.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#save(journal())
      return written.size
        ? { state: 'partial', written: [...written], message: 'The flow was not replaced. Some Agent files were created; review them, then continue the update.' }
        : { state: 'refused', written: [], message }
    }
  }
}
