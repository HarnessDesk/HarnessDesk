import type { FlowThen } from './flow.js'

/**
 * Intake: what a project declares may open work on its own.
 *
 * A project's `.harnessdesk/triggers.yml` names a source — pull requests,
 * issues, or an interval — what each firing opens, how firings group into
 * Goals, what makes a firing new, how many Goals may be open at once, and
 * what bounds each one. It arrives with a clone, so it is a *declaration*:
 * nothing here runs until a person arms it on their own machine, and nothing
 * in it can name a command, an environment, a ceiling or a template that
 * outside text could fill.
 *
 * The vocabulary is closed on purpose. Three sources, a finite field list per
 * source, and one bounded budget; a new source or field is a protocol change,
 * never something a declaration reaches on its own.
 */

export type TriggerSource = 'pull-request' | 'issue' | 'schedule'

/** Every source, in the order the desk lists them. */
export const TRIGGER_SOURCES: readonly TriggerSource[] = ['pull-request', 'issue', 'schedule']

/**
 * The facts a firing's Goal grouping and dedupe keys may name. Each is a
 * host-validated scalar the source assigns: `event` is a stable fact
 * identity the desk derives, never a delivery time or a body field.
 */
export type TriggerField = 'pr' | 'head' | 'event' | 'issue' | 'slot'

export type PullRequestEvent = 'opened' | 'pushed'
export type IssueEvent = 'labelled' | 'closed' | 'commented'

/**
 * What one Goal a trigger opens may spend before it stops for a person.
 * `usd` is an observed stop threshold, never an invoice.
 */
export interface TriggerBudget {
  readonly usd: number
  readonly rounds: number
  readonly hours: number
  readonly withoutProgress: number
}

/** What a declaration that names no budget gets. */
export const DEFAULT_TRIGGER_BUDGET: TriggerBudget = { usd: 5, rounds: 3, hours: 4, withoutProgress: 2 }

export type TriggerOn =
  | { readonly kind: 'pull-request'; readonly events: readonly PullRequestEvent[] }
  | { readonly kind: 'issue'; readonly events: readonly IssueEvent[] }
  | { readonly kind: 'schedule'; readonly events: readonly ['tick']; readonly everyMinutes: number }

/** Per source: its events, the fields it may name, and what an omitted key defaults to. */
export const TRIGGER_DEFAULTS: {
  readonly 'pull-request': { readonly events: readonly PullRequestEvent[]; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly issue: { readonly events: readonly IssueEvent[]; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
  readonly schedule: { readonly events: readonly ['tick']; readonly fields: readonly TriggerField[]; readonly goal: readonly TriggerField[]; readonly dedupe: readonly TriggerField[] }
} = {
  'pull-request': { events: ['opened', 'pushed'], fields: ['pr', 'head', 'event'], goal: ['pr'], dedupe: ['pr', 'head', 'event'] },
  issue: { events: ['labelled', 'closed', 'commented'], fields: ['issue', 'event'], goal: ['issue'], dedupe: ['issue', 'event'] },
  schedule: { events: ['tick'], fields: ['slot'], goal: ['slot'], dedupe: ['slot'] },
}

/** One trigger as the host normalized it: every omitted setting filled, nothing inferred from event text. */
export interface TriggerDefinition {
  /** Project-scoped: what arming and history attach to. */
  readonly id: string
  readonly on: TriggerOn
  /** Exactly one: a flow by its catalogue id, or a single Agent run as a one-role flow. */
  readonly opens: { readonly flow: string } | { readonly agent: string }
  /** Which Goal a firing lands in: firings that agree on these fields share an open Goal. */
  readonly goal: readonly TriggerField[]
  /** The round a later firing opens in an open Goal; null records the fact and asks the person. */
  readonly again: FlowThen | null
  /** What makes a firing new: two facts that agree on these fields are one firing. */
  readonly dedupe: readonly TriggerField[]
  /** How many Goals this trigger may have open at once. */
  readonly concurrency: number
  /** Whether a pull request from another repository may open work. Only a pull-request trigger may say `allow`. */
  readonly forks: 'never' | 'allow'
  readonly budget: TriggerBudget
}

/** One thing wrong with a triggers file, where, and what fixes it. */
export interface TriggerProblem {
  /** `[2].budget.usd`, `line 7`, or `file` for the file as a whole. */
  readonly at: string
  readonly text: string
  readonly fix: string
}

/**
 * A parsed file: every definition, or none at all. A file with any problem
 * runs nothing — a partial parse is never armed under one file's digest.
 */
export interface TriggerDocument {
  readonly definitions: readonly TriggerDefinition[]
  readonly problems: readonly TriggerProblem[]
}
