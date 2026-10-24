/** What a paired phone may do. `answer` is the verb that settles a decision for the person. */
export type PhoneTier = 'read' | 'run' | 'answer'

export interface PhoneDeviceView {
  readonly id: string
  readonly name: string
  readonly tiers: readonly PhoneTier[]
  readonly createdAt: number
  readonly lastSeenAt: number | null
}

/** A phone that showed a valid pairing code and is waiting for the person at the desk. */
export interface PhonePendingView {
  readonly id: string
  readonly name: string
  readonly deviceId: string
  readonly requestedAt: number
}

export interface PhoneLinkState {
  /** False until the desk is started with the phone link on. Nothing below is meaningful then. */
  readonly enabled: boolean
  readonly deskName: string
  readonly deskId: string
  readonly port: number | null
  readonly devices: readonly PhoneDeviceView[]
  readonly pending: readonly PhonePendingView[]
}

export interface PhonePairing {
  /** The `harnessdesk://pair?c=…` link the code carries. */
  readonly url: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
  readonly addresses: readonly { readonly host: string; readonly port: number }[]
}

/*
 * What a paired phone may read of the desk's work. Every shape below is a projection written for a small screen,
 * not a trimmed copy of a desk record: a path, a transcript, a token, an account address or a file's contents is
 * not a field of any of them, so no later change to a desk record can leak one by adding a field. Money is
 * dollars; a figure the desk does not know is `null` and never zero.
 */

export type PhoneSessionState = 'running' | 'needs-you' | 'done' | 'archived'
/** Sessions the desk lists are the person's own; Team and Lead sessions are listed under their Team. */
export type PhoneStartedBy = 'you' | 'lead' | 'team'

export interface PhoneSessionRow {
  /** Opaque and stable: "<agent>:<session>". It carries no path. */
  readonly id: string
  readonly title: string
  /** The repository's folder name, never its path; null when the session is not in a repository. */
  readonly project: string | null
  readonly state: PhoneSessionState
  readonly startedBy: PhoneStartedBy
  /** What the session runs on, in the desk's words ("Codex Sol High"). */
  readonly seat: string
  /** Dollars so far; null when the agent does not price its sessions. */
  readonly cost: number | null
  /** Epoch milliseconds. */
  readonly lastActivityAt: number
  /** Pins live on the phone; the desk never sets this. */
  readonly pinned: boolean
}

export interface PhoneSessionCounts {
  readonly running: number
  readonly needsYou: number
  readonly done: number
  readonly archived: number
}

export interface PhoneSessionsList {
  readonly rows: readonly PhoneSessionRow[]
  readonly counts: PhoneSessionCounts
  /** Pass back as `cursor` for the next, older page; null at the end. */
  readonly next: string | null
}

export type PhoneTeamStage = 'plan' | 'build' | 'review' | 'land'
export type PhoneTeamStatus = 'working' | 'needs-you' | 'ready' | 'done' | 'stopped'

export interface PhoneTeamRow {
  readonly id: string
  /** The Team's sentence, shortened. */
  readonly title: string
  readonly project: string | null
  readonly stage: PhoneTeamStage
  /** Cards finished of cards on the board. */
  readonly progress: { readonly done: number; readonly total: number }
  /** Open seats, and up to three short initials to draw them by. */
  readonly workers: { readonly count: number; readonly initials: readonly string[] }
  readonly cost: number | null
  readonly status: PhoneTeamStatus
  readonly updatedAt: number
}

export interface PhoneTeamsList {
  readonly rows: readonly PhoneTeamRow[]
}

export type PhoneRange = 'today' | '7d' | '30d'

export interface PhoneSeatUsage {
  /** The agent's presentation name, with a number when one agent is signed in more than once. Never an account. */
  readonly label: string
  /** The short window's used percent, 0–100 and not clamped; null when the agent has no such window. */
  readonly windowPercent: number | null
  readonly resetsAt: number | null
  readonly weekPercent: number | null
}

export interface PhoneProjectShare {
  readonly project: string
  readonly spent: number
  /** 0–1 of the range's spend by project. */
  readonly share: number
}

export interface PhoneCostlySession {
  readonly id: string
  readonly title: string
  readonly project: string | null
  /** Lifetime cost of a session touched in the range, not what the range itself spent on it. */
  readonly cost: number
}

export interface PhonePeriod {
  readonly range: PhoneRange
  /** Sessions and Teams that ended in the range; null where the desk cannot say. */
  readonly finished: number | null
  /** The desk does not keep how long a session waited, so this is null today. */
  readonly waitedOnYou: number | null
  /** The desk does not keep rule breaks per range, so this is null today. */
  readonly ruleBreaks: number | null
  readonly spent: number | null
  readonly spentPrevious: number | null
  /** Percent change against the range before it, rounded; null when there is nothing to compare. */
  readonly spentVsPrevious: number | null
  readonly byProject: readonly PhoneProjectShare[]
  readonly mostExpensive: readonly PhoneCostlySession[]
}

export interface PhoneAllowance {
  /** The monthly spending cap the person set on their plans, in dollars. */
  readonly amount: number
  readonly spent: number | null
  readonly resetsAt: number
}

export interface PhoneDashboard {
  readonly today: { readonly spent: number | null }
  /** Null until the person sets a monthly cap on at least one plan. */
  readonly allowance: PhoneAllowance | null
  readonly counts: { readonly running: number; readonly needsYou: number; readonly doneToday: number }
  /** The last seven local days, oldest first. */
  readonly daily: readonly { readonly day: number; readonly spent: number | null }[]
  readonly seats: readonly PhoneSeatUsage[]
  readonly period: PhonePeriod
}
