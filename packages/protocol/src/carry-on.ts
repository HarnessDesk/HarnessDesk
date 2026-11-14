import type { RuntimeId, SessionId } from './ids.js'
import type { CarryOnCause, CarryOnItem, CarryOnMode, CarryOnPhase, CarryOnSide } from './items.js'

/**
 * Carrying a conversation on past a usage limit.
 *
 * When a turn fails because its account is out, the desk can move the
 * conversation to another account of the same agent, hand it to another
 * agent, wait for the reset, or stop — asking first, or by a rule the person
 * set. This module is the vocabulary host and renderer share: the rule and
 * its per-agent override, the incident the host keeps while it decides, and
 * the decision the person sends back.
 *
 * A machine setting, like the question wait: nothing a repository or a
 * message carries can change it.
 */
export const CARRY_ON_PREFERENCE = 'carryOn'

/**
 * - `ask` shows a card over the composer and waits for an answer.
 * - `switch` moves to the best account or agent with room, then says so.
 * - `wait` retries once just after a known reset; with none known it stops.
 * - `stop` leaves the conversation stopped, and still says so.
 */
export const CARRY_ON_CHOICES = ['ask', 'switch', 'wait', 'stop'] as const
export type CarryOnChoice = (typeof CARRY_ON_CHOICES)[number]

export interface CarryOnPolicy {
  /** The desk-wide rule. An agent's own `whenOut` overrides it. */
  readonly onLimit: CarryOnChoice
  /** Whether a switch may leave the agent for another one, in a new conversation. */
  readonly otherAgents: boolean
}

export const DEFAULT_CARRY_ON: CarryOnPolicy = { onLimit: 'ask', otherAgents: true }

/** The stored preference, read: an absent, malformed or unknown field is its default. */
export const carryOnPolicyOf = (preferences: Readonly<Record<string, unknown>> | undefined): CarryOnPolicy => {
  const stored = preferences?.[CARRY_ON_PREFERENCE]
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return DEFAULT_CARRY_ON
  const { onLimit, otherAgents } = stored as { onLimit?: unknown; otherAgents?: unknown }
  return {
    onLimit: (CARRY_ON_CHOICES as readonly unknown[]).includes(onLimit) ? (onLimit as CarryOnChoice) : DEFAULT_CARRY_ON.onLimit,
    otherAgents: typeof otherAgents === 'boolean' ? otherAgents : DEFAULT_CARRY_ON.otherAgents,
  }
}

/**
 * An agent's own rule for when one of its accounts runs out, kept in its
 * account pool (`accountPools[agent].whenOut`). `next` is the per-agent
 * spelling of `switch`. Absent means "follow the desk rule".
 */
export const WHEN_OUT = ['next', 'ask', 'wait', 'stop'] as const
export type WhenOut = (typeof WHEN_OUT)[number]

export const WHEN_OUT_LABEL: Readonly<Record<WhenOut, string>> = {
  next: 'Use the next account',
  ask: 'Ask me',
  wait: 'Wait until it resets',
  stop: 'Stop',
}

const CHOICE_OF_WHEN_OUT: Readonly<Record<WhenOut, CarryOnChoice>> = { next: 'switch', ask: 'ask', wait: 'wait', stop: 'stop' }
const WHEN_OUT_OF_CHOICE: Readonly<Record<CarryOnChoice, WhenOut>> = { switch: 'next', ask: 'ask', wait: 'wait', stop: 'stop' }

/** The per-agent spelling of a desk choice, for writing "Always do this" at the agent's level. */
export const whenOutForChoice = (choice: CarryOnChoice): WhenOut => WHEN_OUT_OF_CHOICE[choice]

/** Where a rule was read from — and so where "Always do this" writes. */
export type CarryOnScope = 'desk' | 'agent'

/**
 * The rule that applies to one agent: its own `whenOut` when it set one, the
 * desk's otherwise. An unknown stored value is read as absent.
 */
export const carryOnFor = (
  policy: CarryOnPolicy,
  pool: { readonly whenOut?: string } | undefined,
): { readonly choice: CarryOnChoice; readonly from: CarryOnScope } => {
  const own = pool?.whenOut
  return (WHEN_OUT as readonly unknown[]).includes(own)
    ? { choice: CHOICE_OF_WHEN_OUT[own as WhenOut], from: 'agent' }
    : { choice: policy.onLimit, from: 'desk' }
}

// ------------------------------------------------------------------ incidents

/**
 * Who a stuck conversation belongs to, which decides where its question shows:
 * an ordinary chat gets the card over its composer, a Team or Flow seat its
 * Team's notice, and a Lead chat the Lead's inbox — never the composer card.
 */
export const CARRY_ON_OWNERS = ['chat', 'seat', 'lead'] as const
export type CarryOnOwner = (typeof CARRY_ON_OWNERS)[number]

/**
 * - `deciding`: claimed, nothing sent yet.
 * - `asked`: waiting for the person's answer.
 * - `waiting-reset`: one retry on the same account is due at `nextAt`.
 * - `sending`: the continuing turn is being sent; a restart here never resends.
 * - `moved`: continued on another account or agent.
 * - `stopped`: left stopped, by choice or because nothing had room.
 * - `cleared`: over — the retry ran, or the person used the conversation.
 */
export const CARRY_ON_STATES = ['deciding', 'asked', 'waiting-reset', 'sending', 'moved', 'stopped', 'cleared'] as const
export type CarryOnState = (typeof CARRY_ON_STATES)[number]

/**
 * Where a candidate stands, when it is not simply available: offered on the
 * card only, never taken automatically.
 */
export const CARRY_ON_TARGET_STATES = ['nearlyOut', 'apiKey', 'signedOut'] as const
export type CarryOnTargetState = (typeof CARRY_ON_TARGET_STATES)[number]

/** One place the conversation could go on. Names come from the runtime's presentation, never an email. */
export interface CarryOnTarget {
  readonly runtime: RuntimeId
  /** The agent's display name. */
  readonly name: string
  /** The account's nickname or ordinal ("account 2"). */
  readonly account?: string
  /** The model it would continue on. */
  readonly model?: string
  readonly mode: CarryOnMode
  /** The pacing tier: 0 room with a known reset, 1 room with the reset unknown, 2 nearly spent, 3 out. */
  readonly tier: 0 | 1 | 2 | 3
  readonly state?: CarryOnTargetState
}

/** A conversation, named across the whole app. */
export interface CarryOnKey {
  readonly runtime: RuntimeId
  readonly sessionId: SessionId
}

/** One incident, as the renderer sees it: no email and no paths. */
export interface CarryOnIncidentView {
  readonly incidentId: string
  readonly runtime: RuntimeId
  readonly sessionId: SessionId
  readonly owner: CarryOnOwner
  readonly state: CarryOnState
  readonly cause: CarryOnCause
  readonly from: CarryOnSide
  /** Where it went, once `moved`. */
  readonly to?: CarryOnSide
  readonly mode?: CarryOnMode
  /** The conversation it continued in, after a handoff. */
  readonly link?: CarryOnKey
  /** When the stuck account's limit resets, when known. */
  readonly resetsAt?: number
  /** When the one retry at the reset is due, while `waiting-reset`. */
  readonly nextAt?: number
  readonly openedAt: number
  readonly choices: {
    /** What "Switch now" takes: the top candidate, when there is one. */
    readonly target?: CarryOnTarget
    /** Whether "Wait until reset" is possible — a reset time is known. */
    readonly wait: boolean
  }
  /** The rest, for "Other account…": nearly spent, API-key and signed-out ones included. */
  readonly others: readonly CarryOnTarget[]
  /** The level "Always do this" writes to. */
  readonly alwaysScope: CarryOnScope
  /** One plain sentence when something needs saying, such as "may already have been sent". */
  readonly note?: string
}

/** The answers an `asked` incident takes; `ask` is not one. */
export const CARRY_ON_DECISIONS = ['switch', 'wait', 'stop'] as const
export type CarryOnDecisionChoice = (typeof CARRY_ON_DECISIONS)[number]

/** The person's answer to an `asked` incident. */
export interface CarryOnDecision {
  readonly incidentId: string
  readonly choice: CarryOnDecisionChoice
  /** A runtime from the card's candidates; absent takes the top one. The host checks it, not the validator. */
  readonly target?: RuntimeId
  /** Write the choice as the rule at `alwaysScope`. */
  readonly always: boolean
}

// --------------------------------------------------------------------- marker

/**
 * What the transcript marker says, in words the desktop and the phone share.
 *
 * - `headline`: what happened, naming both sides — agent, account and model.
 * - `detail`: why (the cause, naming the agent and account that ran out) and when its
 *   limit resets, when known; a note the host recorded follows it.
 * - `link`: the words of the link to the other conversation of a handoff.
 */
export interface CarryOnMarkerText {
  readonly headline: string
  readonly detail?: string
  readonly link?: string
}

/** The fields of a marker its words are made from; the item itself fits. */
export type CarryOnMarkerInput = Pick<CarryOnItem, 'phase' | 'cause' | 'from' | 'to' | 'resetsAt' | 'link' | 'note'>

/** Formats a reset time the way the surface says times, such as "3:40 PM" or "Fri 3:40 PM". */
export type CarryOnTimeFormat = (at: number) => string

/**
 * An account label is a nickname or an ordinal. Anything shaped like an email
 * address is never shown, even if a record carried one by mistake.
 */
const accountLabel = (account: string | undefined): string | undefined => {
  const label = account?.trim()
  return label && !label.includes('@') ? label : undefined
}

/** One side, as "Agent · account · model", with what is unknown left out. */
export const carryOnSideText = (side: CarryOnSide, options: { readonly model?: boolean } = {}): string =>
  [side.name, accountLabel(side.account), options.model === false ? undefined : side.model].filter(Boolean).join(' · ')

/**
 * Who ran out, named as the headline names a side: "Agent · account", or the
 * agent alone. A bare label such as "work" would read as a sentence about work.
 */
const subjectOf = (side: CarryOnSide): string => carryOnSideText(side, { model: false })

const CAUSE: Readonly<Record<CarryOnCause, (who: string) => string>> = {
  credits: (who) => `${who} reached its usage limit`,
  rateLimit: (who) => `${who} stayed rate limited after retrying`,
  blocked: (who) => `${who} has no usage left`,
}

/** The cause in a sentence, and the reset time when one is known. */
const causeAndReset = (item: CarryOnMarkerInput, time: CarryOnTimeFormat, reset = true): string =>
  [CAUSE[item.cause](subjectOf(item.from)), reset && item.resetsAt !== undefined ? `resets ${time(item.resetsAt)}` : undefined]
    .filter(Boolean)
    .join(' · ')

/**
 * A note the host recorded, as a sentence: the service writes some as phrases
 * ("no reset time known"), which open with a capital here. Only the note —
 * a name keeps the case its presentation gives it.
 */
const noteText = (note: string | undefined): string | undefined => {
  const text = note?.trim()
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : undefined
}

const sentence = (...parts: (string | undefined)[]): string | undefined => {
  const shown = parts.map((part) => part?.trim()).filter((part): part is string => !!part)
  return shown.length === 0 ? undefined : shown.map((part) => (/[.!?]$/.test(part) ? part : `${part}.`)).join(' ')
}

/** The `from` side, with its model dropped when it is the model the conversation went on with. */
const fromText = (item: CarryOnMarkerInput): string =>
  carryOnSideText(item.from, { model: !item.to?.model || item.to.model !== item.from.model })

/** Why the conversation stopped, when the host did not say. */
const EXHAUSTED_NOTE = 'No other account or agent has room'

/**
 * The marker's words for each phase. Names come from the record, which the
 * host fills from the runtime's presentation and the account's label — never
 * a runtime id and never an email.
 */
export const CARRY_ON_MARKER: Readonly<Record<CarryOnPhase, (item: CarryOnMarkerInput, time: CarryOnTimeFormat) => CarryOnMarkerText>> = {
  switched: (item, time) => ({
    headline: item.to ? `Switched from ${fromText(item)} to ${carryOnSideText(item.to)}` : `Switched from ${fromText(item)}`,
    ...optional('detail', sentence(causeAndReset(item, time), noteText(item.note))),
  }),
  left: (item, time) => ({
    headline: item.to ? `Continued in a new conversation with ${carryOnSideText(item.to)}` : 'Continued in a new conversation',
    ...optional('detail', sentence(causeAndReset(item, time), noteText(item.note))),
    ...(item.link ? { link: 'Open' } : {}),
  }),
  arrived: (item, time) => ({
    headline: item.to ? `Continued from ${fromText(item)} on ${carryOnSideText(item.to)}` : `Continued from ${fromText(item)}`,
    ...optional('detail', sentence(causeAndReset(item, time), noteText(item.note))),
    ...(item.link ? { link: 'Earlier history' } : {}),
  }),
  waiting: (item, time) => ({
    headline: item.resetsAt !== undefined
      ? `Waiting for ${carryOnSideText(item.from)} to reset at ${time(item.resetsAt)}`
      : `Waiting for ${carryOnSideText(item.from)} to reset`,
    ...optional('detail', sentence(causeAndReset(item, time, false), noteText(item.note))),
  }),
  resumed: (item) => ({
    headline: `Resumed on ${carryOnSideText(item.from)} after its reset`,
    ...optional('detail', sentence(noteText(item.note))),
  }),
  // A stop can leave the conversation open elsewhere too (the move found it in
  // use there): the note says where, and the link opens it.
  stopped: (item, time) => ({
    headline: `Stopped on ${carryOnSideText(item.from)}`,
    ...optional('detail', sentence(causeAndReset(item, time), noteText(item.note))),
    ...(item.link ? { link: 'Open' } : {}),
  }),
  exhausted: (item, time) => ({
    headline: `Stopped on ${carryOnSideText(item.from)}`,
    ...optional('detail', sentence(causeAndReset(item, time), noteText(item.note ?? EXHAUSTED_NOTE))),
  }),
}

/** The marker's words for one item. */
export const carryOnMarker = (item: CarryOnMarkerInput, time: CarryOnTimeFormat): CarryOnMarkerText =>
  CARRY_ON_MARKER[item.phase](item, time)

/** The marker as one plain line, for a surface with no room for a divider (the phone). */
export const carryOnMarkerLine = (item: CarryOnMarkerInput, time: CarryOnTimeFormat): string => {
  const text = carryOnMarker(item, time)
  return sentence(text.headline, text.detail) ?? text.headline
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string }
}
