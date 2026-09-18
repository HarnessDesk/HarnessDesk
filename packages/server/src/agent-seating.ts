import type { ConfigOption, FlowPermission, FlowSeat, SeatFix, SeatReason, SessionSettings } from '@harnessdesk/protocol'

import { GIT_RULES, renderFlowTemplate, seatSpec } from './flow.js'

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
 * folded into it by the caller. A runtime with no offer is not installed.
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
   * Why it cannot open a conversation right now, in its own words — too old,
   * crashed, still starting, an account it would not answer about — or absent
   * when it can. Not installed is not this: that is no offer at all. When it is
   * set, the rest of the offer is not consulted, and need not have been read.
   */
  readonly unavailable?: string | null
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
   * effort is let through to be held to it once it is open (`differences`).
   */
  readonly efforts: readonly string[] | null
  readonly signedIn: boolean
  /**
   * Its window is exhausted; seating it now would fail or queue. A window that
   * binds one model only is not this: the runtime still answers on the others.
   */
  readonly spent: boolean
}

export interface PassedOver {
  readonly seat: FlowSeat
  /** A sentence for the host's refusal and its log: the runtime by its id, and what it lacks. */
  readonly why: string
  /** The same fact, for a surface to word and to offer the fix for (`fixOf`). */
  readonly reason: SeatReason
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

/** Why this candidate cannot be taken, as a fact a surface can act on, or null when it can. */
export const reasonAgainst = (seat: FlowSeat, offers: readonly SeatOffer[]): SeatReason | null => {
  const offer = offers.find((one) => one.runtime === seat.runtime)
  if (!offer) return { kind: 'notInstalled', added: false }
  if (offer.notInstalled) return { kind: 'notInstalled', added: true }
  if (offer.unavailable) return { kind: 'unavailable', detail: quoted(offer.unavailable) }
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
  }
  if (seat.effort && offer.efforts !== null && !offer.efforts.includes(seat.effort)) {
    return { kind: 'noEffort', effort: seat.effort }
  }
  return null
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
    case 'unavailable':
      return `${runtime} is unavailable: ${reason.detail}`
    case 'signedOut':
      return `${runtime} is signed out`
    case 'spent':
      return `${runtime}'s window is spent`
    case 'modelsUnread':
      return `cannot tell whether ${runtime} offers ${reason.model}: its model list could not be read`
    case 'noModel':
      return `${runtime} does not offer ${reason.model}`
    case 'noEffort':
      return `${runtime} does not offer ${reason.effort} effort`
    case 'couldNotOpen':
      return `${runtime} could not open a conversation: ${reason.detail}`
    case 'openedOtherwise':
      return `${runtime} runs it ${reason.detail}`
  }
}

/**
 * What removes a reason. Three places a person goes: the runtime (add it,
 * install it, sign in, look at what is wrong with it), its usage, or this
 * machine's seats for the Agent — the last being the answer whenever the seat
 * itself asks for something the runtime does not do here.
 */
export const fixOf = (runtime: string, reason: SeatReason): SeatFix => {
  switch (reason.kind) {
    case 'notInstalled':
      return reason.added ? { kind: 'install', runtime } : { kind: 'add', runtime }
    case 'signedOut':
      return { kind: 'signIn', runtime }
    case 'spent':
      return { kind: 'usage', runtime }
    case 'unavailable':
    case 'modelsUnread':
    case 'couldNotOpen':
      return { kind: 'runtime', runtime }
    case 'noModel':
    case 'noEffort':
    case 'openedOtherwise':
      return { kind: 'seats' }
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
export const chooseSeat = (candidates: readonly FlowSeat[], offers: readonly SeatOffer[]): Seating => {
  const passed: PassedOver[] = []
  for (const seat of candidates) {
    const reason = reasonAgainst(seat, offers)
    if (reason === null) return { seat, passed }
    passed.push(passedFor(seat, reason))
  }
  return { seat: null, passed }
}

/**
 * The refusal, a line per candidate. Each is quoted by `seatSpec`, in the
 * grammar `prefer` is written in, because that is the text a person can find
 * in an `AGENT.md` and change.
 */
export const explainRefusal = (passed: readonly PassedOver[]): string => {
  if (passed.length === 0) {
    return 'No seat could be opened for this Agent: it has no seat to try — add one to the prefer list in its AGENT.md.'
  }
  const lines = passed.map((one) => `  ${seatSpec(one.seat)} — ${one.why}`)
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
 * Where what opened differs from the seat that was asked for, a phrase each
 * naming the field, what was asked and what runs; empty when it is the seat.
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
 * own `seats`, and is exactly as much a thing asked for as `true` is.
 */
export const differences = (asked: FlowSeat, running: SeatRunning): string[] => {
  const found: string[] = []
  if (asked.model && running.model !== asked.model) {
    found.push(
      running.model === null
        ? `on no model it would name, not ${asked.model}`
        : `on model ${running.model}, not ${asked.model}`,
    )
  }
  if (asked.effort && running.effort !== asked.effort) {
    found.push(
      running.effort === null
        ? `with no effort setting, not at ${asked.effort} effort`
        : `at ${running.effort} effort, not ${asked.effort}`,
    )
  }
  const why = running.thinkingFixed ? ` (${quoted(running.thinkingFixed)})` : ''
  if (asked.thinking === true && !running.thinking) {
    found.push(`without thinking, which was asked for${why}`)
  }
  if (asked.thinking === false && running.thinking) {
    found.push(`with thinking on, which was asked to be off${why}`)
  }
  if (asked.thinking === undefined && running.thinking && running.thinkingFixed === null) {
    found.push('with thinking on, which was not asked for and would not turn off')
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
  const found = differences(asked, running)
  return found.length === 0 ? null : sentenceOf(asked.runtime, { kind: 'openedOtherwise', detail: found.join(', and ') })
}

// ------------------------------------------------------------ what it may do

/** How far each permission reaches. Keyed by the union, so a fourth has to be placed before it compiles. */
const REACH: Readonly<Record<FlowPermission, number>> = { read: 0, publish: 1, merge: 2 }

/**
 * What a seat may do: the narrower of the Agent's ceiling and what the seating
 * grants. The ceiling is never a grant — an Agent that may merge is not thereby
 * told to — and a grant never reaches past the ceiling, so writing needs the
 * Agent and whoever seats it to agree.
 */
export const permissionWithin = (ceiling: FlowPermission, grant: FlowPermission): FlowPermission =>
  REACH[grant] < REACH[ceiling] ? grant : ceiling

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
export const agentOrder = (brief: string, permission: FlowPermission, cwd: string): string =>
  `${brief}\n\n${renderFlowTemplate(GIT_RULES[permission], { repo: cwd })}`
