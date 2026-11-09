import { firstAsk, sessionLabel, isLeadMessageSource, LEAD_MESSAGE_PREFIX, leadMessageKey, leadMessageWords, splitContextContent, wrapContext, type LeadChatControl } from '@harnessdesk/protocol'
import { basename, isAbsolute, relative } from 'node:path'
import type {
  AgentItem, Approval, ApprovalOption, CommandItem, FileChange, PhoneApprovalState, PhoneDiffLine, PhoneDiffHunk, PhoneWorkFileChange, PhoneWorkStep, PhoneWorkThread, PhoneWorkTurn,
  PlanStep, Session, Turn, UserContent,
} from '@harnessdesk/protocol'
import { commandForApproval, commandTitle, projectPath, scrub, scrubText, scrubProjectText } from './phone-redact.js'

/**
 * A conversation as a paired phone reads it. Like the rest of what the phone sees it is built field by field and
 * then redacted. Bounded, scrubbed command tails and diff hunks reach the paired phone; absolute paths are
 * rewritten to project paths. What it keeps is what a person would say about the work, which
 * is the point of reading it on a phone: what was asked, what the agent answered, what it did, and what it is
 * waiting to be allowed.
 */

/** Trusted in-process completeness information; never serialized on the phone wire. */
export interface ThreadProjection { readonly omittedSourceTurns: number; readonly truncated: boolean }
const projectionKey = Symbol('phone-thread-projection')
export const threadProjection = (thread: PhoneWorkThread): ThreadProjection | undefined =>
  (thread as PhoneWorkThread & { readonly [projectionKey]?: ThreadProjection })[projectionKey]

export type PhoneApprovalTurn = Extract<PhoneWorkTurn, { type: 'approval' }>

/** The most turns of a conversation the phone is sent; the earlier ones stay on the desk. */
const RECENT_TURNS = 40
/** The most steps shown under one "worked for" fold. */
const FOLD_STEPS = 40
const NO_SECRET = (): boolean => false

export interface ThreadContext {
  /** The person's home folder, said as `~` in a command; null where unknown. */
  readonly home: string | null
  /** The agent's presentation name. */
  readonly seat: string
  /** Whether a piece of text could hold a secret, which then is not shown. */
  readonly hasSecret?: (text: string) => boolean
}

// ------------------------------------------------------------------- approvals

/** What the desk decided a pending approval is, for the phone to show and for `decide` to act on. */
export interface Assessment {
  readonly turn: PhoneApprovalTurn
  /** The approval's own buttons the phone may press, by what each one does. */
  readonly options: { readonly once?: ApprovalOption; readonly session?: ApprovalOption; readonly deny?: ApprovalOption }
  /** False when a person could not read the whole request on a phone, so a phone cannot allow it. */
  readonly readable: boolean
}

/** Programs that only read, or that run a project's own checks. Anything else is not low risk. */
const READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'grep', 'rg', 'tree', 'stat', 'file', 'which'])
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PROJECT_CHECKS = new Set(['test', 'lint', 'build', 'typecheck', 'check'])
const FIND_WRITES = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
/** Shell syntax that chains, redirects, substitutes or backgrounds: the command is then more than its first word says. */
const SHELL_SYNTAX = /[<>`$&|;\n\r(){}\\!]/
/** Where a change is code that runs later, or holds a credential. */
const SENSITIVE_PATH = /(^|[/:=])(\.git|\.env[^/]*|\.ssh|\.aws|\.github|\.husky|\.npmrc|\.netrc)(\/|$)/

/**
 * Whether a command is one a person can wave through from a phone. The desk keeps no notion of risk, so this is the
 * phone's own and it errs the other way from an allow list in a window: a command is high risk unless it is known to
 * be a read or a project's own check, run plain, and touching nothing outside the project or in a place that holds
 * credentials or runs code later. A high risk command can still be allowed from the phone, once, but only behind the
 * phone's Face ID, and never "until the session ends".
 */
export const isLowRiskCommand = (command: string, cwd: string | null | undefined): boolean => {
  const text = command.trim()
  if (text === '' || SHELL_SYNTAX.test(text)) return false
  const words = text.split(/\s+/)
  const [program = '', sub = ''] = words
  if (!words.slice(1).every(word => wordStaysInProject(word, cwd))) return false
  if (READERS.has(program)) {
    if (program === 'rg' && words.some(word => word.startsWith('--pre'))) return false
    if (program === 'tree' && words.includes('-o')) return false
    return true
  }
  if (program === 'find') return !words.some(word => FIND_WRITES.has(word))
  if (program === 'git') return GIT_READS.has(sub) && !words.some(word => word.startsWith('--output'))
  if (PACKAGE_MANAGERS.has(program)) {
    const script = sub === 'run' ? words[2] ?? '' : sub
    return PROJECT_CHECKS.has(script) && !words.some(word => /^--(?:script-shell|userconfig|registry)\b/.test(word))
  }
  if (program === 'cargo') return ['test', 'check', 'build', 'clippy'].includes(sub)
  if (program === 'go') return ['test', 'build', 'vet'].includes(sub)
  if (program === 'pytest') return true
  if (program === 'tsc') return words.includes('--noEmit')
  return false
}

/** An argument that names nothing outside the project, and nothing that holds a credential or runs later. */
const wordStaysInProject = (word: string, cwd: string | null | undefined): boolean => {
  const bare = word.replace(/^["']|["']$/g, '')
  if (SENSITIVE_PATH.test(bare.split('\\').join('/'))) return false
  if (bare.startsWith('~') || bare.split(/[\\/]/).includes('..')) return false
  return !isAbsolute(bare) || insideProject(bare, cwd)
}

const insideProject = (path: string, cwd: string | null | undefined): boolean => {
  if (!cwd) return false
  if (isAbsolute(path)) {
    const inside = relative(cwd, path)
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
  }
  return !path.split(/[\\/]/).includes('..')
}

const changeIsLowRisk = (change: FileChange, cwd: string | null | undefined): boolean => {
  if (change.kind.type === 'delete') return false
  const paths = [change.path, ...(change.kind.type === 'update' && change.kind.movePath ? [change.kind.movePath] : [])]
  return paths.every(path => insideProject(path, cwd) && !SENSITIVE_PATH.test(path.split('\\').join('/')))
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

/**
 * One pending approval as the phone draws it, and the buttons it may press. Null for an approval a phone cannot
 * answer at all (a structured question), which the thread says in a sentence instead.
 */
export const assessApproval = (approval: Approval, cwd: string | null | undefined, context: ThreadContext, state: PhoneApprovalState = 'pending'): Assessment | null => {
  if (approval.type === 'userInput' || approval.type === 'elicitation') return null
  const hasSecret = context.hasSecret ?? NO_SECRET
  const options = approval.options
  const once = options.find(option => option.intent === 'approve' && !option.grant)
  const sessions = options.filter(option => option.intent === 'approveAlways' && (option.grant === 'session-tool' || option.grant === 'session-server'))
  const session = sessions.find(option => option.grant === 'session-tool') ?? sessions[0]
  const deny = options.find(option => option.intent === 'deny') ?? options.find(option => option.intent === 'cancel')
  let why = scrub(approval.reason ?? '', 200)

  let title: string, command: string, highRisk: boolean, readable = true
  if (approval.type === 'command' && approval.kind !== 'stdin') {
    const view = commandForApproval(approval.command, approval.cwd, context.home, hasSecret)
    title = 'Run a command'
    readable = view.whole
    command = view.whole ? view.text : view.text === '' ? 'Hidden: it may hold a secret. Review it on the desk.' : `${view.text}\n(cut short: review it on the desk)`
    highRisk = !view.whole || !isLowRiskCommand(approval.command, approval.cwd)
  } else if (approval.type === 'command') {
    // Typing into a program that is already running: what is typed may be a password, and is never shown.
    title = 'Type into a running command'
    readable = false
    command = `${commandTitle(approval.command)} (what is typed is hidden)`
    highRisk = true
  } else if (approval.type === 'fileChange') {
    const lines = approval.changes.slice(0, 6).map(change => {
      const verb = change.kind.type === 'add' ? 'add' : change.kind.type === 'delete' ? 'delete' : 'edit'
      return `${verb} ${projectPath(change.path, cwd)}`
    })
    title = `Change ${plural(approval.changes.length, 'file')}`
    command = [...lines, ...(approval.changes.length > lines.length ? [`and ${approval.changes.length - lines.length} more`] : [])].join('\n')
    highRisk = !!approval.grantRoot || approval.changes.length === 0 || !approval.changes.every(change => changeIsLowRisk(change, cwd))
  } else {
    title = 'Change what the agent may do'
    command = scrub(approval.summary, 300)
    highRisk = true
  }

  if (approval.extraGrants?.length) {
    readable = false
    highRisk = true
    why = 'Extra permissions need review on the desk.'
  }

  return {
    readable,
    options: { ...(once ? { once } : {}), ...(session ? { session } : {}), ...(deny ? { deny } : {}) },
    turn: {
      type: 'approval', id: String(approval.id), title, who: context.seat, command, why, highRisk, state,
      // Offered only where it is safe and the desk has the option: never for a high risk request.
      ...(!highRisk && readable && session ? { sessionGrant: scrub(session.label, 80) || 'Allow for this session' } : {}),
    },
  }
}

// --------------------------------------------------------------------- the work

const TEXT_STEP_TITLE = 100

const seconds = (item: { durationMs?: number }): number | undefined =>
  item.durationMs === undefined ? undefined : Math.max(0, Math.round(item.durationMs / 1000))

const isUnifiedDeletion = (diff: string): boolean => /^(?:(?:diff --git |deleted file mode |index |--- |\+\+\+ )[^\n]*\n)*@@ -\d+(?:,\d+)? \+0(?:,0)? @@(?: |\r?(?:\n|$))/.test(diff)
const contentLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g)?.map(line => line.replace(/\r?\n$/, '').replace(/\r$/, '')) ?? []

const countLines = (diff: string, kind: FileChange['kind']): { added: number; removed: number } => {
  if (kind.type === 'add' || kind.type === 'delete' && !isUnifiedDeletion(diff)) {
    const lines = contentLines(diff).length
    return kind.type === 'add' ? { added: lines, removed: 0 } : { added: 0, removed: lines }
  }
  let added = 0, removed = 0, inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue }
    if (line.startsWith('diff --git ')) { inHunk = false; continue }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

const step = (id: string, kind: PhoneWorkStep['kind'], title: string, rest: Partial<PhoneWorkStep> = {}): PhoneWorkStep => ({
  id, kind, title, files: [], failed: false, output: [], todos: [], ...rest,
})

const boundedLine = (text: string, cwd: string, noteTruncated: () => void): string => {
  const whole = scrubProjectText(text, cwd, Infinity)
  const shown = scrubProjectText(text, cwd, 300)
  if (shown !== whole) noteTruncated()
  return shown
}

const outputTail = (output: string, cwd: string, noteTruncated: () => void): string[] => {
  if (!output) return []
  const lines = output.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (lines.length > 40) noteTruncated()
  const shown: string[] = []
  let bytes = 2 // JSON array brackets
  for (const line of lines.slice(-40).reverse()) {
    const text = boundedLine(line, cwd, noteTruncated)
    const size = Buffer.byteLength(JSON.stringify(text), 'utf8') + (shown.length ? 1 : 0)
    if (bytes + size > 8192) { noteTruncated(); break }
    bytes += size
    shown.push(text)
  }
  return shown.reverse()
}

const commandStep = (item: CommandItem, cwd: string, noteTruncated: () => void): PhoneWorkStep => {
  const action = item.actions[0]
  const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
  const common: Partial<PhoneWorkStep> = {
    failed, ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}), ...(seconds(item) !== undefined ? { seconds: seconds(item)! } : {}),
  }
  if (action?.type === 'read') return step(String(item.id), 'read', `Read ${scrub(action.name, 60) || 'a file'}`, { ...common, files: [projectPath(action.path, cwd)] })
  if (action?.type === 'listFiles') return step(String(item.id), 'read', 'Listed files', common)
  if (action?.type === 'search') return step(String(item.id), 'search', 'Searched the code', common)
  return step(String(item.id), 'run', commandTitle(item.command), { ...common, output: outputTail(item.output ?? '', cwd, noteTruncated) })
}

const stepOf = (item: AgentItem, cwd: string, noteTruncated: () => void): PhoneWorkStep | null => {
  const id = String(item.id)
  switch (item.type) {
    case 'command': return commandStep(item, cwd, noteTruncated)
    case 'fileChange': {
      const merged = mergeChanges(item.changes, cwd)
      const added = merged.reduce((sum, file) => sum + file.added, 0), removed = merged.reduce((sum, file) => sum + file.removed, 0)
      return step(id, 'edit', merged.length === 1 ? `Edited ${basename(merged[0]!.path)}` : `Edited ${plural(merged.length, 'file')}`, {
        files: merged.map(file => file.path), added, removed, failed: item.status === 'failed', ...(seconds(item) !== undefined ? { seconds: seconds(item)! } : {}),
      })
    }
    case 'toolCall': return step(id, 'run', item.source.kind === 'mcp' ? `Used ${scrub(item.source.server, 40) || 'a tool'}` : 'Used a tool', {
      failed: item.status === 'failed' || !!item.error, ...(seconds(item) !== undefined ? { seconds: seconds(item)! } : {}),
    })
    case 'subagent': {
      const title = { spawn: 'Started a helper agent', send: 'Messaged a helper agent', wait: 'Waited for a helper agent', cancel: 'Stopped a helper agent' }[item.action] ?? 'Worked with a helper agent'
      return step(id, 'agent', title, { failed: item.status === 'failed' })
    }
    case 'webSearch': return step(id, 'search', 'Searched the web', { detail: scrub(item.query, 100), failed: item.status === 'failed' })
    case 'plan': return step(id, 'todo', 'Wrote a plan', { detail: scrubText(item.text, 600) })
    case 'image': return step(id, 'read', item.generated ? 'Made an image' : 'Looked at an image')
    case 'reasoning': return step(id, 'thought', scrub(item.summary[0] ?? '', TEXT_STEP_TITLE) || 'Thinking')
    case 'assistantMessage': return item.phase === 'commentary' ? step(id, 'thought', scrub(item.text, TEXT_STEP_TITLE) || 'Thinking') : null
    case 'publication': {
      const what = { pullRequest: 'a pull request', issue: 'an issue', review: 'a review', comment: 'a comment', branch: 'a branch' }[item.reference.kind]
      const verb = { opened: 'Opened', updated: 'Updated', posted: 'Posted', merged: 'Merged' }[item.reference.action ?? 'opened'] ?? 'Looked at'
      return step(id, 'run', item.reference.action ? `${verb} ${what}` : `Looked at ${what}`)
    }
    default: return null
  }
}

const mergeChanges = (changes: readonly FileChange[], cwd: string): { path: string; added: number; removed: number }[] => {
  const byPath = new Map<string, { path: string; added: number; removed: number }>()
  for (const change of changes) {
    const path = projectPath(change.path, cwd)
    const counted = countLines(change.diff, change.kind)
    const known = byPath.get(path)
    if (known) { known.added += counted.added; known.removed += counted.removed } else byPath.set(path, { path, ...counted })
  }
  return [...byPath.values()]
}

/** Parse only unified hunks; binary notices and absent diffs have no readable lines. */
const changesWithHunks = (changes: readonly FileChange[], cwd: string, noteTruncated: () => void): PhoneWorkFileChange[] => {
  const files = mergeChanges(changes, cwd).map(file => ({ ...file, hunks: [] as { header: string; lines: PhoneDiffLine[] }[] }))
  const byPath = new Map(files.map(file => [file.path, file]))
  const counts = new Map<string, number>()
  let total = 0
  for (const change of changes) {
    const file = byPath.get(projectPath(change.path, cwd))!
    let hunk: { header: string; lines: PhoneDiffLine[] } | undefined
    let old = 0, next = 0, oldLeft = 0, nextLeft = 0
    if (change.diff.includes('\0') || /^(?:Binary files |GIT binary patch)/.test(change.diff)) continue
    // Whole-file additions and deletions carry raw content; unified payloads keep their own numbering.
    const content = change.diff !== '' && (change.kind.type === 'add' || change.kind.type === 'delete' && !isUnifiedDeletion(change.diff)) ? contentLines(change.diff) : undefined
    const removing = change.kind.type === 'delete'
    const diff = content ? `${removing ? `@@ -1,${content.length} +0,0 @@` : `@@ -0,0 +1,${content.length} @@`}\n${content.map(line => `${removing ? '-' : '+'}${line}`).join('\n')}` : change.diff
    const lines = diff.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.replace(/\r$/, '')
      if (line === '' && index === lines.length - 1) break
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (header) {
        old = Number(header[1]); next = Number(header[3])
        oldLeft = Number(header[2] ?? 1); nextLeft = Number(header[4] ?? 1)
        hunk = { header: boundedLine(line, cwd, noteTruncated), lines: [] }
        continue
      }
      if (!hunk || (oldLeft === 0 && nextLeft === 0)) continue
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : line[0] === ' ' || line === '' ? 'context' : null
      if (!kind) continue
      if ((kind !== 'add' && oldLeft <= 0) || (kind !== 'remove' && nextLeft <= 0)) { hunk = undefined; continue }
      const number = kind === 'remove' ? old : next
      if (kind !== 'add') { old++; oldLeft-- }
      if (kind !== 'remove') { next++; nextLeft-- }
      if ((counts.get(file.path) ?? 0) >= 400 || total >= 1500) { noteTruncated(); continue }
      if (hunk.lines.length === 0) file.hunks.push(hunk)
      hunk.lines.push({ kind, number, text: boundedLine(line.slice(1), cwd, noteTruncated) })
      counts.set(file.path, (counts.get(file.path) ?? 0) + 1)
      total++
    }
  }
  return files
}

const summaryOf = (steps: readonly PhoneWorkStep[]): string => {
  const count = (kind: PhoneWorkStep['kind']): number => steps.filter(one => one.kind === kind).length
  const edited = new Set(steps.filter(one => one.kind === 'edit').flatMap(one => one.files)).size
  const parts = [
    count('run') > 0 ? `ran ${plural(count('run'), 'command')}` : '',
    edited > 0 ? `edited ${plural(edited, 'file')}` : '',
    count('read') > 0 ? `read ${plural(count('read'), 'file')}` : '',
    count('search') > 0 ? `searched ${count('search') === 1 ? 'once' : `${count('search')} times`}` : '',
  ].filter(Boolean)
  const text = parts.join(', ')
  return text === '' ? 'Worked' : `${text[0]!.toUpperCase()}${text.slice(1)}`
}

const planStep = (turn: Turn): PhoneWorkStep | null => {
  const plan: readonly PlanStep[] = turn.plan ?? []
  return plan.length === 0 ? null : step(`${turn.id}:plan`, 'todo', 'Plan', {
    todos: plan.slice(0, 20).map(one => ({ text: scrub(one.step, 120), done: one.status === 'completed', active: one.status === 'inProgress' })),
  })
}

const youOf = (item: Extract<AgentItem, { type: 'userMessage' }>, noteTruncated: () => void, sent: ReadonlySet<string>, chatId: string): PhoneWorkTurn | null => {
  const split = splitContextContent(item.content)
  const verified = split.injections.filter(block => isLeadMessageSource(block.label) && sent.has(leadMessageKey(chatId, wrapContext(block.label, block.text))))
  const source = verified.length ? [
    ...verified.map(block => leadMessageWords(block.text)),
    split.text,
  ].filter(Boolean).join('\n') : split.text
  const text = scrubText(source)
  if (text !== scrubText(source, Infinity)) noteTruncated()
  const attachments = item.content.flatMap((part: UserContent) => {
    if (part.type === 'image') return [scrub(part.name ?? 'Image', 60) || 'Image']
    if (part.type === 'localImage') return [scrub(basename(part.path), 60) || 'Image']
    return []
  })
  return text === '' && attachments.length === 0 ? null : { type: 'you', id: String(item.id), text, attachments, ...(verified.length === 1 && split.text === '' && attachments.length === 0 ? { lead: { name: scrub(verified[0]!.label.slice(LEAD_MESSAGE_PREFIX.length), 60) } } : {}) }
}

interface Timed { readonly id: string; readonly startedAt?: number; readonly completedAt?: number; readonly durationMs?: number }

const turnsOf = (turn: Turn, cwd: string, noteTruncated: () => void, sent: ReadonlySet<string>, chatId: string): PhoneWorkTurn[] => {
  const turns: PhoneWorkTurn[] = []
  // `silent` is whether the last step is reasoning with nothing to read, so a run of them shows as one Thinking row, as the desk folds them.
  let fold: { id: string; steps: PhoneWorkStep[]; from: number; to: number; spent: number; silent: boolean } | null = null
  // The turn's plan sits at the end of its first fold of work, or on its own where it did none.
  let plan = planStep(turn)
  const close = (): void => {
    if (!fold) return
    if (plan) { fold.steps.push(plan); plan = null }
    const shown = fold.steps.slice(-FOLD_STEPS)
    if (shown.length < fold.steps.length) noteTruncated()
    const wall = fold.to > fold.from ? Math.round((fold.to - fold.from) / 1000) : 0
    turns.push({ type: 'work', id: `${fold.id}:work`, seconds: wall || fold.spent, summary: summaryOf(fold.steps), steps: shown })
    fold = null
  }
  const into = (item: Timed, one: PhoneWorkStep, silent = false): void => {
    fold ??= { id: item.id, steps: [], from: Infinity, to: 0, spent: 0, silent: false }
    if (!(silent && fold.silent)) fold.steps.push(one)
    fold.silent = silent
    if (item.startedAt !== undefined) fold.from = Math.min(fold.from, item.startedAt)
    const end = item.completedAt ?? (item.startedAt !== undefined && item.durationMs !== undefined ? item.startedAt + item.durationMs : undefined)
    if (end !== undefined) fold.to = Math.max(fold.to, end)
    fold.spent += Math.round((item.durationMs ?? 0) / 1000)
  }
  for (const item of turn.items) {
    if (item.type === 'userMessage') { close(); const you = youOf(item, noteTruncated, sent, chatId); if (you) turns.push(you); continue }
    if (item.type === 'assistantMessage' && item.phase !== 'commentary') {
      close()
      const markdown = scrubText(item.text)
      if (markdown !== scrubText(item.text, Infinity)) noteTruncated()
      if (markdown !== '') turns.push({ type: 'agent', id: String(item.id), markdown })
      continue
    }
    if (item.type === 'error') { close(); turns.push({ type: 'agent', id: String(item.id), markdown: `Something went wrong: ${scrub(item.message, 300)}` }); continue }
    const one = stepOf(item, cwd, noteTruncated)
    // The same rule that names the step Thinking.
    const silent = item.type === 'reasoning' && scrub(item.summary[0] ?? '', TEXT_STEP_TITLE) === ''
    if (one) into({ id: String(item.id), startedAt: item.startedAt, completedAt: item.completedAt, durationMs: item.durationMs }, one, silent)
  }
  close()
  if (plan) { into({ id: `${turn.id}:plan` }, plan); close() }

  // What the turn changed, once, at its end: the files by their project path and the size of each change.
  const files = changesWithHunks(turn.items.flatMap(item => item.type === 'fileChange' && item.status !== 'failed' && item.status !== 'declined' ? item.changes : []), cwd, noteTruncated)
  if (files.length > 0) turns.push({ type: 'changes', id: `${turn.id}:changes`, files })
  return turns
}

/** Leave room below the relay's 1 MiB encrypted-frame ceiling, including wire framing. */
const THREAD_BYTES = 512 * 1024
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const fitChanges = (turn: Extract<PhoneWorkTurn, { type: 'changes' }>, budget: number): PhoneWorkTurn | null => {
  const files = turn.files.map(file => ({ ...file, hunks: [] as PhoneDiffHunk[] }))
  let bytes = jsonBytes({ ...turn, files })
  if (bytes > budget) return null
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!
    for (const hunk of turn.files[i]!.hunks) {
      const lines: PhoneDiffLine[] = []
      const headerBytes = jsonBytes({ header: hunk.header, lines }) + (file.hunks.length ? 1 : 0)
      for (const line of hunk.lines) {
        const cost = jsonBytes(line) + (lines.length ? 1 : headerBytes)
        if (bytes + cost > budget) return { ...turn, files }
        if (!lines.length) file.hunks.push({ header: hunk.header, lines })
        lines.push(line)
        bytes += cost
      }
    }
  }
  return { ...turn, files }
}

const boundThread = (thread: PhoneWorkThread, noteTruncated: () => void): PhoneWorkThread => {
  const shown: PhoneWorkTurn[] = []
  let budget = THREAD_BYTES - jsonBytes({ ...thread, turns: [] })
  for (const turn of [...thread.turns].reverse()) {
    const bytes = jsonBytes(turn) + (shown.length ? 1 : 0)
    if (bytes <= budget) { shown.push(turn); budget -= bytes; continue }
    noteTruncated()
    if (turn.type === 'changes') {
      const fitted = fitChanges(turn, budget - (shown.length ? 1 : 0))
      if (fitted) shown.push(fitted)
    }
    break
  }
  return { ...thread, turns: shown.reverse() }
}

export interface ThreadInput {
  readonly leadControl?: LeadChatControl
  readonly id: string
  readonly session: Session
  readonly running: boolean
  /** The project's folder name, as the sessions list says it. */
  readonly project: string | null
  /** The title the sessions list shows, which the desk keeps; the agent's own read may not carry one. */
  readonly title?: string | null
  readonly pending: readonly Approval[]
  /** Approvals the phone decided lately, already projected, so the thread still shows what was answered. */
  readonly decided: readonly PhoneApprovalTurn[]
}

export const buildThread = (input: ThreadInput, context: ThreadContext): PhoneWorkThread => {
  const { session } = input
  const omittedSourceTurns = Math.max(0, session.turns.length - RECENT_TURNS)
  let truncated = omittedSourceTurns > 0
  const sent = new Set(input.leadControl?.sent ?? [])
  const turns = session.turns.slice(-RECENT_TURNS).flatMap(turn => turnsOf(turn, session.cwd, () => { truncated = true }, sent, input.id))
  // The sessions list's own project, so a row and its conversation never name two.
  const { project } = input
  const asks: PhoneWorkTurn[] = []
  let question = false
  for (const approval of input.pending) {
    const assessed = assessApproval(approval, session.cwd, context)
    if (assessed) asks.push(assessed.turn)
    else question = true
  }
  const result: PhoneWorkThread = {
    ...(session.historyPending ? { historyPending: true } : {}),
    ...(input.leadControl ? { leadChatHolder: input.leadControl.holder } : {}),
    id: input.id,
    title: scrub(sessionLabel(input.title ?? session.title, session.preview, '') || firstAsk(session) || '') || 'Untitled',
    ...(project ? { project } : {}),
    agent: { name: context.seat },
    status: input.pending.length > 0 ? 'asksYou' : input.running ? 'running' : 'done',
    turns: [
      ...turns,
      ...input.decided,
      // A structured question cannot be answered from here; say so rather than leave an unexplained "asks you".
      ...(question ? [{ type: 'agent', id: `${input.id}:question`, markdown: 'The agent asked a question. Answer it on the desk.' } as const] : []),
      ...asks,
    ],
  }
  const bounded = boundThread(result, () => { truncated = true })
  return Object.defineProperty(bounded, projectionKey, { value: { omittedSourceTurns, truncated } satisfies ThreadProjection })
}
