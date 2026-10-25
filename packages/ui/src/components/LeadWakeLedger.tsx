import { useEffect, useState } from 'react'
import type { LeadWakeRecord } from '@harnessdesk/protocol'
import { Button, Row, Rows, Text } from '../design'
import { leadDollars } from './LeadCards'

const decision = { silent: 'stayed silent', spoke: 'spoke', asked: 'asked' }
const source = { schedule: 'schedule', 'desk-change': 'desk change', person: 'person', trigger: 'trigger' }
const relative = (at: number, now: number) => { const minutes = Math.max(0, Math.floor((now - at) / 60_000)); return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago` }

/** One line per journaled wake. Collapsed keeps the latest; details are native titles. */
export const LeadWakeLedger = ({ wakes }: { readonly wakes: readonly LeadWakeRecord[] }) => {
  const [expanded, setExpanded] = useState(false), [now, setNow] = useState(Date.now)
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  if (!wakes.length) return null
  const latest = [...wakes].reverse(), rows = expanded ? latest : latest.slice(0, 1)
  return <section aria-label="Wake ledger">
    <Button variant="quiet" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse wake ledger' : 'Wake ledger'}</Button>
    <Rows>{rows.map(wake => <Row key={wake.id} data-wake-row title={<Text as="div" role="meta" truncate title={`${new Date(wake.at).toLocaleString()} · ${source[wake.source]} · ${decision[wake.decision]}${wake.modelTurn ? ` · ${wake.usdMicros === null ? 'Cost unknown' : leadDollars(wake.usdMicros)}` : ''}`}>
      <time title={new Date(wake.at).toLocaleString()} dateTime={new Date(wake.at).toISOString()}>{relative(wake.at, now)}</time>
      {' · '}{source[wake.source]}{' · '}{decision[wake.decision]}
      {wake.modelTurn && ` · ${wake.usdMicros === null ? 'Cost unknown' : leadDollars(wake.usdMicros)}`}
    </Text>} />)}</Rows>
  </section>
}
