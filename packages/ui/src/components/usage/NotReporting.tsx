import type { RuntimeId, RuntimeInfo, UsageReport } from '@harnessdesk/protocol'

import type { SilentAgent } from './shared'
import { Button, Row, Rows, SectionHead } from '../../design'
import { RuntimeMark } from '../BrandIcons'

/**
 * One row per agent that reports nothing at all: the reason, and the one fix
 * — a button where the person can act, otherwise a word. Two populations feed
 * it, and both read the same way here:
 *
 * - a `silentAgentsOf` entry: a tracked agent that has never answered
 *   `runtime/account` — the fix is signing in.
 * - a report whose own `primaryShapeOf` is `'none'` — an account that
 *   answered, but with no billing shape and no lanes at all — the fix is a
 *   refresh, in case the source simply has not caught up yet.
 */
export interface NotReportingEntry {
  readonly key: string
  readonly info: RuntimeInfo
  readonly title: string
  readonly reason: string
  readonly fix: { readonly label: string; readonly onClick: () => void } | null
}

export const entriesFromSilent = (silent: readonly SilentAgent[], onSignIn?: (runtime: RuntimeId) => void): readonly NotReportingEntry[] =>
  silent.map((agent) => ({
    key: `silent:${agent.info.id}`,
    info: agent.info,
    title: `${agent.info.presentation.name} has nothing to report`,
    reason: agent.reason,
    fix: onSignIn ? { label: `Sign in to ${agent.info.presentation.name}`, onClick: () => onSignIn(agent.info.id) } : null,
  }))

export const entriesFromReports = (
  reports: readonly UsageReport[],
  byId: ReadonlyMap<RuntimeId, RuntimeInfo>,
  onRefreshAccount: (runtime: RuntimeId) => void,
): readonly NotReportingEntry[] =>
  reports.flatMap((report) => {
    const info = byId.get(report.runtime)
    if (!info) return []
    return [
      {
        key: `${report.runtime}:${report.account ?? ''}`,
        info,
        title: report.account ?? info.presentation.name,
        reason: 'This agent reports no plan usage here.',
        fix: { label: 'Refresh', onClick: () => onRefreshAccount(report.runtime) },
      },
    ]
  })

export const NotReportingList = ({ entries }: { entries: readonly NotReportingEntry[] }) => {
  if (entries.length === 0) return null
  return (
    <>
      <SectionHead level="heading" name="Not reporting" />
      <Rows>
        {entries.map((entry) => (
          <Row
            key={entry.key}
            mark={<RuntimeMark runtime={entry.info} size={16} />}
            title={entry.title}
            desc={entry.reason}
            control={
              entry.fix ? (
                <Button variant="outline" size="sm" onClick={entry.fix.onClick}>
                  {entry.fix.label}
                </Button>
              ) : undefined
            }
          />
        ))}
      </Rows>
    </>
  )
}
