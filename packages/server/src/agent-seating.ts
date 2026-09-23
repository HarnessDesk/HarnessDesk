import {
  ceilingOfPermission,
  narrower,
  permissionOfCeiling,
  type AgentDefinition,
  type AgentId,
  type CeilingLevel,
  type ConfigOption,
  type FlowPermission,
  type FlowSeat,
  type SeatArchived,
  type SeatCandidate,
  type SeatDifference,
  type SeatFix,
  type SeatLeft,
  type SeatPlan,
  type SeatReason,
  type SessionSettings,
  type StandingOrder,
} from '@harnessdesk/protocol'

import { effortWord } from '@harnessdesk/protocol'

import { renderFlowTemplate, seatSpec } from './flow.js'

/**
 * Which seat an Agent takes here, and why not the ones above it — then, once it
 * is open, whether it is running what was asked.
 *
 * Pure: the caller builds the offers from the runtime registry, the accounts
 * plane and the limits it already reads, and hands over what an opened
 * conversation reports. Every branch below is therefore reachable from a test,
 * which matters because the expensive failure of this feature is silent:
 * seating a different model than the one asked for.
 *
 * So there is no fallback that guesses. A candidate either matches an offer
 * exactly or is passed over with a reason a person can act on — install it,
 * fix it, sign in, wait for the window, or change the model or the effort the
 * Agent asks for — and a list that could not be read is said to be unread,
 * never taken for a list of nothing.
 *
 * Two halves, because not everything can be known before a conversation
 * exists. What can be is checked before anything is opened; what only a
 * session can say — a runtime declares its efforts per session, and drops a
 * pick it has no place for rather than failing — is checked against what the
 * session reports once it is open. A pre-check that guesses and a post-check
 * that trusts are the same defect. Either way a candidate that fails is passed
 * over, the next one tried, and the reason worded as a fact about the seat, so
 * a refusal is one list whichever half found each reason.
 */

/**
 * What this machine can seat on one runtime, right now. One per runtime — the
 * first that names a runtime is the one read — with that runtime's accounts
 * folded into it by the caller. A runtime this desk could add but has not is
 * the one case with no offer at all; an id that names no runtime on this
 * desk, and none the desk could add, still gets an offer, so it can say which
 * (`unknownRuntime`).
 */
export interface SeatOffer {
  /** The runtime's id, as a seat spec names it: `cursor`, `claude`. */
  readonly runtime: string
  /**
   * Added to the desk, and the program it runs is not on this machine. Not
   * the same fix as a runtime nobody added — that is no offer at all — so it
   * is said apart, though a refusal words both "not installed". When it is
   * set the rest of the offer is not consulted.
   */
  readonly notInstalled?: boolean
  /**
   * No runtime by this id is on this desk, nor one it knows how to add:
   * neither the agents the desk knows how to run nor the public registry, as
   * last fetched, lists it. Not a runtime left unadded, which is no offer at
   * all, but a spelling neither list has (`prefer: [claude]`, where the id is
   * `claude-code`). When it is set the rest of the offer is not consulted,
   * and need not have been read.
   */
  readonly unknownRuntime?: boolean
  /**
   * Why it cannot be seated right now, and absent when nothing says so: its
   * health when that is not ready — too old, crashed, still starting — in its
   * own words, or the failure that came back when its health, or its account,
   * was asked for outright (a runtime whose own read of either throws is
   * offered this, in the words the failure came back with, rather than
   * failing the whole desk's read). Not installed is not this: that is either
   * no offer at all, or one that says so itself (`notInstalled`). Nor is a
   * runtime that answered nothing (`silent`) — that is silence, not a reason.
   * When it is set, the rest of the offer is not consulted, and need not have
   * been read.
   */
  readonly unavailable?: string | null
  /**
   * Asked whether it is signed in, it did not answer within this many
   * milliseconds, so nothing else about it is known. Not `unavailable`: that
   * is a runtime saying what is wrong with it, and this is one saying nothing.
   */
  readonly silent?: number | null
  /**
   * Models this runtime currently offers, by the id a seat spec writes, not
   * the label a picker shows. Empty means it does not take a model, so a
   * candidate that names one is passed over. **Null means the list could not
   * be read** — which is not the same fact, and must never be written as
   * empty: to this module empty says "does not offer", and a list that failed
   * to load would refuse every candidate that names a model for a reason that
   * is not true.
   */
  readonly models: readonly string[] | null
  /**
   * Efforts, on the same terms as `models`: `high`, not `High`. **Null means
   * not knowable before seating** — a runtime declares its efforts per
   * session, so asking would mean opening one — and a candidate that names an
   * effort is let through to be held to it once it is open (`differencesOf`).
   */
  readonly efforts: readonly string[] | null
  readonly signedIn: boolean
  /**
   * Its window is exhausted; seating it now would fail or queue. A window that
   * binds one model only is not this: the runtime still answers on the others.
   */
  readonly spent: boolean
  /**
   * Models whose own window is spent: a lane scoped to exactly that model id,
   * the way Gemini CLI reports its quota. The runtime still answers on its
   * other models, so only a candidate asking for one of these is passed over.
   * A scope that is not a model id ("Opus", "Gemini Models") matches no
   * candidate and changes nothing.
   */
  readonly spentModels?: readonly string[]
  readonly holds?: readonly CeilingLevel[]
}

export interface CeilingNeed {
  readonly level: CeilingLevel
  readonly unheld: 'seat' | 'refuse'
}

export interface PassedOver {
  readonly seat: FlowSeat
  /** A sentence for the host's refusal and its log: the runtime by its id, and what it lacks. */
  readonly why: string
  /** The same fact, for a surface to word and to offer the fix for (`fixOf`). */
  readonly reason: SeatReason
  /**
   * What the conversation it opened was left as, when it opened one and that
   * is anything but gone; absent or null when nothing is left.
   */
  readonly left?: SeatLeft | null
}

/**
 * The seat taken and the candidates above it, or no seat and every candidate.
 * A candidate below the one taken was never tried, so it is not in `passed`.
 */
export type Seating =
  | { readonly seat: FlowSeat; readonly passed: readonly PassedOver[] }
  | { readonly seat: null; readonly passed: readonly PassedOver[] }

/** The runtime's own sentence, fitted into one of ours: one line, no closing stop. */
const quoted = (words: string): string => words.replace(/\s+/g, ' ').trim().replace(/\.$/, '')

/** A deadline, in the unit a person would say it. */
export const durationWords = (ms: number): string => {
  if (ms < 1_000) return `${ms} ms`
  const seconds = Math.round(ms / 1_000)
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

/** Why this candidate cannot be taken, as a fact a surface can act on, or null when it can. */
export const reasonAgainst = (seat: FlowSeat, offers: readonly SeatOffer[], need?: CeilingNeed): SeatReason | null => {
  const offer = offers.find((one) => one.runtime === seat.runtime)
  if (!offer) return { kind: 'notInstalled', added: false }
  if (offer.unknownRuntime) return { kind: 'unknownRuntime' }
  if (offer.notInstalled) return { kind: 'notInstalled', added: true }
  if (offer.unavailable) return { kind: 'unavailable', detail: quoted(offer.unavailable) }
  // `!= null`, not truthiness: a deadline of 0ms is a real (if silly) deadline,
  // and falling through would read the placeholder `signedIn: false` as a
  // signed-out runtime instead of one that never answered.
  if (offer.silent != null) return { kind: 'noAnswer', after: offer.silent }
  /* Before anything the candidate asked for: signed out, a runtime may list no
     models at all, and "does not offer" would then send the reader to change a
     spec that was right. */
  if (!offer.signedIn) return { kind: 'signedOut' }
  if (offer.spent) return { kind: 'spent' }
  /* A model or effort left out, or written as null, is not asked for, so there
     is nothing to check it against. */
  if (seat.model) {
    if (offer.models === null) return { kind: 'modelsUnread', model: seat.model }
    if (!offer.models.includes(seat.model)) return { kind: 'noModel', model: seat.model }
    if (offer.spentModels?.includes(seat.model)) return { kind: 'spentModel', model: seat.model }
  }
  if (seat.effort && offer.efforts !== null && !offer.efforts.includes(seat.effort)) {
    return { kind: 'noEffort', effort: seat.effort }
  }
  if (need?.unheld === 'refuse' && !(offer.holds ?? []).includes(need.level)) {
    return { kind: 'unheld', level: need.level, detail: null }
  }
  return null
}

/**
 * One `SeatDifference` as a phrase of the host's sentence: the field, what
 * runs, and what was asked — `on model m2, not m1` — with the runtime's own
 * words for a switch that will not move, where it gave them. The one place a
 * difference is worded; `sentenceOf` joins the phrases, and nothing else does.
 */
export const fragmentOf = (difference: SeatDifference): string => {
  switch (difference.field) {
    case 'model':
      return difference.running === null
        ? `on no model it would name, not ${difference.asked}`
        : `on model ${difference.running}, not ${difference.asked}`
    case 'effort':
      return difference.running === null
        ? `with no effort setting, not at ${difference.asked} effort`
        : `at ${difference.running} effort, not ${difference.asked}`
    case 'thinking': {
      const why = difference.fixed ? ` (${difference.fixed})` : ''
      if (difference.asked === true) return `without thinking, which was asked for${why}`
      if (difference.asked === false) return `with thinking on, which was asked to be off${why}`
      return 'with thinking on, which was not asked for and would not turn off'
    }
  }
}

/**
 * A reason as the host says it: in a refusal, and in its log. The runtime is
 * named by the id a seat spec writes, because that is the text a person can
 * find in an `AGENT.md` and change. A surface words the reason itself.
 */
export const sentenceOf = (runtime: string, reason: SeatReason): string => {
  switch (reason.kind) {
    case 'notInstalled':
      return `${runtime} is not installed`
    case 'unknownRuntime':
      return `${runtime} is not a runtime on this desk, nor one it knows how to add`
    case 'unavailable':
      return `${runtime} is unavailable: ${reason.detail}`
    case 'noAnswer':
      return `${runtime} did not answer within ${durationWords(reason.after)} when asked whether it is signed in`
    case 'signedOut':
      return `${runtime} is signed out`
    case 'spent':
      return `${runtime}'s window is spent`
    case 'spentModel':
      return `${runtime}'s window for ${reason.model} is spent`
    case 'modelsUnread':
      return `cannot tell whether ${runtime} offers ${reason.model}: its model list could not be read`
    case 'noModel':
      return `${runtime} does not offer ${reason.model}`
    case 'noEffort':
      return `${runtime} does not offer ${reason.effort} effort`
    case 'couldNotOpen':
      return `${runtime} could not open a conversation: ${reason.detail}`
    case 'openedOtherwise':
      return `${runtime} runs it ${reason.differences.map(fragmentOf).join(', and ')}`
    case 'unheld':
      return `${runtime} cannot hold ${reason.level}${reason.detail ? ` — ${quoted(reason.detail)}` : ''}, and this Mac refuses a seat whose ceiling is only asked`
  }
}

/**
 * What removes a reason. Three places a person goes: the runtime (add it,
 * install it, sign in, look at what is wrong with it), its usage, or this
 * machine's seats for the Agent — the last being the answer whenever the seat
 * names something that is not a real choice here: a model or an effort the
 * runtime does not do, or a runtime that is not on this desk and cannot be
 * added to it.
 */
export const fixOf = (runtime: string, reason: SeatReason): SeatFix => {
  switch (reason.kind) {
    case 'notInstalled':
      return reason.added ? { kind: 'install', runtime } : { kind: 'add', runtime }
    case 'signedOut':
      return { kind: 'signIn', runtime }
    case 'spent':
    case 'spentModel':
      return { kind: 'usage', runtime }
    case 'unavailable':
    case 'noAnswer':
    case 'modelsUnread':
    case 'couldNotOpen':
      return { kind: 'runtime', runtime }
    case 'unknownRuntime':
    case 'noModel':
    case 'noEffort':
    case 'openedOtherwise':
      return { kind: 'seats' }
    case 'unheld':
      return { kind: 'ceilings' }
  }
}

/** One candidate passed over, the sentence and the fact from one reason so the two cannot disagree. */
export const passedFor = (seat: FlowSeat, reason: SeatReason): PassedOver => ({
  seat,
  why: sentenceOf(seat.runtime, reason),
  reason,
})

/**
 * The first candidate this machine can seat, exactly as it was written, and
 * each one above it with the reason it was passed over.
 */
export const chooseSeat = (candidates: readonly FlowSeat[], offers: readonly SeatOffer[], need?: CeilingNeed): Seating => {
  const passed: PassedOver[] = []
  for (const seat of candidates) {
    const reason = reasonAgainst(seat, offers, need)
    if (reason === null) return { seat, passed }
    passed.push(passedFor(seat, reason))
  }
  return { seat: null, passed }
}

/**
 * What a passed-over seat's conversation was left as, as a clause of its line.
 * No more than the desk knows: a runtime with no delete *may* keep what it
 * opened, and "archived here" is said only when the desk's archive took it.
 * The runtime's own words for a refused delete are quoted, because the clause
 * goes on after them.
 */
export const leftWords = (runtime: string, left: SeatLeft): string => {
  switch (left.kind) {
    case 'kept':
      return `the conversation it opened may stay in ${runtime}'s own history, which the desk cannot delete from; ${archivedWords(runtime, left.archived)}`
    case 'undeleted':
      return `the conversation it opened could not be deleted: “${quoted(left.detail)}”; ${archivedWords(runtime, left.archived)}`
    case 'inUse':
      return 'the conversation it opened was used meanwhile, so it was left as it is'
    case 'alreadyHeld':
      // Never "opened": this candidate opened nothing at all — the runtime
      // answered with the id of a conversation the desk already had, which
      // `#openSeat` refuses before attaching, naming or closing anything.
      return 'the conversation it answered with is one the desk already held, so it was left as it is'
    case 'unasked':
      return `${runtime} was gone before it could be asked to delete the conversation it opened, which may stay in its history`
  }
}

/** Where a conversation the desk could not delete went instead, as the end of a clause. */
const archivedWords = (runtime: string, archived: SeatArchived): string => {
  switch (archived) {
    case 'here':
      return 'it is archived here'
    case 'runtime':
      return `it is in ${runtime}'s own archive`
    case 'failed':
      return 'archiving it failed, so it may still be listed'
  }
}

/**
 * What discarding a seat that failed part-way through opening left behind,
 * kept beside the failure rather than inside it. The failure goes on exactly as
 * it was thrown — its words, its class, its wire code — so a flow reads it as
 * it always has; an Agent's seating reads this as well (`leftOnFailure`), and
 * says it on that candidate's line. Weak, so a failure nobody reads takes its
 * note with it.
 */
const leftByFailure = new WeakMap<object, SeatLeft>()

/**
 * Notes what a failed seat's discard left behind on the failure it threw — and,
 * for null, takes off whatever an earlier seat noted there. An adapter may keep
 * one error object and throw it again for the next seat, and a note left on it
 * would be read out on that seat's line as what it left.
 */
export const noteLeftOnFailure = (failure: unknown, left: SeatLeft | null): void => {
  if (typeof failure !== 'object' || failure === null) return
  if (left === null) leftByFailure.delete(failure)
  else leftByFailure.set(failure, left)
}

/** What a failed seat's discard left behind, as noted on the failure; null when nothing was. */
export const leftOnFailure = (failure: unknown): SeatLeft | null =>
  typeof failure === 'object' && failure !== null ? (leftByFailure.get(failure) ?? null) : null

/**
 * The refusal, a line per candidate. Each is quoted by `seatSpec`, in the
 * grammar `prefer` is written in, because that is the text a person can find
 * in an `AGENT.md` and change.
 */
export const explainRefusal = (passed: readonly PassedOver[]): string => {
  if (passed.length === 0) {
    return 'No seat could be opened for this Agent: it has no seat to try — add one to the prefer list in its AGENT.md.'
  }
  const lines = passed.map(
    (one) => `  ${seatSpec(one.seat)} — ${one.why}${one.left ? ` (${leftWords(one.seat.runtime, one.left)})` : ''}`,
  )
  return `No seat could be opened for this Agent:\n${lines.join('\n')}`
}

// ------------------------------------------------------------ once it is open

/**
 * What an opened conversation reports it is running, read back from the
 * conversation after its picks were applied: the runtime's report, never the
 * request. Over ACP the report is what the agent said in answer to each pick,
 * or announced while it was being made; only a pick it answered without a word
 * about it is reported at what was asked, and that is the agent's claim, not a
 * reading (`AcpSession.setOption`). Over Codex it is what Codex announced once
 * the change was made; a change Codex took and never announced is refused at
 * the pick, so it never reaches a read-back (`CodexSession.setOption`).
 */
export interface SeatRunning {
  /** The model it is on, as the runtime spells it; null when it names none. */
  readonly model: string | null
  /** The effort it is at; null when it has no effort setting at all. */
  readonly effort: string | null
  /** Whether thinking is on. Off where the runtime has no such switch. */
  readonly thinking: boolean
  /**
   * Why the thinking switch cannot be moved on this model, in the runtime's
   * own words — "Gemini 3.8 Flash always thinks …", "… has no thinking mode" —
   * or null when it can be, or when there is no switch.
   */
  readonly thinkingFixed: string | null
}

/**
 * The read-back, from the controls the seat's picks were applied to: the same
 * ids — `model`, `effort`, `thinking` — that seating sets, so what is compared
 * is what was set. A runtime with no model control reports its model in its
 * settings instead.
 */
export const runningOf = (options: readonly ConfigOption[], settings: SessionSettings): SeatRunning => {
  const control = (id: string) => options.find((one) => one.id === id)
  const model = control('model')
  const effort = control('effort')
  const thinking = control('thinking')
  return {
    model: model ? String(model.currentValue) : settings.model || null,
    effort: effort ? String(effort.currentValue) : null,
    thinking: thinking?.currentValue === true,
    thinkingFixed: thinking?.disabled ?? null,
  }
}

/**
 * Where what opened differs from the seat that was asked for, as facts: one
 * per field that differs, naming the field, what was asked and what runs;
 * empty when it is the seat. The one place that decides what counts as a
 * difference. A refusal carries these on its reason, for a surface to word,
 * and the host's own sentence is built from them (`sentenceOf`, `fragmentOf`)
 * — never decided a second time — so the fact and the sentence cannot drift
 * apart.
 *
 * Model and effort are compared only when the seat names them, exactly, as the
 * chooser compares them. Thinking is compared either way, because a seat says
 * it either way — `+thinking`, or not — and seating turns off a switch nobody
 * asked for rather than inherit the last seat's.
 *
 * The one allowance is for a seat that said nothing about thinking, on a model
 * whose switch the runtime says it cannot move: a model that always thinks is
 * the model that was asked for, thinking included. It is for silence only. A
 * seat that asked for thinking on a model that cannot is refused, and so is
 * one that asked for it *off* on a model that always thinks — `+thinking` is
 * the only switch a spec writes, so an explicit `false` comes from a seating's
 * own `seats`, and is exactly as much a thing asked for as `true` is. Where the
 * runtime said why its switch will not move, its words travel with the
 * difference (`SeatDifference.fixed`), fitted to one line, for the sentence to
 * quote.
 */
export const differencesOf = (asked: FlowSeat, running: SeatRunning): SeatDifference[] => {
  const found: SeatDifference[] = []
  if (asked.model && running.model !== asked.model) {
    found.push({ field: 'model', asked: asked.model, running: running.model })
  }
  if (asked.effort && running.effort !== asked.effort) {
    found.push({ field: 'effort', asked: asked.effort, running: running.effort })
  }
  const fixed = running.thinkingFixed ? { fixed: quoted(running.thinkingFixed) } : {}
  if (asked.thinking === true && !running.thinking) {
    found.push({ field: 'thinking', asked: true, running: false, ...fixed })
  }
  if (asked.thinking === false && running.thinking) {
    found.push({ field: 'thinking', asked: false, running: true, ...fixed })
  }
  if (asked.thinking === undefined && running.thinking && running.thinkingFixed === null) {
    found.push({ field: 'thinking', asked: null, running: true })
  }
  return found
}

/**
 * Why a seat that opened cannot be kept, as its line in a refusal, or null
 * when it is running what was asked. Worded, like every reason before opening,
 * as what is true of the seat — "claude runs it at medium effort, not high" —
 * and not as what was done about it, so a refusal reads as one list.
 */
export const openedOtherwise = (asked: FlowSeat, running: SeatRunning): string | null => {
  const found = differencesOf(asked, running)
  return found.length === 0 ? null : sentenceOf(asked.runtime, { kind: 'openedOtherwise', differences: found })
}

// ------------------------------------------------------------ what it may do

/** The old seating grant translated onto the ceiling ladder. */
export const grantOf = (permission: FlowPermission | undefined): CeilingLevel =>
  permission === undefined ? 'edit' : ceilingOfPermission(permission)

/**
 * What a seat may do: the narrower of the Agent's ceiling and what the seating
 * grants. The ceiling is never a grant — an Agent that may merge is not thereby
 * told to — and a grant never reaches past the ceiling, so writing needs the
 * Agent and whoever seats it to agree.
 */
export const ceilingWithin = (ceiling: CeilingLevel, grant: CeilingLevel): CeilingLevel => narrower(ceiling, grant)

/** Record the standing order in the vocabulary the Agent file used. */
export const standingOf = (from: AgentDefinition['ceilingFrom'], level: CeilingLevel): StandingOrder => {
  const permission = from === 'permission' ? permissionOfCeiling(level) : null
  return permission ? { kind: 'permission', permission } : { kind: 'ceiling', level }
}

/** One line of role guidance per level; enforcement is supplied elsewhere. */
export const CEILING_RULES: Readonly<Record<CeilingLevel, string>> = {
  read: '- Your ceiling is read: you change nothing, in {{repo}} or anywhere else — no edits, no commits, no pushes. Anything you hand to a sub-agent or a background agent is held to it too.',
  edit: '- Your ceiling is edit: you may change files and commit in {{repo}}, and you never push, merge, reset or force anything. Anything you hand to a sub-agent or a background agent is held to it too.',
  publish:
    '- Your ceiling is publish: you may commit in {{repo}}, push your own branch and open a pull request for it, and you never merge, reset or force anything. Anything you hand to a sub-agent or a background agent is held to it too.',
  merge:
    '- Your ceiling is merge: you may merge what you are asked to merge, and you never reset or force anything. Anything you hand to a sub-agent or a background agent is held to it too.',
}

/**
 * The standing order an Agent's seat is handed: the brief as its author wrote
 * it, then the rule of the permission the seat holds.
 *
 * The rule is `GIT_RULES`' own sentence, its `{{repo}}` filled with where the
 * seat works, exactly as a flow seat's is — so a seat told `read` by an Agent
 * and one told `read` by a flow are told one thing in one set of words. The
 * brief is not rendered: it is the author's text, and goes over as written.
 *
 * Told, not enforced. This is all a seat's permission is today, a flow seat's
 * included: nothing at the tool surface holds it to the rule yet.
 */
export const agentOrder = (brief: string, level: CeilingLevel, cwd: string): string =>
  `${brief}\n\n${renderFlowTemplate(CEILING_RULES[level], { repo: cwd })}`

// ------------------------------------------------------------ in words

/**
 * How a seat is said to a person: the runtime by the name the desk calls it,
 * and a model and an effort by the labels the runtime gave them where it gave
 * any. The caller knows the names; this only puts them in order.
 */
export interface SeatWords {
  runtime(id: string): string
  model(runtime: string, model: string): string
  effort(runtime: string, model: string | null | undefined, effort: string): string
}

/**
 * Re-exported rather than kept here: the renderer words a refusal from the
 * same vocabulary (`reasonWords` in `packages/ui/src/lib/agents.ts`), and one
 * shared table (`@harnessdesk/protocol`) is what keeps an effort from reading
 * two different ways depending on which side of the wire is talking about it.
 */
export { effortWord }

/** "Claude · Opus 5 · High · thinking" — what a surface shows where a spec would otherwise be. */
export const describeSeat = (seat: FlowSeat, words: SeatWords): string =>
  [
    words.runtime(seat.runtime),
    seat.model ? words.model(seat.runtime, seat.model) : null,
    seat.effort ? words.effort(seat.runtime, seat.model, seat.effort) : null,
    seat.thinking ? 'thinking' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

/** One candidate passed over, as a surface shows it. */
export const candidateOf = (one: PassedOver, words: SeatWords): SeatCandidate => ({
  seat: one.seat,
  label: describeSeat(one.seat, words),
  runtimeName: words.runtime(one.seat.runtime),
  state: 'passed',
  reason: one.reason,
  fix: fixOf(one.seat.runtime, one.reason),
  ...(one.left ? { left: one.left } : {}),
})

/**
 * The plan for one Agent: every candidate in order, the one that would be
 * taken, and why each above it would not be. Every candidate above the winner
 * is passed over, so the chooser's list lines up with the candidates by index.
 */
export const planSeats = (
  id: AgentId,
  candidates: readonly FlowSeat[],
  offers: readonly SeatOffer[],
  words: SeatWords,
  from: SeatPlan['from'] = 'prefer',
  need?: CeilingNeed,
): SeatPlan => {
  const chosen = chooseSeat(candidates, offers, need)
  const winner = chosen.seat === null ? null : chosen.passed.length
  const taken = chosen.seat ? offers.find((one) => one.runtime === chosen.seat?.runtime) : undefined
  return {
    id,
    from,
    winner,
    blocked: null,
    ceiling:
      need && chosen.seat
        ? { level: need.level, hold: (taken?.holds ?? []).includes(need.level) ? 'held' : 'asked' }
        : null,
    candidates: candidates.map((seat, index): SeatCandidate => {
      const passed = chosen.passed[index]
      if (passed) return candidateOf(passed, words)
      return {
        seat,
        label: describeSeat(seat, words),
        runtimeName: words.runtime(seat.runtime),
        state: index === winner ? 'taken' : 'untried',
        reason: null,
        fix: null,
      }
    }),
  }
}

/** An Agent that cannot be weighed at all, with why. */
export const blockedPlan = (id: AgentId, why: string, from: SeatPlan['from'] = 'prefer'): SeatPlan => ({
  id,
  from,
  candidates: [],
  winner: null,
  blocked: why,
  ceiling: null,
})
