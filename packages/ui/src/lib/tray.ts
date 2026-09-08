import type { AccountStatus, RuntimeHealth, RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import { brandForRuntime } from './brands'
import type { TrayAgent, TraySummary } from './desktop'
import { READINESS_LABEL, readinessOf } from './readiness'
import { describeReport, workingAccount } from './usage'

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
  readonly health: RuntimeHealth | null
  readonly activeRuntime: RuntimeId | null
  readonly now: number
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

const agentOf = (info: RuntimeInfo, input: TrayInput, names: ReadonlyMap<string, number>): TrayAgent => {
  const reports = input.usage.filter((report) => report.runtime === info.id)
  const state = readinessOf({
    registered: true,
    health: info.id === input.activeRuntime ? input.health : null,
    account: input.accountsByRuntime[info.id],
    usage: reports,
  })
  // The account that decides, by the strip's own rule, so the status item and
  // the header cannot disagree about an agent: signed in to two, the one with
  // most left is the one a turn would use — and taking the first report that
  // arrived instead put whichever account raced in ahead on the menu bar.
  const report = workingAccount(reports)
  const lane = report ? describeReport(report, { now: input.now, maxLanes: 1 }).hero : null
  const left = lane?.known && lane.remainingPercent !== null ? lane.remainingPercent : null
  const name = info.presentation.name
  // The account goes in front of the em dash, where the row says who it is —
  // the same side of the sentence the strip puts it on, and the side a menu
  // is read from. Nothing to say when the reading carries no account.
  const account = (names.get(name) ?? 0) > 1 ? (report?.account ?? null) : null
  return {
    id: info.id,
    name: account === null ? name : `${name} · ${account}`,
    detail:
      left !== null
        ? `${left}% left${lane?.shortCountdown ? `, resets in ${lane.shortCountdown}` : ''}`
        : READINESS_LABEL[state],
    needsSignIn: state === 'signin',
    brand: brandForRuntime(info),
    left,
  }
}

export const describeTray = (input: TrayInput): TraySummary => {
  const names = nameCounts(input)
  const agents = input.runtimes.map((info) => agentOf(info, input, names))
  const figures = agents.map((agent) => agent.left).filter((left): left is number => left !== null)
  return {
    // The menu bar gets the agent with least left: the one figure worth two
    // characters of a row everything else in the system is also competing for.
    title: figures.length > 0 ? `${Math.min(...figures)}%` : '',
    agents,
  }
}
