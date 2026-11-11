import type { LeadStage } from './lead-stage.js'
import type { UsageStandingStatus } from './usage.js'

/** What a paired phone may do. `answer` is the verb that settles a decision for the person. */
export type PhoneTier = 'read' | 'run' | 'answer'

/** How a phone reaches the desk now: on the same network, or through the account's relay. */
export type PhoneRoute = 'nearby' | 'account'

/**
 * The desk's socket to the account relay. `connecting` covers the first few failed tries, so a Mac waking up does not
 * flash a warning; `unreachable` is the warning. `replaced` (another copy of this desk took the room) and `refused`
 * (the account no longer lets this desk in) stop it until the person acts.
 */
export type PhoneRelayState = 'off' | 'connecting' | 'connected' | 'unreachable' | 'replaced' | 'refused'

export interface PhoneDeviceView {
  readonly id: string
  readonly name: string
  readonly tiers: readonly PhoneTier[]
  readonly createdAt: number
  readonly lastSeenAt: number | null
  /** Null while the phone is not connected. */
  readonly route: PhoneRoute | null
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
  readonly relay: PhoneRelayState
  readonly devices: readonly PhoneDeviceView[]
  readonly pending: readonly PhonePendingView[]
}

export interface PhonePairing {
  /** The `harnessdesk://pair?c=…` link the code carries. */
  readonly url: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
  readonly addresses: readonly { readonly host: string; readonly port: number }[]
  /** True when the code also carries an account invite, so a phone away from this network can pair through the relay. */
  readonly away: boolean
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
  /** This agent moves deleted conversations to the Trash. */
  readonly canDelete: boolean
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
  /** When the session began as its agent recorded it, epoch milliseconds; not a measure of work. Left out when the
   * agent records no start (`RuntimeCapabilities.startTimes`) or the time is impossible. */
  readonly startedAt?: number
  readonly archived?: boolean
  /** Host-owned pin shared with the desktop. */
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
 * its words go through `scrubText`, bounded scrubbed command tails and diff hunks reach the paired phone, and a file is
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
  /** The Team's room id, what a Lead `refs` entry of kind `team` names; the item's own `id` is the goal's. */
  readonly roomId: string
  /** The plan step a Lead started this Team for, so two Teams of one goal can be told apart. Left out otherwise. */
  readonly step?: string
  /** The person accepted the Lead's result and this Team is ready to wrap: `workspace/team/wrap` will take it. */
  readonly canWrap?: true
  /** A seat of this Team waits on an approval the Lead puts to the person as its own card; the phone lists it there, once. */
  readonly relayed?: true
}

export interface PhoneWorkItem {
  /** Present for sessions; Teams cannot be deleted here. */
  readonly canDelete?: boolean
  /** A session is "<agent>:<session>", a Team its own id. */
  readonly id: string
  readonly kind: 'session' | 'team'
  readonly title: string
  readonly project?: string
  readonly pinned?: boolean
  /** Archived conversations remain readable. */
  readonly archived?: boolean
  readonly stage: LeadStage
  readonly stageReason: string
  readonly phase: PhoneWorkPhase
  readonly line: string
  readonly agent?: PhoneAgentLabel
  /** Left out for the person themselves. */
  readonly by?: string
  readonly updatedAt: number
  /** When a session began, epoch milliseconds; a Team says it in `team.startedAt`. Left out when unknown. */
  readonly startedAt?: number
  readonly cost?: PhoneMoney
  readonly team?: PhoneWorkTeam
}

export interface PhoneWorkDay {
  readonly label: string
  readonly cost: PhoneMoney
  readonly isToday: boolean
}

/** One window of an allowance, as the phone lists it under the headline. */
export interface PhoneWorkLane {
  readonly label: string
  /** The model or feature the window belongs to; left out for a window the whole account shares. */
  readonly scope?: string
  /** 0–1 left, clamped; left out when the source gave no figure. */
  readonly left?: number
  /** Epoch milliseconds, so the phone counts down to a time rather than reading a string frozen when it was sent. */
  readonly resetsAt?: number
}

export interface PhoneWorkAllowance {
  /** Unique per row: an agent signed in twice sends two ids. */
  readonly id: string
  readonly name: string
  /** 0–1 of the short window used and not clamped; left out when the agent has no such window. */
  readonly used?: number
  /** Kept for phones that read only this; a newer phone counts down to `resetsAt`. */
  readonly resetsIn?: string
  readonly weekUsed?: number
  /** The standing in one word, as the desk's Plans table says it. */
  readonly status?: string
  /**
   * What the desk decided about this account, from the same `usageStandingOf` its own screens read, so the phone
   * and the desk never disagree. Left out by a desk older than this field.
   */
  readonly standing?: UsageStandingStatus
  /** 0–1 left of the window that decides the standing, clamped. */
  readonly left?: number
  /** When the window that decides the standing refills, in epoch milliseconds. */
  readonly resetsAt?: number
  /** When a spent account is back. */
  readonly backAt?: number
  /** When the current rate empties the deciding window, set only while that lands before its reset. */
  readonly runsOutAt?: number
  /** A model or feature that is spent while the account itself still works. */
  readonly scopedOut?: { readonly scope: string; readonly backAt?: number }
  /** Every window under the headline, in the source's order. */
  readonly lanes?: readonly PhoneWorkLane[]
  /** A prepaid balance, negative when it is overdrawn. */
  readonly balance?: { readonly amount: number; readonly unit: string }
  /** The plan's own name ("Max 20×"), when the source says. */
  readonly plan?: string
  /** When the desk read these figures, in epoch milliseconds. */
  readonly readAt?: number
  /** True once the reading is older than its source promises to stay right. */
  readonly stale?: boolean
  /** The source's own error, scrubbed, when the last reading failed; the figures are then the last good ones. */
  readonly problem?: string
  /** Allowance that expires unspent: more than half is left and the window is about to refill. Computed by the desk (`useFirstNote`). */
  readonly useFirst?: true
  /**
   * Another sign-in's figures for this agent, filed apart from its own (`UsageReport.unverified`): an Antigravity
   * account read through the separate `agy` command line. The desk decides nothing on them and neither does the phone;
   * they are drawn under `whose`. Left out when there are none, and by a desk older than this field.
   */
  readonly unverified?: { readonly whose: string; readonly lanes: readonly PhoneWorkLane[]; readonly readAt: number; readonly stale?: true }
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
  readonly rename?: boolean
  readonly archive?: boolean
  readonly pin?: boolean
  readonly delete: boolean
  readonly chooseModel: boolean
  /** More than one agent is listed in `agents`, so a new session can start on another one. */
  readonly chooseAgent: boolean
  readonly choosePermissions: boolean
  readonly attach: boolean
  readonly undo: boolean
  readonly decide: boolean
}

export interface PhoneModelChoice {
  readonly id: string
  readonly name: string
  readonly hint: string
  readonly efforts: readonly ('low' | 'medium' | 'high' | 'extra')[]
  readonly fast: boolean
}

/** An agent a new session can start on: its opaque runtime id (the prefix of a work item's id), the adapter's own name, and its own models. */
export interface PhoneAgentChoice {
  readonly id: string
  readonly name: string
  readonly models: readonly PhoneModelChoice[]
  /** The desk's selected agent, which a start without `agent` uses. */
  readonly default?: true
}

export interface PhoneWorkSnapshot {
  readonly deskName: string
  /** Unambiguous admitted project names accepted by session start, sorted and capped at 50; never paths. */
  readonly projects: readonly string[]
  readonly items: readonly PhoneWorkItem[]
  /** Left out until the desk has scanned its usage once: the phone then says Unknown. */
  readonly usage?: PhoneWorkUsage
  /** The default agent's models, for phones that do not read `agents`. */
  readonly models: readonly PhoneModelChoice[]
  /** Agents ready to start a session on this desk, default first, at most 8. */
  readonly agents?: readonly PhoneAgentChoice[]
  readonly flows: readonly never[]
  readonly commands: readonly never[]
  readonly capabilities: PhoneWorkCapabilities
  readonly threads: readonly never[]
  /**
   * The Lead's work ledger, the same board the desk's Lead rail draws: Needs you, Working, In review, Done. Left out
   * while no Lead runs on the desk. Done and Drop go back through `lead/work/close`.
   */
  readonly work?: import('./lead-work.js').LeadWorkBoard
  /**
   * Off / Observe / Act per proactive kind, the words the person's rules add, and the goal's deadline. Left out while no
   * Lead runs here. The phone changes a mode through `lead/autonomy/set`; the rules are read-only on a phone.
   */
  readonly autonomy?: import('./lead-autonomy.js').LeadAutonomyView
  /** The Lead's memory as the thread needs it. Left out while no Lead runs on the desk. */
  readonly memory?: PhoneLeadMemory
}

/**
 * What the phone draws of the Lead's memory beside the thread: the proposals waiting for Keep, Edit or No (each under
 * the first Lead reply after `afterSeq`, the message revision it was proposed at), and how much is kept. The lists
 * themselves come from `lead/memory/view`; Keep, Edit, No and Forget go back through `lead/memory/change`.
 */
export interface PhoneLeadMemory {
  readonly revision: number
  readonly inbox: readonly import('./lead-memory.js').LeadMemoryCandidate[]
  readonly core: number
  readonly archive: number
  readonly auto: boolean
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
  /** Scrubbed command tail: at most 40 lines, 300 characters per line and 8 KB per step. */
  readonly output: readonly string[]
  readonly exitCode?: number
  readonly seconds?: number
  readonly todos: readonly { readonly text: string; readonly done: boolean; readonly active: boolean }[]
}

export interface PhoneDiffLine {
  readonly kind: 'context' | 'add' | 'remove'
  /** New-file number for context/add, old-file number for remove. */
  readonly number: number
  readonly text: string
}

export interface PhoneDiffHunk {
  readonly header: string
  readonly lines: readonly PhoneDiffLine[]
}

export interface PhoneWorkFileChange {
  readonly path: string
  readonly added: number
  readonly removed: number
  /** Scrubbed hunks: 400 lines per file, 1,500 per turn, 300 characters per line. */
  readonly hunks: readonly PhoneDiffHunk[]
}

export type PhoneApprovalState = 'pending' | 'allowed' | 'allowedForSession' | 'denied'

export type PhoneWorkTurn =
  | { readonly type: 'you'; readonly id: string; readonly text: string; readonly attachments: readonly string[]; readonly lead?: { readonly name: string } }
  | { readonly type: 'agent'; readonly id: string; readonly markdown: string }
  | {
      readonly type: 'work'
      readonly id: string
      /**
       * How long the fold took, in whole seconds. 0 when the desk never
       * measured it — a conversation replayed from the agent's store carries
       * no times — or it took under a second; a reader shows no time then, as
       * the desktop does, rather than "0s".
       */
      readonly seconds: number
      readonly summary: string
      readonly steps: readonly PhoneWorkStep[]
    }
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
  /** Recent activity is retained by the host but is not yet safely saved. */
  readonly historyPending?: boolean
  /** Present only for chats the host records as Lead-managed. */
  readonly leadChatHolder?: 'lead' | 'person'
  readonly id: string
  readonly title: string
  readonly project?: string
  readonly agent: PhoneAgentLabel
  readonly status: 'done' | 'running' | 'asksYou'
  readonly turns: readonly PhoneWorkTurn[]
}

/**
 * One triage decision as the phone lists it, read-only: which mention trigger
 * on which project judged a comment on which thread, what it decided and why,
 * and whether it acted. `excerpt` is the comment's own bounded prose, shown as
 * untrusted text; every other field is a validated scalar or a host-made sentence.
 */
export interface PhoneTriageRow {
  readonly id: string
  readonly trigger: string
  /** The project folder's name, never a path. */
  readonly project: string
  readonly repository: string
  readonly thread: { readonly kind: 'issue' | 'pull-request'; readonly number: number }
  readonly author: string | null
  readonly excerpt: string
  readonly decision: 'accept' | 'ignore' | 'stop' | 'ask'
  readonly reason: string
  readonly by: 'rules' | 'assessment' | 'person'
  /** `observe`: an accept here is "would have accepted", and nothing was opened. */
  readonly mode: 'observe' | 'act'
  readonly acted: boolean
  readonly decidedAt: number
  /** The comment on the forge. */
  readonly url: string
}

/**
 * One armed mention trigger as the phone lists it, read-only: where it watches, its mode on this machine, and who may
 * ask besides the person. Logins are forge names, plain text; `project` is the folder's name, never a path.
 */
export interface PhoneTriageTrigger {
  /** The trigger's id in its project's triggers file; two projects may use the same one. */
  readonly id: string
  readonly project: string
  /** `owner/name` the arm observes, when it has one. */
  readonly repository?: string
  readonly mode: 'observe' | 'act'
  /** Whose comments it takes, in the file's word (`me`, `collaborators`). */
  readonly from?: 'me' | 'collaborators' | 'anyone'
  /** Named people and bots also allowed to ask, at most ten each. */
  readonly people: readonly string[]
  readonly bots: readonly string[]
}

/** At most this many triggers are listed. */
export const PHONE_TRIAGE_TRIGGERS_MAX = 50

export interface PhoneTriageList {
  /** Newest first, across every project on this desk, at most `limit` (default 50, at most 100). */
  readonly rows: readonly PhoneTriageRow[]
  /** The armed mention triggers on this desk, by project then id; empty when none is armed. Absent from an older desk. */
  readonly triggers?: readonly PhoneTriageTrigger[]
}

/**
 * The Lead's live step as the phone draws it. The phone reads it from the `lead` topic, which carries the Lead window
 * projection as the desktop reads it: `activity.step` is the step in plain words (thinking, the desk call in flight or
 * the last one, or writing the reply), the same words the desktop's live line shows. Absent on older desks, where the
 * phone keeps naming the step from `activity.method`.
 */
export type PhoneLeadActivity = NonNullable<import('./lead.js').LeadWindowProjection['activity']>
