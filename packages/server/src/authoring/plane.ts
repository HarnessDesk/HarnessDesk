import { createHash, randomUUID } from 'node:crypto'

import type {
  AgentEntry,
  AgentFieldEdit,
  AuthoringDocument,
  AuthoringIssue,
  AuthoringPending,
  AuthoringSaveInput,
  AuthoringSavePreview,
  AuthoringSaveResult,
  AuthoringTarget,
  FlowFileEdit,
  FlowPolicy,
  TriggerDefinition,
  TriggerSource,
  WritableAuthoringTarget,
} from '@harnessdesk/protocol'

import { parseAgentDefinition } from '../agent-def.js'
import { AGENT_FILE_LIMIT } from '../agents.js'
import { ConfinedTree, type TreeIdentity } from '../confined-tree.js'
import { errnoOf, NOTHING_HERE } from '../errno.js'
import { FLOW_FILE_LIMIT } from '../flow-catalog.js'
import { parseFlowPolicy } from '../flow-policy.js'
import { confinedWrites, StateJournal, type ConfinedLayout, type ConfinedWrites, type TreeQueue } from '../flow-update.js'
import { parseTriggers, TRIGGER_FILE_LIMIT } from '../intake/definition.js'
import { draftTrigger, editAgentSource, readShapeLayout, writeShape, writeTriggers } from './model.js'
import { applySave, type SaveEdit, type SavePort } from './save.js'

/**
 * The one owner of authoring saves: an Agent's file, a flow and a project's
 * triggers, read exactly and written only through a preview a person saw.
 *
 * - **Where** is the host's to say. A target is an origin and an id; a
 *   project's files resolve through the open workspace to its canonical,
 *   identity-pinned tree, this person's through the desk's own folder, and a
 *   built-in file is read and never written.
 * - **What** is the owning parser's to say. A source that does not read as an
 *   Agent, a new-format flow or a trigger list is not saved, and a flow for
 *   this person that names an Agent only one project has is refused rather
 *   than left pointing at nothing elsewhere.
 * - **When** is the preview's. A token binds the tree and its identity, every
 *   file's exact bytes before and after, and the checks behind them; it
 *   expires in ten minutes or with the host. Applying re-checks all of it
 *   under the tree's queue, journals the transaction durably, writes new
 *   Agents before the flow that names them, and checkpoints each file before
 *   the next. A token already applied answers its saved result again.
 * - **After a crash**, nothing resumes on its own. An unfinished save is
 *   listed with what is known to have landed; resuming it reads every file on
 *   disk and writes only what is missing, and discarding it drops the record
 *   and leaves every file as it is. Nothing is ever deleted as a rollback.
 *
 * Every read and write below a root goes through `ConfinedTree` — links
 * refused at any component, bounded reads, a new file created whole and never
 * over anything, a replacement renamed into place only while the file still
 * holds the previewed bytes.
 */

/** Test seams on the real path: each runs at its step, inside the tree's queue. */
export interface AuthoringHooks {
  /** This apply queued behind another save on the same tree. */
  readonly queued?: (key: string) => void
  readonly verified?: () => void | Promise<void>
  readonly prepared?: () => void | Promise<void>
  readonly beforeWrite?: (path: string) => void | Promise<void>
  /** After a file has landed, before its checkpoint is recorded. */
  readonly afterWrite?: (path: string) => void | Promise<void>
  /** At a file's checkpoint, before the journal records it. */
  readonly recorded?: (path: string) => void | Promise<void>
}

export interface AuthoringPlaneOptions {
  /** The desk's own folder: this person's Agents are in `agents/` below it, their flows in `flows/`. */
  readonly home: string
  /** Where this plane keeps its journals. */
  readonly journal: string
  readonly builtinAgents: string
  readonly builtinFlows: string
  /** Refuses a project folder that is not open here. */
  readonly confine: (root: string) => Promise<void>
  /** The Agent roster, as a flow in `root` would resolve it. */
  readonly agents: (root: string) => Promise<readonly AgentEntry[]>
  /** The desk's one queue of configuration writes, shared with flow updates. */
  readonly queue: TreeQueue
  /** Told after any save that wrote something, applied or not, so listings read again. */
  readonly changed?: (change: { readonly scope: 'project' | 'user'; readonly root: string | null; readonly agents: boolean }) => void
  readonly now?: () => number
  /** Tests only: the platform every tree behaves as. */
  readonly platform?: NodeJS.Platform
  readonly hooks?: AuthoringHooks
}

const PROJECT_LAYOUT: ConfinedLayout = { agents: '.harnessdesk/agents' }
const USER_LAYOUT: ConfinedLayout = { agents: 'agents' }
const PROJECT_FLOWS = '.harnessdesk/flows'
const USER_FLOWS = 'flows'
const TRIGGERS = '.harnessdesk/triggers.yml'
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const FLOW_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TOKEN_LIFE = 10 * 60_000
const JOURNALS = 'transactions'
const JOURNAL_LIMIT = 8 * 1024 * 1024
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export const CHANGED = 'The file changed. Reload before saving.'
export const MODELS_STAY_HERE = 'Keep model choices on this Mac.'
export const COPY_AGENTS_FIRST = 'Copy these Agents for you first.'
const EXPIRED: AuthoringSaveResult = { state: 'refused', written: [], message: 'This save preview expired. Preview the save again.' }
const UNFINISHED = 'An earlier save of one of these files did not finish.'
const UNFINISHED_FIX = 'Resume or discard that save from the list of unfinished saves first.'

const digestOf = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex')
const bytes = (source: string): number => Buffer.byteLength(source, 'utf8')
const issue = (at: string, text: string, fix: string): AuthoringIssue => ({ at, text, fix })

/** A refusal a window may show: a confined tree's own sentence, or what the file system did — never a path on this machine. */
const sentenceOf = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const fromFs = typeof error === 'object' && error !== null && ('syscall' in error || 'path' in error)
  if (!fromFs && !/(^|[\s'"(])\/[^\s'"]/.test(raw)) {
    if (errnoOf(error) === 'EEXIST') return 'A file appeared at that name after the preview, so it was not overwritten. Reload before saving.'
    if (errnoOf(error) === 'HD_TREE_CHANGED_BYTES') return CHANGED
    return raw
  }
  const code = errnoOf(error)
  return `The file system refused this save${code ? ` (${code})` : ''}, so that file was not written.`
}

type Scope = 'project' | 'user' | 'builtin'

/** Where one target lives: its tree, its path in that tree, and the Agents folder beside it. */
interface Place {
  readonly scope: Scope
  readonly tree: ConfinedTree
  /** The canonical project, for a project's file. */
  readonly project: string | null
  readonly layout: ConfinedLayout
  readonly rel: string
  readonly writes: ConfinedWrites
}

interface SaveJournal {
  readonly version: 1
  readonly id: string
  /** This transaction; a resume token binds it, so a newer save under the same id is never finished by an older preview. */
  readonly tx: string
  readonly scope: 'project' | 'user'
  readonly root: string
  readonly project: string | null
  readonly rootIdentity: TreeIdentity
  readonly edits: readonly SaveEdit[]
  /** Files whose checkpoint was recorded. A file can land without one; resume reads disk for that. */
  readonly written: readonly string[]
  readonly state: 'prepared' | 'done' | 'abandoned'
  readonly created: number
}
type IndexEntry = { readonly journal: SaveJournal } | { readonly corrupt: string }

interface Held {
  readonly expires: number
  readonly scope: 'project' | 'user'
  readonly root: string
  readonly identity: TreeIdentity
  readonly project: string | null
  readonly layout: ConfinedLayout
  readonly id: string
  readonly edits: readonly SaveEdit[]
  /** Dependencies checked again under the queue: a roster that moved since the preview refuses. */
  readonly check: () => Promise<readonly AuthoringIssue[]>
  /** The recorded transaction a resume finishes: its id and the exact transaction it previewed. */
  readonly resume: { readonly id: string; readonly tx: string } | null
}

/** The paths one scope may journal: nothing a record on disk names can point anywhere else. */
const JOURNAL_PATHS: Readonly<Record<'project' | 'user', RegExp>> = {
  project: /^(?:\.harnessdesk\/agents\/[a-z0-9][a-z0-9-]{0,47}\/AGENT\.md|\.harnessdesk\/flows\/[a-z0-9][a-z0-9_-]{0,63}\.ya?ml|\.harnessdesk\/triggers\.yml)$/,
  user: /^(?:agents\/[a-z0-9][a-z0-9-]{0,47}\/AGENT\.md|flows\/[a-z0-9][a-z0-9_-]{0,63}\.ya?ml)$/,
}

const journalOf = (raw: unknown, id: string): SaveJournal | { readonly tombstone: true } => {
  const value = raw as Partial<SaveJournal> | null
  if (!value || typeof value !== 'object' || value.version !== 1 || value.id !== id) throw new Error('invalid')
  if (value.state === 'abandoned' && value.edits === undefined) return { tombstone: true }
  const scope = value.scope
  if ((scope !== 'project' && scope !== 'user') || typeof value.root !== 'string' || !value.root.startsWith('/')
    || typeof value.tx !== 'string' || !value.tx || !Number.isSafeInteger(value.created)
    || !(value.state === 'prepared' || value.state === 'done' || value.state === 'abandoned')
    || !value.rootIdentity || typeof value.rootIdentity.dev !== 'string' || typeof value.rootIdentity.ino !== 'string'
    || (value.project !== null && typeof value.project !== 'string')
    || !Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 32 || !Array.isArray(value.written)) {
    throw new Error('invalid')
  }
  const paths = new Set<string>()
  for (const edit of value.edits as readonly Partial<SaveEdit>[]) {
    if (typeof edit.path !== 'string' || !JOURNAL_PATHS[scope].test(edit.path) || paths.has(edit.path)
      || (edit.before !== null && typeof edit.before !== 'string') || typeof edit.after !== 'string') throw new Error('invalid')
    paths.add(edit.path)
  }
  if (!value.written.every((path) => typeof path === 'string' && paths.has(path))) throw new Error('invalid')
  return value as SaveJournal
}

export class AuthoringPlane {
  readonly #options: AuthoringPlaneOptions
  readonly #journal: StateJournal
  readonly #now: () => number
  readonly #tokens = new Map<string, Held>()
  readonly #applied = new Map<string, { readonly at: number; readonly result: Promise<AuthoringSaveResult> }>()
  #index: Map<string, IndexEntry> | null = null
  #closed = false

  constructor(options: AuthoringPlaneOptions) {
    this.#options = options
    this.#journal = new StateJournal(options.journal, options.platform)
    this.#now = options.now ?? Date.now
  }

  // ------------------------------------------------------------------ places

  async #open(root: string, expect?: TreeIdentity): Promise<ConfinedTree> {
    return ConfinedTree.open(root, { ...(expect ? { expect } : {}), ...(this.#options.platform ? { platform: this.#options.platform } : {}) })
  }

  /** One name in one folder, refused when another entry differs from it only in letter case. */
  async #caseClean(tree: ConfinedTree, folder: string, name: string): Promise<readonly string[]> {
    let listed
    try {
      listed = await tree.list(folder, 1024)
    } catch (error) {
      if (NOTHING_HERE.has(errnoOf(error))) return []
      throw error
    }
    if (!listed) return []
    const folded = name.toLowerCase()
    const clash = listed.entries.find((entry) => entry.name !== name && entry.name.toLowerCase() === folded)
    if (clash) throw new Error(`"${folder ? `${folder}/` : ''}${clash.name}" differs from "${name}" only in letter case. Rename one of them before saving.`)
    return listed.entries.map((entry) => entry.name)
  }

  async #place(target: AuthoringTarget): Promise<Place> {
    const make = (scope: Scope, tree: ConfinedTree, project: string | null, layout: ConfinedLayout, rel: string): Place =>
      ({ scope, tree, project, layout, rel, writes: confinedWrites(tree, layout) })
    if (target.kind === 'triggers') {
      await this.#options.confine(target.root)
      const tree = await this.#open(target.root)
      await this.#caseClean(tree, '.harnessdesk', 'triggers.yml')
      return make('project', tree, tree.root, PROJECT_LAYOUT, TRIGGERS)
    }
    if (target.kind === 'agent') {
      if (!AGENT_ID.test(target.id)) throw new Error('Choose an Agent by its folder name: lowercase letters, digits and -.')
      if (target.origin === 'builtin') {
        const tree = await this.#open(this.#options.builtinAgents)
        return make('builtin', tree, null, { agents: '' }, `${target.id}/AGENT.md`)
      }
      if (target.origin === 'project') {
        if (!target.root) throw new Error('Choose the project this Agent belongs to.')
        await this.#options.confine(target.root)
        const tree = await this.#open(target.root)
        await this.#caseClean(tree, PROJECT_LAYOUT.agents, target.id)
        await this.#caseClean(tree, `${PROJECT_LAYOUT.agents}/${target.id}`, 'AGENT.md')
        return make('project', tree, tree.root, PROJECT_LAYOUT, `${PROJECT_LAYOUT.agents}/${target.id}/AGENT.md`)
      }
      if (target.root) await this.#options.confine(target.root)
      const tree = await this.#open(this.#options.home)
      await this.#caseClean(tree, USER_LAYOUT.agents, target.id)
      await this.#caseClean(tree, `${USER_LAYOUT.agents}/${target.id}`, 'AGENT.md')
      return make('user', tree, null, USER_LAYOUT, `${USER_LAYOUT.agents}/${target.id}/AGENT.md`)
    }
    if (!FLOW_ID.test(target.id)) throw new Error('Choose a flow by its file name: lowercase letters, digits, - and _.')
    await this.#options.confine(target.root)
    const [tree, folder, layout, scope, project] = target.origin === 'builtin'
      ? [await this.#open(this.#options.builtinFlows), '', { agents: '' }, 'builtin' as const, null]
      : target.origin === 'project'
        ? await this.#open(target.root).then((opened) => [opened, PROJECT_FLOWS, PROJECT_LAYOUT, 'project' as const, opened.root] as const)
        : [await this.#open(this.#options.home), USER_FLOWS, USER_LAYOUT, 'user' as const, null]
    const names = await this.#caseClean(tree, folder, `${target.id}.yml`)
    await this.#caseClean(tree, folder, `${target.id}.yaml`)
    const spelled = [`${target.id}.yml`, `${target.id}.yaml`].filter((name) => names.includes(name))
    if (spelled.length > 1) throw new Error('A flow id may be spelled by only one .yml or .yaml file. Remove one of them before saving.')
    const name = spelled[0] ?? `${target.id}.yml`
    return make(scope, tree, project, layout, folder ? `${folder}/${name}` : name)
  }

  // ------------------------------------------------------------------- reads

  async read(target: AuthoringTarget): Promise<AuthoringDocument> {
    const place = await this.#place(target)
    const limit = target.kind === 'agent' ? AGENT_FILE_LIMIT : target.kind === 'flow' ? FLOW_FILE_LIMIT : TRIGGER_FILE_LIMIT
    const source = await place.tree.read(place.rel, limit)
    if (source === null && target.kind !== 'triggers') {
      throw new Error(target.kind === 'agent' ? `There is no Agent called "${target.id}" here.` : `There is no flow called "${target.id}" here.`)
    }
    const text = source ?? ''
    const issues: AuthoringIssue[] = source === null ? [] : this.#documentIssues(target, place.scope, text, true)
    if (place.scope !== 'builtin') issues.push(...(await this.#unfinishedIssues(place.tree.root, [place.rel])))
    return {
      target,
      source: text,
      digest: source === null ? '' : digestOf(text),
      exists: source !== null,
      displayPath: place.rel,
      writable: place.scope !== 'builtin' && place.tree.writable,
      issues,
    }
  }

  /** What the owning parser says of a source, as issues; `reading` keeps what does not stop a save (a layout shortcut) as well. */
  #documentIssues(target: AuthoringTarget, scope: Scope, source: string, reading: boolean): AuthoringIssue[] {
    const issues: AuthoringIssue[] = []
    if (LONE_SURROGATE.test(source)) issues.push(issue('file', 'This text is not valid UTF-8.', 'Retype the damaged characters.'))
    if (target.kind === 'agent') {
      if (bytes(source) > AGENT_FILE_LIMIT) issues.push(issue('file', 'An Agent file is at most 256 KiB.', 'Shorten the brief.'))
      const parsed = parseAgentDefinition(source, target.id)
      for (const problem of parsed.problems) {
        if (problem.level === 'error') issues.push(issue(problem.at, problem.text, 'Correct this in the file, then save.'))
        else if (reading) issues.push(issue(problem.at, problem.text, 'Correct this in the file when you next edit it.'))
      }
      if (scope === 'project' && parsed.agent?.prefer.some((seat) => seat.model)) {
        issues.push(issue('prefer', 'A project’s Agent names runtimes only; the exact model is this Mac’s choice.', `${MODELS_STAY_HERE} Remove the model from prefer and choose it in this Mac’s seating.`))
      }
      return issues
    }
    if (target.kind === 'flow') {
      if (bytes(source) > FLOW_FILE_LIMIT) issues.push(issue('file', 'A flow file is at most 256 KiB.', 'Shorten the flow.'))
      const parsed = parseFlowPolicy(source)
      for (const problem of parsed.problems) {
        if (problem.level === 'error') issues.push(issue(problem.at, problem.text, 'Correct this in the flow, then save.'))
      }
      if (parsed.document?.format === 'legacy') {
        issues.push(issue('format', 'This flow uses the old format.', 'Update it from the project’s Flows list before editing it here.'))
      }
      if (parsed.document?.format === 'agents') {
        for (const role of parsed.document.flow.roles) {
          if (role.kind === 'check' && role.check.cwd && (role.check.cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(role.check.cwd))) {
            issues.push(issue(`roles.${role.id}.cwd`, 'A check runs in a folder of the project, never a path on one machine.', 'Write the folder relative to the project.'))
          }
        }
        if (reading) issues.push(...readShapeLayout(parsed.document.flow).issues)
      }
      return issues
    }
    for (const problem of parseTriggers(source).problems) issues.push(issue(problem.at, problem.text, problem.fix))
    return issues
  }

  /** Agents a flow names that are missing here, or — for this person's flow — that only a project has. */
  async #dependencyIssues(scope: 'project' | 'user', root: string, source: string, created: ReadonlySet<string>): Promise<AuthoringIssue[]> {
    const parsed = parseFlowPolicy(source)
    if (parsed.document?.format !== 'agents') return []
    const roster = await this.#options.agents(root)
    const byId = new Map(roster.map((entry) => [entry.id, entry]))
    const missing: string[] = []
    const projectOnly: string[] = []
    for (const role of parsed.document.flow.roles) {
      if (role.kind !== 'agent') continue
      for (const id of role.uses) {
        if (created.has(id)) continue
        const entry = byId.get(id)
        if (!entry?.definition) { if (!missing.includes(id)) missing.push(id); continue }
        const elsewhere = entry.origin !== 'project' || entry.shadows.some((shadow) => shadow.origin !== 'project')
        if (scope === 'user' && !elsewhere && !projectOnly.includes(id)) projectOnly.push(id)
      }
    }
    const issues: AuthoringIssue[] = []
    if (missing.length) issues.push(issue('roles', `This flow names ${missing.map((id) => `“${id}”`).join(', ')}, and there is no usable Agent by that name.`, 'Create or copy that Agent first, then save.'))
    if (projectOnly.length) issues.push(issue('roles', `This flow names ${projectOnly.map((id) => `“${id}”`).join(', ')}, which only this project has.`, `${COPY_AGENTS_FIRST} Then save this flow again.`))
    return issues
  }

  // ---------------------------------------------------------------- journals

  async #loadIndex(): Promise<Map<string, IndexEntry>> {
    if (this.#index) return this.#index
    const index = new Map<string, IndexEntry>()
    for (const name of await this.#journal.list(JOURNALS, 4096)) {
      const id = name.replace(/\.json$/, '')
      if (!/^[0-9a-f]{32}$/.test(id)) continue
      try {
        const text = await this.#journal.load(`${JOURNALS}/${name}`, JOURNAL_LIMIT)
        if (text === null) continue
        const read = journalOf(JSON.parse(text), id)
        if (!('tombstone' in read)) index.set(id, { journal: read })
      } catch {
        index.set(id, { corrupt: 'A record of an earlier save could not be read.' })
      }
    }
    this.#index = index
    return index
  }

  async #saveJournal(journal: SaveJournal): Promise<void> {
    await this.#journal.save(`${JOURNALS}/${journal.id}.json`, journal)
    ;(await this.#loadIndex()).set(journal.id, { journal })
  }

  /** Unfinished saves in the way of writing these files — and any unreadable record, which is in the way of every save. */
  async #unfinishedIssues(root: string, paths: readonly string[], except: string | null = null): Promise<AuthoringIssue[]> {
    const issues: AuthoringIssue[] = []
    for (const [id, entry] of await this.#loadIndex()) {
      if (id === except) continue
      if ('corrupt' in entry) {
        issues.push(issue('save', `${entry.corrupt} Nothing more is saved until it is looked at.`, 'Discard that record from the list of unfinished saves once you have checked the files.'))
        continue
      }
      const journal = entry.journal
      if (journal.state !== 'prepared' || journal.root !== root) continue
      if (journal.edits.some((edit) => paths.includes(edit.path))) issues.push(issue('save', UNFINISHED, UNFINISHED_FIX))
    }
    return issues
  }

  #journalId(scope: 'project' | 'user', root: string, rel: string): string {
    return createHash('sha256').update(`${scope}\0${root}\0${rel}`).digest('hex').slice(0, 32)
  }

  // ----------------------------------------------------------------- preview

  #mint(held: Held): string {
    if (this.#closed) throw new Error('HarnessDesk is closing, so nothing more is saved.')
    const token = randomUUID()
    this.#tokens.set(token, held)
    return token
  }

  async patch(target: Extract<WritableAuthoringTarget, { readonly kind: 'agent' }>, expected: string, edit: AgentFieldEdit): Promise<AuthoringSavePreview> {
    const refuse = (issues: readonly AuthoringIssue[]): AuthoringSavePreview => ({ token: null, edits: [], issues, resuming: false })
    if ((target.origin as string) === 'builtin') return refuse([issue('file', 'A built-in Agent is never changed.', 'Copy it to your project or your own Agents first.')])
    let place: Place
    let current: string | null
    try {
      place = await this.#place(target)
      current = await place.writes.read(place.rel)
    } catch (error) {
      return refuse([issue('file', sentenceOf(error), 'Open the file to check it.')])
    }
    if (current === null) return refuse([issue('file', 'This Agent’s file is not there any more.', 'Reload the Agent.')])
    if (digestOf(current) !== expected) return refuse([issue('file', CHANGED, 'Reload the Agent, then make this change again.')])
    const edited = editAgentSource(current, target.id, edit)
    if (edited.issues.length > 0) return refuse(edited.issues)
    return this.preview({ target, expected, source: edited.source })
  }

  async preview(input: AuthoringSaveInput): Promise<AuthoringSavePreview> {
    const target = input.target
    const refuse = (issues: readonly AuthoringIssue[], edits: readonly FlowFileEdit[] = []): AuthoringSavePreview => ({ token: null, edits, issues, resuming: false })
    if ((target.origin as string) === 'builtin') return refuse([issue('file', 'A built-in file is never changed.', 'Copy it to your project or your own files first.')])
    let place: Place
    let current: string | null
    try {
      place = await this.#place(target)
      current = await place.writes.read(place.rel)
    } catch (error) {
      return refuse([issue('file', sentenceOf(error), 'Open the folder to check it, then save again.')])
    }
    const scope = place.scope as 'project' | 'user'
    const issues: AuthoringIssue[] = []
    if (input.expected === null && current !== null) {
      issues.push(issue('file', 'A file is already there, and a new one never replaces it.', 'Reload it and edit that file instead, or choose another name.'))
    } else if (input.expected !== null && (current === null || digestOf(current) !== input.expected)) {
      issues.push(issue('file', CHANGED, 'Your text is kept in the editor. Reload the file, then save again.'))
    }
    if (current !== null && target.kind === 'flow' && parseFlowPolicy(current).document?.format === 'legacy') {
      issues.push(issue('format', 'This flow uses the old format.', 'Update it from the project’s Flows list before editing it here.'))
    }
    issues.push(...this.#documentIssues(target, scope, input.source, false))
    // New Agents the flow names: complete files, created in the same place, before the flow.
    const agentEdits: SaveEdit[] = []
    const created = new Set<string>()
    if (input.agents?.length) {
      if (target.kind !== 'flow') issues.push(issue('agents', 'Only a flow creates Agents as it is saved.', 'Create the Agent on its own.'))
      for (const agent of input.agents) {
        if (!AGENT_ID.test(agent.id) || created.has(agent.id)) {
          issues.push(issue(`agents.${agent.id}`, 'Each new Agent needs its own folder name.', 'Rename it with lowercase letters, digits and -.'))
          continue
        }
        created.add(agent.id)
        const rel = `${place.layout.agents}/${agent.id}/AGENT.md`
        try {
          await this.#caseClean(place.tree, place.layout.agents, agent.id)
          if (await place.writes.read(rel) !== null) {
            issues.push(issue(`agents.${agent.id}`, `There is already an Agent called “${agent.id}” here, and a new one never replaces it.`, 'Choose another name, or use the Agent that is there.'))
          }
        } catch (error) {
          issues.push(issue(`agents.${agent.id}`, sentenceOf(error), 'Choose another name.'))
        }
        issues.push(...this.#documentIssues({ kind: 'agent', origin: scope, id: agent.id }, scope, agent.source, false).map((one) => ({ ...one, at: `agents.${agent.id}.${one.at}` })))
        agentEdits.push({ path: rel, before: null, after: agent.source })
      }
    }
    const root = target.kind === 'agent' ? (target.root ?? place.project) : target.root
    const check = async (): Promise<readonly AuthoringIssue[]> =>
      target.kind === 'flow' && root ? this.#dependencyIssues(scope, place.project ?? root, input.source, created) : []
    issues.push(...(await check()))
    const edits: SaveEdit[] = [...agentEdits, { path: place.rel, before: current, after: input.source }]
    const display: FlowFileEdit[] = edits.map((edit) => ({ path: edit.path, before: edit.before, after: edit.after }))
    issues.push(...(await this.#unfinishedIssues(place.tree.root, edits.map((edit) => edit.path))))
    if (!place.tree.writable) issues.push(issue('file', 'HarnessDesk cannot change these files on this system.', 'Edit the file in another editor.'))
    if (issues.length === 0 && current === input.source && agentEdits.length === 0) {
      issues.push(issue('file', 'The file already holds exactly this text.', 'There is nothing to save.'))
    }
    if (issues.length > 0) return refuse(issues, display)
    const token = this.#mint({
      expires: this.#now() + TOKEN_LIFE,
      scope,
      root: place.tree.root,
      identity: place.tree.identity,
      project: place.project,
      layout: place.layout,
      id: this.#journalId(scope, place.tree.root, place.rel),
      edits,
      check,
      resume: null,
    })
    return { token, edits: display, issues: [], resuming: false }
  }

  // ------------------------------------------------------------------- apply

  /** The host is going: every preview token is dropped, so nothing more is applied. A save in flight finishes on its queue. */
  close(): void {
    this.#closed = true
    this.#tokens.clear()
  }

  apply(token: string): Promise<AuthoringSaveResult> {
    if (this.#closed) return Promise.resolve(EXPIRED)
    const now = this.#now()
    for (const [key, applied] of this.#applied) if (applied.at + TOKEN_LIFE < now) this.#applied.delete(key)
    const already = this.#applied.get(token)
    if (already) return already.result
    const held = this.#tokens.get(token)
    this.#tokens.delete(token)
    if (!held || held.expires < now) return Promise.resolve(EXPIRED)
    const result = this.#apply(held)
    this.#applied.set(token, { at: now, result })
    return result
  }

  async #apply(held: Held): Promise<AuthoringSaveResult> {
    let tree: ConfinedTree
    try {
      if (held.project) await this.#options.confine(held.project)
      tree = await this.#open(held.root, held.identity)
    } catch {
      return { state: 'refused', written: [], message: 'The folder changed after the preview. Preview the save again.' }
    }
    if (tree.root !== held.root) return EXPIRED
    const writes = confinedWrites(tree, held.layout)
    const hooks = this.#options.hooks ?? {}
    let journal: SaveJournal | null = null
    let resumed: SaveJournal | null = null
    const port: SavePort = {
      serialize: (run) => this.#options.queue.run(tree.root, run, hooks.queued),
      verify: async (edits) => {
        const blocking = await this.#unfinishedIssues(tree.root, edits.map((edit) => edit.path), held.resume?.id ?? null)
        if (blocking.length) throw new Error(`${blocking[0]!.text} ${blocking[0]!.fix}`)
        if (held.resume) {
          const entry = (await this.#loadIndex()).get(held.resume.id)
          if (!entry || 'corrupt' in entry || entry.journal.state !== 'prepared' || entry.journal.tx !== held.resume.tx) throw new Error(EXPIRED.message)
          resumed = entry.journal
        }
        for (const edit of edits) {
          const current = await writes.read(edit.path)
          // Resuming reads disk: a file that already holds what this save meant to write is taken as landed.
          if (current !== edit.before && !(resumed && current === edit.after)) throw new Error(CHANGED)
        }
        const problems = await held.check()
        if (problems.length) throw new Error(`${problems[0]!.text} ${problems[0]!.fix}`)
        if (!tree.writable) throw new Error('HarnessDesk cannot change these files on this system, so nothing was written.')
        await hooks.verified?.()
      },
      prepare: async (edits) => {
        journal = resumed ?? {
          version: 1, id: held.id, tx: randomUUID(), scope: held.scope, root: tree.root, project: held.project,
          rootIdentity: tree.identity, edits, written: [], state: 'prepared', created: this.#now(),
        }
        if (!resumed) await this.#saveJournal(journal)
        await hooks.prepared?.()
      },
      write: async (edit) => {
        await hooks.beforeWrite?.(edit.path)
        const current = await writes.read(edit.path)
        if (current !== edit.after) {
          if (edit.before === null) await writes.create(edit.path, edit.after)
          else await writes.replace(edit.path, edit.before, edit.after)
        }
        await hooks.afterWrite?.(edit.path)
      },
      recorded: async (path) => {
        await hooks.recorded?.(path)
        const now: SaveJournal = journal!
        journal = { ...now, written: [...new Set([...now.written, path])] }
        await this.#saveJournal(journal)
      },
      finish: async () => {
        journal = { ...journal!, state: 'done' }
        await this.#saveJournal(journal)
      },
    }
    let outcome
    try {
      outcome = await applySave(port, held.edits)
    } catch (error) {
      outcome = { state: 'refused' as const, written: [] as string[], message: sentenceOf(error) }
    }
    const message = sentenceOf(new Error(outcome.message))
    const wrote = outcome.written.length > 0 || (resumed !== null && (resumed as SaveJournal).written.length > 0)
    if (wrote) {
      this.#options.changed?.({
        scope: held.scope,
        root: held.project,
        agents: held.edits.some((edit) => edit.path.endsWith('/AGENT.md')),
      })
    }
    if (outcome.state === 'applied') return { state: 'applied', written: outcome.written, message: 'Saved.' }
    const open = journal as SaveJournal | null
    if (open && outcome.state === 'refused' && !resumed) {
      // Nothing is known to have landed: if every file still holds its previewed bytes, the record is dropped; if any cannot be read, it stays.
      const untouched = await Promise.all(held.edits.map(async (edit) => (await writes.read(edit.path).catch(() => undefined)) === edit.before))
      if (untouched.every(Boolean)) await this.#saveJournal({ ...open, state: 'abandoned' }).catch(() => {})
      else return { state: 'refused', written: [], message: `${message} This save may have written part of a file; it is listed with the unfinished saves to check and resume.` }
    }
    if (outcome.state === 'partial' || (resumed && outcome.state === 'refused')) {
      return {
        state: outcome.written.length ? 'partial' : 'refused',
        written: outcome.written,
        message: `${outcome.written.length} of ${held.edits.length} files were saved before this stopped: ${message} The rest were not written. Check them, then resume this save from the list of unfinished saves.`,
      }
    }
    return { state: 'refused', written: [], message }
  }

  // ---------------------------------------------------------------- recovery

  async pending(): Promise<readonly AuthoringPending[]> {
    const out: AuthoringPending[] = []
    for (const [id, entry] of await this.#loadIndex()) {
      if ('corrupt' in entry) {
        out.push({ id, scope: 'user', root: null, files: [], written: [], message: `${entry.corrupt} Check your Agents and flows by hand, then discard it.` })
        continue
      }
      const journal = entry.journal
      if (journal.state !== 'prepared') continue
      out.push({
        id,
        scope: journal.scope,
        root: journal.project,
        files: journal.edits.map((edit) => edit.path),
        written: journal.written,
        message: journal.written.length
          ? `${journal.written.length} of ${journal.edits.length} files were saved before this stopped. Resume to check each file and write what is missing.`
          : 'This save stopped before any file was known to be written. Resume to check each file and write what is missing.',
      })
    }
    return out
  }

  /** A recorded save, previewed again from disk. A file that holds neither its old bytes nor its new ones refuses. */
  async resume(id: string): Promise<AuthoringSavePreview> {
    const refuse = (text: string, fix: string, edits: readonly FlowFileEdit[] = []): AuthoringSavePreview =>
      ({ token: null, edits, issues: [issue('save', text, fix)], resuming: true })
    const entry = (await this.#loadIndex()).get(id)
    if (!entry || 'corrupt' in entry || entry.journal.state !== 'prepared') return refuse('There is no unfinished save by that name.', 'Reload the list of unfinished saves.')
    const journal = entry.journal
    const display = journal.edits.map((edit) => ({ path: edit.path, before: edit.before, after: edit.after }))
    let tree: ConfinedTree
    try {
      if (journal.project) await this.#options.confine(journal.project)
      tree = await this.#open(journal.root, journal.rootIdentity)
    } catch {
      return refuse('The folder this save was writing into changed.', 'Check the files by hand, then discard this record.', display)
    }
    const writes = confinedWrites(tree, journal.scope === 'project' ? PROJECT_LAYOUT : USER_LAYOUT)
    for (const edit of journal.edits) {
      let current: string | null
      try { current = await writes.read(edit.path) } catch (error) { return refuse(sentenceOf(error), 'Check that file by hand, then discard this record.', display) }
      if (current !== edit.before && current !== edit.after) {
        return refuse(`"${edit.path}" changed since this save began.`, 'Check that file by hand, then discard this record.', display)
      }
    }
    const token = this.#mint({
      expires: this.#now() + TOKEN_LIFE,
      scope: journal.scope,
      root: journal.root,
      identity: journal.rootIdentity,
      project: journal.project,
      layout: journal.scope === 'project' ? PROJECT_LAYOUT : USER_LAYOUT,
      id,
      edits: journal.edits,
      check: async () => [],
      resume: { id, tx: journal.tx },
    })
    return { token, edits: display, issues: [], resuming: true }
  }

  // -------------------------------------------------------------- rendering

  /**
   * A shape's exact, host-normalized YAML for one policy — what the ordered
   * editor and its graph both show as "the file", so neither can drift from
   * what a save would actually write. Never throws: a policy that would not
   * read back exactly as itself (`writeShape`'s own round-trip check) comes
   * back as an issue, with the source empty rather than a guess at one.
   */
  async renderShape(policy: FlowPolicy): Promise<{ readonly source: string; readonly issues: readonly AuthoringIssue[] }> {
    try {
      return { source: writeShape(policy), issues: [] }
    } catch (error) {
      return { source: '', issues: [issue('file', error instanceof Error ? error.message : String(error), 'Change the value that could not be written exactly.')] }
    }
  }

  /**
   * A brand-new trigger's phase-8 defaults, from its own parser. Drafts only:
   * nothing is written, and this alone arms nothing.
   */
  async triggerDraft(input: { readonly id: string; readonly on: TriggerSource; readonly opens: TriggerDefinition['opens'] }): Promise<TriggerDefinition> {
    return draftTrigger(input.id, input.on, input.opens)
  }

  /**
   * Every trigger's exact, host-normalized YAML, `parseTriggers`-checked
   * before it is offered — a save away from disk, and an explicit, committed
   * Arm away from running. Never throws; a definition that would not read
   * back exactly comes back as an issue.
   */
  async renderTriggers(definitions: readonly TriggerDefinition[]): Promise<{ readonly source: string; readonly issues: readonly AuthoringIssue[] }> {
    try {
      return { source: writeTriggers(definitions), issues: [] }
    } catch (error) {
      return { source: '', issues: [issue('file', error instanceof Error ? error.message : String(error), 'Correct the trigger that could not be written exactly.')] }
    }
  }

  /** Drops the record of an unfinished save; every file stays exactly as it is. */
  async discard(id: string): Promise<readonly AuthoringPending[]> {
    const index = await this.#loadIndex()
    const entry = index.get(id)
    if (entry) {
      if ('corrupt' in entry) {
        await this.#journal.save(`${JOURNALS}/${id}.json`, { version: 1, id, state: 'abandoned' })
        index.delete(id)
      } else if (entry.journal.state === 'prepared') {
        await this.#saveJournal({ ...entry.journal, state: 'abandoned' })
      }
    }
    return this.pending()
  }
}
