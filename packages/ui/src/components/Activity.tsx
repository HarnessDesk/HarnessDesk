import { useEffect, useMemo, useState } from 'react'

import { useSnapshot, useStore } from '../state/context'
import type { AuditRow } from '../state/store'
import { RuntimeMark } from './BrandIcons'
import type { ReportFoot } from './Details'
import { AlertIcon, CheckIcon, SessionIcon, ShieldIcon, ZapIcon } from './Icons'
import { kit } from '../design/primitives/Kit'
import { DayLabel, PanelEmpty, PanelRow, RowTime } from './Panel'

/**
 * The audit view: what every agent did in this repository this week,
 * whichever vendor made it. Read-only on purpose — an audit log that can be
 * edited from the interface it audits is not an audit log.
 *
 * A row is a sentence about something that happened, and the agent that did
 * it wears its own mark. No ring: these rows are about agents, and a ring is
 * how an account is told from another account.
 */

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const dayOf = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })

/** The glyph for what happened: a session began, a turn ended, a request was answered — by a person or by a rule. */
const iconOf = (row: AuditRow) => {
  switch (row.kind) {
    case 'session/started':
      return <SessionIcon size={12} />
    case 'turn/completed':
      return row.status === 'completed' ? <CheckIcon size={12} /> : <AlertIcon size={12} />
    case 'approval/decided':
      return <ShieldIcon size={12} />
    case 'approval/autoDecided':
      return <ZapIcon size={12} />
    case 'library/write':
      return row.status === 'failed' ? <AlertIcon size={12} /> : <CheckIcon size={12} />
    default:
      return null
  }
}

/** "skill/create" → "Installed", etc. — the audit's op string in plain words. */
const LIBRARY_VERB: Readonly<Record<string, string>> = {
  'skill/create': 'Installed',
  'skill/update': 'Updated',
  'skill/replace': 'Replaced a copy of',
  'skill/remove': 'Removed a copy of',
  'mcp/create': 'Added',
  'mcp/update': 'Updated',
  'mcp/replace': 'Replaced',
  'mcp/remove': 'Removed',
}

const describe = (row: AuditRow): string => {
  switch (row.kind) {
    case 'session/started':
      return 'Started a session'
    case 'turn/completed': {
      const steps = row.steps ? `${row.steps} step${row.steps === 1 ? '' : 's'}` : 'no steps'
      const took = row.durationMs ? ` in ${(row.durationMs / 1000).toFixed(1)}s` : ''
      return row.status === 'completed'
        ? `Finished a turn — ${steps}${took}`
        : `Turn ${row.status ?? 'ended'} — ${steps}${took}`
    }
    case 'approval/decided':
      return `Approval answered: ${row.decision ?? 'decided'}`
    case 'approval/autoDecided':
      return `${row.decision === 'approve' ? 'Approved' : 'Denied'} by policy rule “${row.rule}”`
    case 'library/write': {
      const verb = (row.op && LIBRARY_VERB[row.op]) ?? 'Changed'
      const what = `${verb} ${row.name ?? 'a library item'}`
      return row.status === 'failed' ? `Failed: ${what}${row.detail ? ` — ${row.detail}` : ''}` : what
    }
    default:
      return row.kind
  }
}

export const Activity = ({ query, onFoot }: { query: string; onFoot: ReportFoot }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [rows, setRows] = useState<readonly AuditRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void store.loadAudit().then((loaded) => {
      if (!cancelled) setRows(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [store, snapshot.workspace?.path])

  const infoOf = (runtime: string) =>
    snapshot.runtimes.find((entry) => entry.id === runtime) ?? null
  const nameOf = (runtime: string): string => infoOf(runtime)?.presentation.name ?? runtime

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      (rows ?? []).filter(
        (row) =>
          needle.length === 0 ||
          describe(row).toLowerCase().includes(needle) ||
          nameOf(row.runtime).toLowerCase().includes(needle),
      ),
    // `nameOf` reads the runtime list, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, needle, snapshot.runtimes],
  )

  const byDay = useMemo(() => {
    const groups = new Map<string, AuditRow[]>()
    for (const row of shown) {
      const key = dayOf(row.at)
      const list = groups.get(key)
      if (list) list.push(row)
      else groups.set(key, [row])
    }
    return [...groups.entries()]
  }, [shown])

  const sessions = useMemo(
    () => new Set((rows ?? []).filter((row) => row.kind === 'session/started').map((row) => row.at))
      .size,
    [rows],
  )

  useEffect(() => {
    onFoot(
      `${shown.length} event${shown.length === 1 ? '' : 's'}`,
      sessions > 0
        ? `${sessions} session${sessions === 1 ? '' : 's'}`
        : (snapshot.workspace?.name ?? ''),
    )
  }, [shown.length, sessions, snapshot.workspace?.name, onFoot])

  if (rows === null) return <PanelEmpty>Loading…</PanelEmpty>
  if (rows.length === 0) {
    return <PanelEmpty>Nothing recorded yet. Activity appears here as agents work.</PanelEmpty>
  }
  if (shown.length === 0) return <PanelEmpty>Nothing matches that filter.</PanelEmpty>

  return (
    <>
      {byDay.map(([day, entries]) => (
        <div key={day}>
          <DayLabel>{day}</DayLabel>
          {entries.map((row, index) => {
            const info = infoOf(row.runtime)
            return (
              <PanelRow
                key={`${row.at}-${index}`}
                mark={
                  <span className={`${kit.avatar} ${kit.avatarSm}`}>
                    {info ? <RuntimeMark runtime={info} size={12} /> : iconOf(row)}
                  </span>
                }
                title={describe(row)}
                sub={nameOf(row.runtime)}
                trail={<RowTime>{timeOf(row.at)}</RowTime>}
                tall
              />
            )
          })}
        </div>
      ))}
    </>
  )
}
