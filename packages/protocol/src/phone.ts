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

/**
 * The workspace a paired phone ships knowing: one read-only snapshot (`workspace/read`), a session's conversation
 * (`workspace/thread/read`) and the one action a phone may take on it so far (`workspace/approval/decide`). The
 * shapes follow what the phone decodes, field for field, so a name or a unit here is the phone's own.
 *
 * It is the same redacted view as the `phone/*` projections above, with two differences made on purpose. Money is
 * integer micro-dollars (`{ micros }`), the unit the phone's own `Money` decodes. And a conversation is readable:
 * its words go through `scrubText`, a command's output and a change's lines never leave the desk, and a file is
 * named by its path inside the project, never by one on this machine.
 */

export interface PhoneMoney {
  readonly micros: number
}

/** Who ran it, as the desk presents the agent; `model` only where the desk knows it. */
export interface PhoneAgentLabel {
  readonly name: string
  readonly model?: string
}

export type PhoneWorkPhase = 'running' | 'needsYou' | 'watching' | 'done'

export interface PhoneWorkWorker {
  readonly id: string
  readonly title: string
  readonly seat: PhoneAgentLabel
  readonly status: 'running' | 'done' | 'waiting' | 'failed'
  readonly cost: PhoneMoney
}

export interface PhoneWorkTeam {
  readonly stage: PhoneTeamStage
  readonly stageNote?: string
  readonly startedAt: number
  readonly planApprovedAt?: number
  readonly workers: readonly PhoneWorkWorker[]
  readonly reviewers: number
  readonly spent: PhoneMoney
}

export interface PhoneWorkItem {
  /** A session is "<agent>:<session>", a Team its own id. */
  readonly id: string
  readonly kind: 'session' | 'team'
  readonly title: string
  readonly project?: string
  readonly phase: PhoneWorkPhase
  readonly line: string
  readonly agent?: PhoneAgentLabel
  /** Left out for the person themselves. */
  readonly by?: string
  readonly updatedAt: number
  readonly cost?: PhoneMoney
  readonly team?: PhoneWorkTeam
}

export interface PhoneWorkDay {
  readonly label: string
  readonly cost: PhoneMoney
  readonly isToday: boolean
}

export interface PhoneWorkAllowance {
  readonly id: string
  readonly name: string
  /** 0–1 of the short window used and not clamped; left out when the agent has no such window. */
  readonly used?: number
  readonly resetsIn?: string
  readonly weekUsed?: number
  readonly status?: string
  readonly models: readonly string[]
  /** Never an account: the phone shows none, so the desk sends none. */
  readonly running: readonly string[]
  readonly last7: readonly PhoneMoney[]
}

export interface PhoneWorkPeriod {
  readonly finished: number
  /**
   * How often the desk needed the person, and how many rules were broken. Left out when the desk has no source for
   * them: the phone shows a missing count as unknown, and a 0 would read as a fact.
   */
  readonly needed?: number
  readonly ruleBreaks?: number
  readonly spent: PhoneMoney
  /** A fraction against the period before: -0.12 is 12% less. Left out when there is nothing to compare. */
  readonly change?: number
  readonly slices: readonly { readonly label: string; readonly cost: PhoneMoney }[]
  readonly byProject: readonly { readonly name: string; readonly cost: PhoneMoney }[]
  readonly mostExpensive: readonly { readonly title: string; readonly project?: string; readonly cost: PhoneMoney }[]
}

export interface PhoneWorkUsage {
  readonly spentToday: PhoneMoney
  /** The desk has no daily allowance; left out. The monthly cap is in `phone/dashboard/read`. */
  readonly dailyCap?: PhoneMoney
  readonly resetsAt?: string
  readonly days: readonly PhoneWorkDay[]
  readonly runtimes: readonly PhoneWorkAllowance[]
  readonly week: PhoneWorkPeriod
  readonly month: PhoneWorkPeriod
}

/** Which controls the desk honours. A control it cannot is left out of the phone's screens. */
export interface PhoneWorkCapabilities {
  readonly startSession: boolean
  readonly startTeam: boolean
  readonly reply: boolean
  readonly stop: boolean
  readonly delete: boolean
  readonly chooseModel: boolean
  readonly choosePermissions: boolean
  readonly attach: boolean
  readonly undo: boolean
  readonly decide: boolean
}

export interface PhoneWorkSnapshot {
  readonly deskName: string
  readonly items: readonly PhoneWorkItem[]
  /** Left out until the desk has scanned its usage once: the phone then says Unknown. */
  readonly usage?: PhoneWorkUsage
  readonly models: readonly never[]
  readonly flows: readonly never[]
  readonly commands: readonly never[]
  readonly capabilities: PhoneWorkCapabilities
  readonly threads: readonly never[]
}

export interface PhoneWorkStep {
  readonly id: string
  readonly kind: 'thought' | 'read' | 'todo' | 'edit' | 'run' | 'search' | 'agent'
  readonly title: string
  readonly detail?: string
  readonly files: readonly string[]
  readonly added?: number
  readonly removed?: number
  readonly failed: boolean
  /** Always empty: a command's output stays on the desk. */
  readonly output: readonly string[]
  readonly exitCode?: number
  readonly seconds?: number
  readonly todos: readonly { readonly text: string; readonly done: boolean; readonly active: boolean }[]
}

export interface PhoneWorkFileChange {
  readonly path: string
  readonly added: number
  readonly removed: number
  /** Always empty: the lines of a change are file contents. */
  readonly hunks: readonly never[]
}

export type PhoneApprovalState = 'pending' | 'allowed' | 'allowedForSession' | 'denied'

export type PhoneWorkTurn =
  | { readonly type: 'you'; readonly id: string; readonly text: string; readonly attachments: readonly string[] }
  | { readonly type: 'agent'; readonly id: string; readonly markdown: string }
  | { readonly type: 'work'; readonly id: string; readonly seconds: number; readonly summary: string; readonly steps: readonly PhoneWorkStep[] }
  | { readonly type: 'changes'; readonly id: string; readonly files: readonly PhoneWorkFileChange[] }
  | {
      readonly type: 'approval'
      readonly id: string
      readonly title: string
      readonly who: string
      readonly command: string
      readonly why: string
      readonly highRisk: boolean
      readonly state: PhoneApprovalState
      /** The desk's own words for allowing until the session ends; present only where the approval offers that. */
      readonly sessionGrant?: string
    }

export interface PhoneWorkThread {
  readonly id: string
  readonly title: string
  readonly project?: string
  readonly agent: PhoneAgentLabel
  readonly status: 'done' | 'running' | 'asksYou'
  readonly turns: readonly PhoneWorkTurn[]
}
