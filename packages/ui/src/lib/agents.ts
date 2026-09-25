import {
  effortWord,
  type AgentEntry,
  type AgentOrigin,
  type CeilingLevel,
  type FlowSeat,
  type RuntimeInfo,
  type SeatArchived,
  type SeatCandidate,
  type SeatCeiling,
  type SeatDifference,
  type SeatFix,
  type SeatLeft,
  type SeatPlan,
  type SeatReason,
  type Session,
  type WorkspaceEntry,
} from '@harnessdesk/protocol'

import { shortPath } from './paths'

/**
 * Agents, in words.
 *
 * Every surface that lists or starts an Agent says the same few things — its
 * ceiling, where it was found, why a seat was passed over and what fixes it —
 * and says them with no wire id, no seat spec and no digest. One place to say
 * each, so the roster, the refusal sheet, the name card and every menu cannot
 * drift apart. Pure: no store, no React.
 */

const LEVEL_WORD: Readonly<Record<CeilingLevel, string>> = { read: 'Read', edit: 'Edit', publish: 'Publish', merge: 'Merge' }

/**
 * A ceiling as every surface says it in this phase: its word, and that it is
 * asked rather than held — the seat is told it, and nothing stops it yet.
 */
export const ceilingWords = (level: CeilingLevel): string => LEVEL_WORD[level]

/** A seat's effective ceiling and whether its runtime holds it. */
export const seatCeilingWords = (ceiling: SeatCeiling): string => `${LEVEL_WORD[ceiling.level]} · ${ceiling.hold}`

/** What a ceiling tells a seat, for a title: the rule, and that nothing holds it to the rule. */
export const ceilingMeaning = (level: CeilingLevel): string =>
  level === 'read'
    ? 'Changes nothing: it reads, searches and reports.'
    : level === 'edit'
      ? 'May change files and commit in its own checkout, and never push.'
      : level === 'publish'
        ? 'May push its own branch and open a pull request, and never merge.'
        : 'May merge what it is asked to merge.'

/** Where an Agent was found, as its section is headed. */
export const originWords = (origin: AgentOrigin, project: string | null): string =>
  origin === 'project' ? `In ${project ?? 'this project'}` : origin === 'user' ? 'Yours' : 'Built in'

/**
 * The name of the project a roster is read for: its repository's folder, or a
 * worktree's own — `checkoutRoot`, never `repo.root`, which names the *main*
 * checkout on purpose (so the session list can group a worktree under the
 * project it is a checkout of) and is therefore the wrong folder for a
 * worktree, and never `workspace.path` alone, which is only the same folder
 * when nobody opened a subfolder of it.
 */
export const projectName = (workspace: WorkspaceEntry | null): string | null => {
  if (!workspace) return null
  const root = workspace.checkoutRoot ?? workspace.path
  return root.split('/').filter(Boolean).at(-1) ?? workspace.name
}

/** An Agent's name, or its folder's when its file names none or will not parse. */
export const agentName = (entry: AgentEntry): string => entry.definition?.name ?? entry.id

/** The Agents a surface can start: listed, and parsed. */
export const inForce = (entries: readonly AgentEntry[]): AgentEntry[] => entries.filter((one) => one.definition !== null)

/** Whether any listed Agent's file fails to parse — the only thing the nav row's dot is for. */
export const anyBroken = (entries: readonly AgentEntry[]): boolean =>
  entries.some((one) => one.problems.some((problem) => problem.level === 'error'))

/** The roster in its three sections, in the order precedence reads them. */
export const bySection = (entries: readonly AgentEntry[]): Readonly<Record<AgentOrigin, readonly AgentEntry[]>> => ({
  project: entries.filter((one) => one.origin === 'project'),
  user: entries.filter((one) => one.origin === 'user'),
  builtin: entries.filter((one) => one.origin === 'builtin'),
})

/**
 * Where an Agent's file is, as a person reads it. A shipped one is named inside
 * the app rather than by the folder the app is installed in, which differs on
 * every Mac and says nothing about the Agent.
 */
export const fileWords = (
  entry: { readonly id: string; readonly origin: AgentOrigin; readonly path: string },
  home: string,
): string => (entry.origin === 'builtin' ? `HarnessDesk › agents/${entry.id}/AGENT.md` : shortPath(entry.path, home))

/**
 * Whether an entry names a real Agent folder — `<tier>/<id>/AGENT.md` — rather
 * than the placeholder a project's own unreadable Agent directory becomes
 * (`.harnessdesk/agents`: an id naming the directory itself, and a path that
 * *is* that directory, never a file inside it). No file action belongs on the
 * placeholder: there is no folder by that name to remove, customize or reveal
 * — the host refuses those too (`listedAgentPath` in `methods/agents.ts`), but
 * an Agent's page must not rely on that to withhold the buttons in the first
 * place.
 */
export const isAgentFolder = (entry: { readonly id: string; readonly path: string }): boolean =>
  entry.path.endsWith(`/${entry.id}/AGENT.md`)

/** Whether two seats ask for the same thing: runtime, model, effort and thinking, an absent one the same as none. */
export const sameSeat = (a: FlowSeat, b: FlowSeat): boolean =>
  a.runtime === b.runtime &&
  (a.model ?? null) === (b.model ?? null) &&
  (a.effort ?? null) === (b.effort ?? null) &&
  Boolean(a.thinking) === Boolean(b.thinking)

/**
 * The seat a conversation is on, read the way seating reads one back
 * (`runningOf`, `agent-seating.ts`): its `model`, `effort` and `thinking`
 * controls, and the model from its settings where it has no model control.
 * Nothing it was not told is named.
 */
export const seatOf = (session: Session): FlowSeat => {
  const control = (id: string) => session.options?.find((one) => one.id === id)
  const model = control('model')
  const effort = control('effort')
  const thinking = control('thinking')
  const modelId = model ? String(model.currentValue) : session.settings?.model || null
  return {
    runtime: String(session.runtime),
    ...(modelId ? { model: modelId } : {}),
    ...(effort ? { effort: String(effort.currentValue) } : {}),
    ...(thinking?.currentValue === true ? { thinking: true } : {}),
  }
}

/** The same seat as a person reads it: the runtime's name, then the labels its controls show. */
export const seatWordsOf = (session: Session, runtimes: readonly RuntimeInfo[]): string => {
  const shown = (id: string): string | null => {
    const control = session.options?.find((one) => one.id === id)
    if (control?.type !== 'select') return null
    return control.choices.find((choice) => choice.value === control.currentValue)?.label ?? null
  }
  const thinking = session.options?.find((one) => one.id === 'thinking')
  return [
    runtimes.find((one) => one.id === session.runtime)?.presentation.name ?? String(session.runtime),
    shown('model') ?? (session.options?.some((one) => one.id === 'model') ? null : session.settings?.model || null),
    shown('effort'),
    thinking?.currentValue === true ? 'thinking' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** A brief's opening paragraph, on one line: what a page shows before *Open in editor*. */
export const firstParagraph = (brief: string): string =>
  (brief.trim().split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim()

/**
 * Looks up the label a runtime gave a model id, when the caller has one to
 * ask; null when it does not (or does not know). There is no such table for
 * effort — that one is universal (`effortWord`, shared with the host) — but a
 * model catalogue is per runtime and lives wherever the caller keeps it, so
 * `reasonWords` takes this rather than assuming one.
 */
export type ModelLabel = (id: string) => string | null

/** A model or effort id, worded by its known label when one is given, and as written otherwise. */
const modelWord = (id: string, modelLabel?: ModelLabel): string => modelLabel?.(id) ?? id

/** Either side of a `SeatDifference` is a plain id for `model`/`effort`; only `thinking` is ever a boolean. */
const idOf = (value: string | boolean | null): string => (typeof value === 'string' ? value : String(value))

/**
 * One field of a seat that opened running something other than what was
 * asked, worded as a clause: what it runs, and what was asked instead. A
 * model is named by its runtime's own label where `modelLabel` has one;
 * effort always reads as its known word (`effortWord`), the same vocabulary
 * `SeatCandidate.label` is built from. Thinking is never a raw boolean: it
 * reads as on or off.
 */
const differenceWords = (difference: SeatDifference, modelLabel?: ModelLabel): string => {
  switch (difference.field) {
    case 'model':
      return difference.running === null
        ? `on no model it would name, instead of ${modelWord(idOf(difference.asked), modelLabel)}`
        : `on ${modelWord(idOf(difference.running), modelLabel)}, instead of ${modelWord(idOf(difference.asked), modelLabel)}`
    case 'effort':
      return difference.running === null
        ? `at no effort it would name, instead of ${effortWord(idOf(difference.asked))} effort`
        : `at ${effortWord(idOf(difference.running))} effort, instead of ${effortWord(idOf(difference.asked))}`
    case 'thinking':
      if (difference.asked === true) return 'without thinking, though it was asked for'
      if (difference.asked === false) return 'with thinking on, though it was asked to be off'
      return 'with thinking on, though it was not asked for'
  }
}

/**
 * Why a candidate was passed over, as a sentence, with the runtime named the
 * way the desk names it — never its wire id.
 *
 * A model reads by its runtime's own label where `modelLabel` can find one —
 * no caller has a model catalogue to hand it yet, so this falls back to the
 * raw id today, but the seam is here for the one that does. An effort always
 * reads as its known word: unlike a model catalogue, that vocabulary
 * (`effortWord`) is universal and needs no per-runtime lookup, so there is no
 * excuse to show `xhigh` when "Extra high" is always known.
 *
 * Exhaustive over `SeatReason` with no `default`, so a kind the host adds
 * later fails this file's typecheck rather than falling through to nothing.
 */
export const reasonWords = (reason: SeatReason, runtime: string, modelLabel?: ModelLabel): string => {
  switch (reason.kind) {
    case 'notInstalled':
      return reason.added ? `${runtime} is not installed on this Mac` : `${runtime} is not added to HarnessDesk`
    case 'unknownRuntime':
      return `${runtime} is not a runtime HarnessDesk knows how to add`
    case 'unavailable':
      return `${runtime} is unavailable: ${reason.detail}`
    case 'noAnswer':
      return `${runtime} did not answer in time`
    case 'signedOut':
      return `${runtime} is signed out`
    case 'spent':
      return `${runtime}'s plan window is used up`
    case 'spentModel':
      return `${runtime}'s window for ${modelWord(reason.model, modelLabel)} is used up`
    case 'modelsUnread':
      return `${runtime}'s models could not be read`
    case 'noModel':
      return `${runtime} does not offer ${modelWord(reason.model, modelLabel)}`
    case 'noEffort':
      return `${runtime} does not offer ${effortWord(reason.effort)} effort`
    case 'couldNotOpen':
      return `${runtime} could not open a conversation: ${reason.detail}`
    case 'openedOtherwise':
      return `${runtime} opened it ${reason.differences.map((one) => differenceWords(one, modelLabel)).join(', and ')}`
    case 'unheld':
      // `required` is a front-door start's own need — every Seat holds its
      // ceiling, whatever this Mac's setting says — never the setting's own
      // refusal, which is not what is happening here.
      return reason.required
        ? `${runtime}’s seat cannot hold ${LEVEL_WORD[reason.level].toLowerCase()} yet: it is not running, or has not reported. Start ${runtime}, or choose another Agent.`
        : `${runtime} cannot hold ${LEVEL_WORD[reason.level].toLowerCase()}${reason.detail ? `: ${reason.detail}` : ''}, and this Mac refuses a seat whose ceiling is only asked`
  }
}

/** The one thing that removes a reason, as the button that does it is labelled. */
export const fixWords = (fix: SeatFix, runtime: string): string => {
  switch (fix.kind) {
    case 'add':
      return `Add ${runtime}`
    case 'install':
      return `Install ${runtime}`
    case 'signIn':
      return `Sign in to ${runtime}`
    case 'usage':
      return 'See when it resets'
    case 'runtime':
      return `Open ${runtime} in Settings`
    case 'seats':
      return 'Edit seats for this Mac'
    case 'ceilings':
      return 'Change what happens when a ceiling cannot be held'
  }
}

/** The seat a plan would take here, or null when it would take none. */
export const seatTaken = (plan: SeatPlan | undefined): SeatCandidate | null =>
  plan && plan.winner !== null ? (plan.candidates[plan.winner] ?? null) : null

/**
 * The first thing wrong with a plan that takes no seat, for a row with room
 * for one reason.
 *
 * `plan.blocked` is never shown as written: it is the host's own sentence
 * (`unusable()` in `methods/agents.ts`), and it opens with the Agent file's
 * absolute path. A blocked plan reads as one plain sentence instead, with
 * nothing this file cannot account for in it.
 */
export const firstReason = (plan: SeatPlan): string | null => {
  if (plan.blocked) return 'Its file has a problem'
  if (plan.winner !== null) return null
  const first = plan.candidates.find((one) => one.reason !== null)
  if (first?.reason) return reasonWords(first.reason, first.runtimeName)
  return plan.candidates.length === 0 ? 'It names no seat to try' : null
}

/** What a runtime mark is drawn from: the runtime this desk has, or the name the host gave one it has not. */
export const markFor = (
  candidate: SeatCandidate,
  runtimes: readonly RuntimeInfo[],
): { readonly id: string; readonly presentation: { readonly name: string; readonly brand?: string } } =>
  runtimes.find((one) => one.id === candidate.seat.runtime) ?? {
    id: candidate.seat.runtime,
    presentation: { name: candidate.runtimeName },
  }

/* --- the refusal sheet ---------------------------------------------------- */

const isCandidateState = (value: unknown): value is SeatCandidate['state'] =>
  value === 'taken' || value === 'passed' || value === 'untried'

const isArchived = (value: unknown): value is SeatArchived =>
  value === 'here' || value === 'runtime' || value === 'failed'

/** A `SeatReason`, narrowed from wire data. Null for a `kind` this file does not know, or a payload missing its fields. */
const asReason = (value: unknown): SeatReason | null => {
  const raw = value as { readonly kind?: unknown } | null
  if (raw == null || typeof raw.kind !== 'string') return null
  switch (raw.kind) {
    case 'notInstalled':
      return typeof (raw as { added?: unknown }).added === 'boolean' ? (raw as SeatReason) : null
    case 'unknownRuntime':
      return { kind: 'unknownRuntime' }
    case 'signedOut':
      return { kind: 'signedOut' }
    case 'spent':
      return { kind: 'spent' }
    case 'unavailable':
    case 'couldNotOpen':
      return typeof (raw as { detail?: unknown }).detail === 'string' ? (raw as SeatReason) : null
    case 'noAnswer':
      return typeof (raw as { after?: unknown }).after === 'number' ? (raw as SeatReason) : null
    case 'spentModel':
    case 'modelsUnread':
    case 'noModel':
      return typeof (raw as { model?: unknown }).model === 'string' ? (raw as SeatReason) : null
    case 'noEffort':
      return typeof (raw as { effort?: unknown }).effort === 'string' ? (raw as SeatReason) : null
    case 'openedOtherwise':
      return Array.isArray((raw as { differences?: unknown }).differences) ? (raw as SeatReason) : null
    case 'unheld': {
      const detail = (raw as { detail?: unknown }).detail
      return typeof (raw as { level?: unknown }).level === 'string' && (detail === null || typeof detail === 'string')
        ? (raw as SeatReason)
        : null
    }
    default:
      return null
  }
}

/** A `SeatFix`, narrowed from wire data. */
const asFix = (value: unknown): SeatFix | null => {
  const raw = value as { readonly kind?: unknown } | null
  if (raw == null || typeof raw.kind !== 'string') return null
  switch (raw.kind) {
    case 'add':
    case 'install':
    case 'signIn':
    case 'usage':
    case 'runtime': {
      // Split across two lines: this is a wire-shape check (is the field a
      // string at all), never a comparison against which runtime this is —
      // the layering gate's regex cannot tell those apart on one line.
      const field = (raw as { runtime?: unknown }).runtime
      return typeof field === 'string' ? (raw as SeatFix) : null
    }
    case 'seats':
      return { kind: 'seats' }
    default:
      return null
  }
}

/** A `SeatLeft`, narrowed from wire data. */
const asLeft = (value: unknown): SeatLeft | null => {
  const raw = value as { readonly kind?: unknown } | null
  if (raw == null || typeof raw.kind !== 'string') return null
  switch (raw.kind) {
    case 'kept':
      return isArchived((raw as { archived?: unknown }).archived) ? (raw as SeatLeft) : null
    case 'undeleted':
      return typeof (raw as { detail?: unknown }).detail === 'string' && isArchived((raw as { archived?: unknown }).archived)
        ? (raw as SeatLeft)
        : null
    case 'inUse':
      return { kind: 'inUse' }
    case 'alreadyHeld':
      return { kind: 'alreadyHeld' }
    case 'unasked':
      return { kind: 'unasked' }
    default:
      return null
  }
}

/**
 * One candidate, narrowed from wire data. A field that is present but does
 * not narrow drops the whole candidate rather than showing something wrong
 * about it — a refusal a person cannot trust is worse than a shorter one.
 */
const asCandidate = (value: unknown): SeatCandidate | null => {
  const raw = value as {
    readonly seat?: unknown
    readonly label?: unknown
    readonly runtimeName?: unknown
    readonly state?: unknown
    readonly reason?: unknown
    readonly fix?: unknown
    readonly left?: unknown
  } | null
  if (raw == null) return null
  const seat = raw.seat as { readonly runtime?: unknown } | null
  // Split for the same reason as `asFix`'s `runtime` case: a wire-shape
  // check, not a comparison against which runtime this is.
  const seatField = seat?.runtime
  if (typeof seatField !== 'string') return null
  if (typeof raw.label !== 'string' || typeof raw.runtimeName !== 'string') return null
  if (!isCandidateState(raw.state)) return null
  const reason = raw.reason == null ? null : asReason(raw.reason)
  if (raw.reason != null && reason === null) return null
  const fix = raw.fix == null ? null : asFix(raw.fix)
  if (raw.fix != null && fix === null) return null
  let left: SeatLeft | null | undefined
  if (raw.left !== undefined) {
    left = raw.left == null ? null : asLeft(raw.left)
    if (raw.left != null && left === null) return null
  }
  return {
    seat: raw.seat as FlowSeat,
    label: raw.label,
    runtimeName: raw.runtimeName,
    state: raw.state,
    reason,
    fix,
    ...(left !== undefined ? { left } : {}),
  }
}

/**
 * The candidates a host refusal carried, when the failure is a seating's
 * refusal; null for any other failure.
 *
 * The list arrives over the wire, so every candidate is narrowed rather than
 * cast — a malformed one is dropped rather than sinking the whole refusal, so
 * the sheet is more useful showing what it could read than falling back to a
 * generic error notice over one bad entry in an otherwise-good list.
 */
export const refusalOf = (error: unknown): readonly SeatCandidate[] | null => {
  const failure = error as { readonly code?: unknown; readonly data?: { readonly candidates?: unknown } } | null
  if (failure?.code !== 'seatRefused' || !Array.isArray(failure.data?.candidates)) return null
  return failure.data.candidates.map(asCandidate).filter((one): one is SeatCandidate => one !== null)
}

/** Whether any candidate shows a real attempt was made to open something, so "Nothing was opened" would be false. */
export const anyOpened = (candidates: readonly SeatCandidate[]): boolean =>
  candidates.some(
    (one) => one.left != null || one.reason?.kind === 'couldNotOpen' || one.reason?.kind === 'openedOtherwise',
  )

/** Where a conversation that could not be deleted was put, in a clause. */
const archivedWords = (archived: SeatArchived, runtime: string): string =>
  archived === 'here'
    ? 'here'
    : archived === 'runtime'
      ? `in ${runtime}'s own archive`
      : 'nowhere, because archiving it failed, so it may still be listed'

/**
 * What a passed-over seat may have left behind, in a sentence.
 *
 * Exhaustive over `SeatLeft` with no `default`, so a kind the host adds later
 * fails this file's typecheck rather than falling through to nothing.
 */
export const leftWords = (left: SeatLeft, runtime: string): string => {
  switch (left.kind) {
    case 'kept':
      return `${runtime} may keep the empty conversation it opened — it was put ${archivedWords(left.archived, runtime)}`
    case 'undeleted':
      return `${runtime} refused to delete it ("${left.detail}") — it was put ${archivedWords(left.archived, runtime)}`
    case 'inUse':
      return 'Somebody used the conversation while it was open, so it was left as it is'
    case 'alreadyHeld':
      return `${runtime} answered with a conversation already open here, which was left untouched`
    case 'unasked':
      return `${runtime} was gone before it could be asked to delete it, so it may still be in its history`
  }
}

/**
 * Why an Agent could not be weighed at all, worded from its own entry — never
 * the host's `SeatPlan.blocked` sentence, which starts with an absolute path
 * (a shipped Agent's own install path on top of it, for one cause). The entry
 * carries the reason when the trouble is its own file; a seating-file problem
 * or an id nothing answers to has no entry to read, so those read generically
 * instead, naming nothing about this machine's folders.
 */
export const blockedWords = (entry: AgentEntry | undefined, home: string): string => {
  const problem = entry?.problems.find((one) => one.level === 'error')
  if (entry && problem) return `${fileWords(entry, home)}: ${problem.at ? `${problem.at} — ` : ''}${problem.text}`
  return 'This Mac’s seats for it could not be read.'
}

/* --- a conversation seated as an Agent ------------------------------------ */

/** A word from an Agent's file — its id, a verdict — as a person reads it: `request-changes` → "Request changes". */
export const wordOf = (word: string): string => {
  const spaced = word.replace(/[-_]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A conversation's title led by the Agent it was seated as — said once, where the title already is its name. */
export const ledBy = (agent: string | null, title: string): string =>
  agent === null || title === agent ? title : `${agent} · ${title}`

/** Where the renderer keeps the Agent a seated conversation was seated as: the folder it works in, and the Agent's id. */
export const seatAgentKey = (cwd: string, id: string): string => JSON.stringify([cwd, id])

/** The folder a project Agent lives in, by name — "storefront" — or null for one of yours or one that ships. */
export const projectOfAgent = (entry: AgentEntry): string | null =>
  entry.origin === 'project' ? (entry.path.split('/').slice(0, -4).at(-1) ?? null) : null

/**
 * What a seated conversation's card warns about its Agent: a brief that has
 * moved on since it was handed over, or an Agent no longer there. Nothing
 * while it is still being read, and nothing on a read that failed outright —
 * a failure says nothing rather than guessing that the Agent is gone.
 */
export const seatCautions = (entry: AgentEntry | null | undefined, briefDigest: string | undefined): readonly string[] => {
  if (entry === undefined) return []
  if (entry === null) return ['Its Agent is not in this project any more.']
  return briefDigest && entry.digest !== null && entry.digest !== briefDigest
    ? ['The brief has changed since this started.']
    : []
}

/**
 * A seat passed over on the way to the one taken, with why — built from
 * `reasonWords` and `leftWords` rather than repeating either.
 */
export const passedWords = (candidate: SeatCandidate): string => {
  const why = [
    candidate.reason ? reasonWords(candidate.reason, candidate.runtimeName) : 'passed over',
    candidate.left ? leftWords(candidate.left, candidate.runtimeName) : null,
  ]
    .filter((part): part is string => part !== null)
    .join('. ')
  return `${candidate.label} — ${why}`
}

/* --- an Agent's page ------------------------------------------------------- */

/** A candidate's state on this Mac, as its row on an Agent's page says it. */
export const stateWords = (candidate: SeatCandidate): string => {
  if (candidate.state === 'taken') return 'The seat it takes here'
  if (candidate.state === 'untried') return 'Not reached: a seat before it is free'
  // The candidate label already names the model in the runtime's own words;
  // repeating its wire id as the reason would turn a readable row back into a spec.
  if (candidate.reason?.kind === 'noModel') return `${candidate.runtimeName} does not offer this model`
  return candidate.reason ? reasonWords(candidate.reason, candidate.runtimeName) : 'Passed over'
}

/** Words an Agent's file lists — its verdicts, what it produces — as a person reads them. */
export const wordList = (words: readonly string[]): string =>
  words.length === 0 ? 'None' : words.map(wordOf).join(' · ')

/** What an Agent in force comes first over, in a sentence; null when it hides nothing. */
export const shadowWords = (entry: AgentEntry): string | null =>
  entry.shadows.length === 0
    ? null
    : `Comes first over ${entry.shadows.map((one) => (one.origin === 'builtin' ? 'the one that ships' : 'yours')).join(' and ')}`

/**
 * Where *Customize…* may copy an Agent: only somewhere that comes before it,
 * the project first — a copy anywhere else would be shadowed by what it copies.
 */
export const copyTargets = (origin: AgentOrigin, project: boolean): readonly ('user' | 'project')[] =>
  origin === 'builtin' ? (project ? ['project', 'user'] : ['user']) : origin === 'user' && project ? ['project'] : []
