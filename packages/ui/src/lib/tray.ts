import type { AccountStatus, RuntimeHealth, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { brandForRuntime } from './brands'
import { isDesktop, setTraySummary, type TrayAgent, type TraySummary } from './desktop'
import { prefsForUsage, shownAccountLabel } from './accounts'
import { READINESS_LABEL, readinessOf } from './readiness'
import { describeReport, workingAccount, type UsagePreference } from './usage'

/**
 * What the menu bar says with no window open.
 *
 * The status item is the app when nothing is on screen, so it has to answer
 * the question the header strip answers — *is the agent I am about to use
 * still working?* — from the same arithmetic. A pure function of the snapshot
 * and a clock: the shell draws it and decides nothing, exactly as `PlanMeters`
 * draws the strip and decides nothing.
 */

export interface TrayInput {
  readonly runtimes: readonly RuntimeInfo[]
  readonly usage: readonly UsageReport[]
  readonly accountsByRuntime: Readonly<Partial<Record<RuntimeId, AccountStatus>>>
  readonly accountPrefs: Readonly<Record<string, UsagePreference>>
  readonly health: RuntimeHealth | null
  readonly activeRuntime: RuntimeId | null
  readonly now: number
  /** Settings › General › Hide account addresses: accounts by name only. */
  readonly hideAddresses?: boolean
}

/** Own the complete timer lifetime without retaining the App render snapshot. */
export const startTrayUpdates = (input: Omit<TrayInput, 'now'>): (() => void) | undefined => {
  if (!isDesktop()) return
  const send = (): void => setTraySummary(describeTray({ ...input, now: Date.now() }))
  send()
  // Countdown labels need a fresh clock even when no tray data changes.
  const timer = window.setInterval(send, 60_000)
  return () => window.clearInterval(timer)
}


/**
 * A name says which agent only while it is the agent's alone.
 *
 * The header strip's rule, kept here so the two surfaces name the roster the
 * same way. The case that bites is the multi-account symlink farm: each Codex
 * account is registered as its own runtime, so the roster holds two agents
 * both called "OpenAI Codex", and neither row can tell that from where it
 * sits. A second account under one runtime is the same problem seen from the
 * other side — the row shows one reading of several, and which one is worth
 * saying. So a name is counted against every reading the roster holds under
 * it, and the account is named only where that count is more than one: the
 * single-account setup, which is nearly every setup, is untouched.
 */
const nameCounts = (input: TrayInput): ReadonlyMap<string, number> => {
  const names = new Map<string, number>()
  for (const info of input.runtimes) {
    const name = info.presentation.name
    // A row per agent, and a row's worth per account past the first.
    const readings = Math.max(1, input.usage.filter((report) => report.runtime === info.id).length)
    names.set(name, (names.get(name) ?? 0) + readings)
  }
  return names
}

interface Described {
  readonly agent: TrayAgent
  /** When the agent is back, in the strip's short form; null when no reset is known. */
  readonly countdown: string | null
}

const describeAgent = (info: RuntimeInfo, input: TrayInput, names: ReadonlyMap<string, number>): Described => {
  const reports = input.usage.filter((report) => report.runtime === info.id)
  const state = readinessOf({
    registered: true,
    health: info.id === input.activeRuntime ? input.health : null,
    account: input.accountsByRuntime[info.id],
    accounts: info.capabilities.account,
    usage: reports,
  })
  // The account that decides, by the strip's own rule, so the status item and
  // the header cannot disagree about an agent: signed in to two, the one with
  // most left is the one a turn would use — and taking the first report that
  // arrived instead put whichever account raced in ahead on the menu bar.
  const preferenceFor = (report: UsageReport): UsagePreference =>
    prefsForUsage(report.runtime, report.account, input.accountsByRuntime, input.accountPrefs) ?? {}
  const report = workingAccount(reports, preferenceFor)
  const lane = report ? describeReport(report, { now: input.now, maxLanes: 1, preference: preferenceFor(report) }).hero : null
  const left = lane?.known && lane.remainingPercent !== null ? lane.remainingPercent : null
  const name = info.presentation.name
  // The account goes in front of the em dash, where the row says who it is —
  // the same side of the sentence the strip puts it on, and the side a menu
  // is read from. Nothing to say when the reading carries no account.
  const account = (names.get(name) ?? 0) > 1 && report?.account
    ? shownAccountLabel(report.runtime, report.account, { ...input, hideAccountAddresses: input.hideAddresses })
    : null
  return {
    agent: {
      id: info.id,
      name: account === null ? name : `${name} · ${account}`,
      detail:
        left !== null
          ? `${left}% left${lane?.shortCountdown ? `, resets in ${lane.shortCountdown}` : ''}`
          : READINESS_LABEL[state],
      needsSignIn: state === 'signin',
      current: info.id === input.activeRuntime,
      brand: brandForRuntime(info),
      left,
    },
    countdown: lane?.shortCountdown ?? null,
  }
}

/**
 * The menu bar speaks for one agent: the one the next Send goes to, which is
 * the header strip's anchor. It used to carry the least left across the whole
 * roster, which pinned it to an agent you were not using — one plan spent for
 * three weeks read 0% for three weeks. An agent that is out says when it is
 * back rather than 0%, since that is the one fact a spent plan leaves you to
 * act on; no reading, or a sign-in still to do, leaves the mark on its own.
 */
const titleOf = (current: Described | undefined): string => {
  const left = current && !current.agent.needsSignIn ? current.agent.left : null
  if (left === null) return ''
  if (left === 0 && current?.countdown) return `↻${current.countdown}`
  return `${left}%`
}

export const describeTray = (input: TrayInput): TraySummary => {
  const names = nameCounts(input)
  const described = input.runtimes.map((info) => describeAgent(info, input, names))
  const current = described.find((one) => one.agent.current)
  return {
    title: titleOf(current),
    tooltip: current ? `${current.agent.name} — ${current.agent.detail}` : 'HarnessDesk',
    agents: described.map((one) => one.agent),
  }
}
