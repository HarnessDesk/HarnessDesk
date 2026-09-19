import {
  effortWord,
  type AgentEntry,
  type AgentOrigin,
  type FlowPermission,
  type RuntimeInfo,
  type SeatCandidate,
  type SeatDifference,
  type SeatFix,
  type SeatPlan,
  type SeatReason,
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

const PERMISSION_WORD: Readonly<Record<FlowPermission, string>> = { read: 'Read', publish: 'Publish', merge: 'Merge' }

/**
 * A ceiling as every surface says it in this phase: its word, and that it is
 * asked rather than held — the seat is told it, and nothing stops it yet.
 */
export const ceilingWords = (permission: FlowPermission): string => `${PERMISSION_WORD[permission]} · asked`

/** What a ceiling tells a seat, for a title: the rule, and that nothing holds it to the rule. */
export const ceilingMeaning = (permission: FlowPermission): string =>
  `${
    permission === 'read'
      ? 'Told it may edit and commit in its own checkout, and never push or merge.'
      : permission === 'publish'
        ? 'Told it may push its own branch and open a pull request, and never merge.'
        : 'Told it may merge what it is asked to merge.'
  } Asked, not held: nothing enforces it yet.`

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
