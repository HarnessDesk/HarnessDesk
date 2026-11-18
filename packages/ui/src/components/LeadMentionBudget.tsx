import { useEffect, useState } from 'react'
import type { MentionObserverBudgetView } from '@harnessdesk/protocol'
import { Banner, Button, Input, Row, Rows, Section, Text } from '../design'
import { useDestinationActive } from '../panels/destination-page'
import { useStore } from '../state/context'

/** The person explicitly chooses the independent daily funding for mention assessments. */
export const LeadMentionBudget = () => {
  const store = useStore(), active = useDestinationActive()
  const [view, setView] = useState<MentionObserverBudgetView | null>(null)
  const [amount, setAmount] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (active) void store.lead.readMentionBudget().then(next => { setView(next); setAmount(next.enabled ? String(next.dailyCapUsdMicros / 1000000) : '') }, () => setError('Mention assessment budget settings are unavailable. Older desk versions do not provide them.'))
  }, [active, store])
  const micros = Math.round(Number(amount) * 1000000)
  const save = async (cap: number) => {
    setPending(true); setError(null)
    try { const next = await store.lead.configureMentionBudget(cap); setView(next); setAmount(next.enabled ? String(next.dailyCapUsdMicros / 1000000) : '') }
    catch { setError('The mention assessment budget could not be saved.') }
    finally { setPending(false) }
  }
  const money = (value: number) => `$${(value / 1000000).toFixed(6)}`
  return <Section title="Mention assessments">
    {!view ? <Text role="muted">{error ?? 'Loading…'}</Text> : <>
      <Rows>
        <Row title="Daily budget" desc={view.enabled ? `${money(view.dailyCapUsdMicros)} per day` : 'Off. Mentions wait for your decision until you choose a daily amount.'} />
        <Row title="Daily amount in dollars" control={<Input aria-label="Mention assessment daily amount" type="number" min="0.000001" step="0.000001" value={amount} onChange={event => setAmount(event.target.value)} disabled={pending} />} />
        <Row title="Budget day" desc={`${view.day} (local)`} />
        <Row title="Known spend" desc={money(view.spentUsdMicros)} />
        <Row title="Held" desc={money(view.reservedUsdMicros)} />
        <Row title="Unconfirmed" desc={money(view.uncertainUsdMicros)} />
        <Row title="Remaining" desc={money(view.remainingUsdMicros)} />
      </Rows>
      <Row title={null} control={<><Button disabled={pending || !amount.trim() || !Number.isSafeInteger(micros) || micros < 1} onClick={() => void save(micros)}>Save daily budget</Button>{view.enabled && <Button variant="outline" disabled={pending} onClick={() => void save(0)}>Turn off</Button>}</>} />
      {view.problem && <Banner role="alert" tone="warning">{view.problem}</Banner>}
      {error && <Text role="muted">{error}</Text>}
    </>}
  </Section>
}
