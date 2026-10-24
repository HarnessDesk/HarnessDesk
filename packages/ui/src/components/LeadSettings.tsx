import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LEAD_LIMITS, type ClientMethodName, type LeadPermissionPolicy, type LeadSettingsProjection, type LeadSettingsUpdate, type LeadCard } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, FormStack, InlineParts, Input, NativeSelect, Row, Rows, Section, LeadNameChoice, Text } from '../design'

import { useStore } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'
import { leadRefusalText } from './lead-refusals'
import { formatLeadConsentTime } from './lead-consent-time'
import { PERMISSION_LABELS } from './lead-permission-labels'

const modes = { plan: 0, default: 1, manage: 2 }
const effects = { deny: 0, ask: 1, allow: 2 }
export const leadPolicyWidens = (previous: LeadPermissionPolicy, next: LeadPermissionPolicy) => modes[next.mode] > modes[previous.mode] ||
  previous.rules.some(old => !next.rules.some(rule => rule.id === old.id) && old.effect !== 'allow') || next.rules.some(rule => {
    const old = previous.rules.find(old => old.id === rule.id)
    return old ? effects[rule.effect] > effects[old.effect] || rule.method !== old.method || rule.action !== old.action || rule.project !== old.project : rule.effect === 'allow'
  })

export const LeadSettings = ({ settings, expiry, update, onError, error, cards = [], onOpen }: {
  readonly error?: string | null
  readonly settings: LeadSettingsProjection
  readonly expiry: number | null
  readonly update: (value: Omit<LeadSettingsUpdate, 'expectedRevision'>) => Promise<unknown>
  readonly cards?: readonly LeadCard[]
  readonly onOpen: (id: string) => void
  readonly onError: (error: unknown) => void
}) => {
  // Credentials never enter React state. The uncontrolled input is emptied before
  // the single credential request, including on refusal; updates never combine it.
  const key = useRef<HTMLInputElement>(null), busy = useRef(false)
  const [pending, setPending] = useState(false), [remove, setRemove] = useState(false)
  const [editingKey, setEditingKey] = useState(false)
  const [policy, setPolicy] = useState(settings.policy)
  const [dollars, setDollars] = useState(String(settings.caps.usdMicros / 1000000)), [rounds, setRounds] = useState(String(settings.caps.rounds))
  // A widening waits on a card, and a declined one changes nothing: the draft goes back to what holds once the card settles.
  const policyCard = cards.find(card => card.type === 'permission-change')?.id ?? null, capsCard = cards.find(card => card.type === 'budget-change')?.id ?? null
  useEffect(() => { if (!policyCard) setPolicy(settings.policy) }, [settings.policy.revision, policyCard])
  useEffect(() => { if (!capsCard) { setDollars(String(settings.caps.usdMicros / 1000000)); setRounds(String(settings.caps.rounds)) } }, [settings.caps.usdMicros, settings.caps.rounds, capsCard])
  const policyChanged = JSON.stringify({ ...policy, revision: 0 }) !== JSON.stringify({ ...settings.policy, revision: 0 })
  const widening = leadPolicyWidens(settings.policy, policy)
  const micros = Math.round(Number(dollars) * 1000000), roundCount = Number(rounds)
  const validCaps = dollars.trim() !== '' && rounds.trim() !== '' && Number.isSafeInteger(micros) && micros >= 0 && micros <= LEAD_LIMITS.maxUsdMicros && Number.isSafeInteger(roundCount) && roundCount >= 0 && roundCount <= LEAD_LIMITS.rounds
  const capsChanged = micros !== settings.caps.usdMicros || roundCount !== settings.caps.rounds
  const capsWiden = micros > settings.caps.usdMicros || roundCount > settings.caps.rounds
  const submit = async (value: Omit<LeadSettingsUpdate, 'expectedRevision'>, onSuccess?: () => void) => {
    if (busy.current) return
    busy.current = true; setPending(true)
    try { await update(value); onSuccess?.(); setRemove(false) }
    catch (error) { setRemove(false); onError(error) }
    finally { busy.current = false; setPending(false) }
  }
  const credential = () => {
    if (busy.current || !key.current?.value.trim()) return
    const value = key.current.value.trim(); key.current.value = ''
    void submit({ credential: { provider: 'anthropic', key: value } }, () => setEditingKey(false))
  }
  const waiting = (type: LeadCard['type']) => { const card = cards.find(card => card.type === type); return card ? <Row title="Waiting for your approval in the conversation" control={<Button variant="outline" onClick={() => onOpen(card.id)}>Open</Button>} /> : null }
  return <>
      {error && <Banner role="alert" tone="warning">{error}</Banner>}
      <Section title="Who runs your desk"><LeadNameChoice value={settings.name} pending={pending} onChange={name => void submit({ name })} /><Text as="p" role="muted">Only the name and the look differ.</Text></Section>
      <Section title="Provider key">
      <Rows>
        <Row title="Key" titleChip={<Chip tone="neutral">{settings.key.configured ? 'Configured' : 'Not set'}</Chip>} control={<InlineParts>
          {editingKey ? <><Input ref={key} aria-label="Provider key" type="password" autoComplete="new-password" disabled={pending} /><Button disabled={pending || settings.key.protection !== 'encrypted'} aria-busy={pending} onClick={credential}>Save</Button><Button variant="quiet" disabled={pending} onClick={() => { if (key.current) key.current.value = ''; setEditingKey(false) }}>Cancel</Button></>
            : <Button variant="outline" disabled={pending} onClick={() => setEditingKey(true)}>{settings.key.configured ? 'Replace…' : 'Add…'}</Button>}
          {settings.key.configured && <Button variant="destructive" disabled={pending} onClick={() => setRemove(true)}>Remove</Button>}
        </InlineParts>} />
        <Row title="Model" desc={settings.model} />
      </Rows>
      {settings.key.protection !== 'encrypted' && <Banner>Encrypted key storage is unavailable.</Banner>}
      </Section>
      <Section title="Allowances">
      <Rows>
        <Row title="Dollar allowance" desc={capsWiden ? 'Asks for your approval in the conversation.' : 'Tightening applies at once. Stops when reported spend reaches the cap.'} control={<Input aria-label="Dollar allowance" type="number" min={0} step="0.000001" value={dollars} disabled={pending} onChange={event => setDollars(event.target.value)} />} />
        <Row title="Round allowance" control={<Input aria-label="Round allowance" type="number" min={0} max={LEAD_LIMITS.rounds} step={1} value={rounds} disabled={pending} onChange={event => setRounds(event.target.value)} />} />
        {expiry !== null && <Row title="Plan consent expires" desc={formatLeadConsentTime(expiry)} />}
      </Rows>
      <Row title={null} control={<Button disabled={pending || !validCaps || !capsChanged} aria-busy={pending} onClick={() => void submit({ caps: { usdMicros: micros, rounds: roundCount } })}>Save allowances</Button>} />
      {waiting('budget-change')}
      </Section>
      <Section title="Permissions">
      <Rows>
        <Row title="Permission mode" desc={widening ? 'Asks for your approval in the conversation.' : 'Tightening applies at once.'} control={<NativeSelect aria-label="Permission mode" value={policy.mode} disabled={pending} onChange={event => setPolicy({ ...policy, mode: event.target.value as LeadPermissionPolicy['mode'] })}><option value="plan">Plan</option><option value="default">Default</option><option value="manage">Manage</option></NativeSelect>} />
        {policy.rules.map((rule, index) => <Row key={rule.id} title={`Rule ${index + 1}`} desc={<FormStack>
          <NativeSelect aria-label={`Rule ${index + 1} effect`} value={rule.effect} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, effect: event.target.value as typeof rule.effect } : one) })}>{(['allow', 'ask', 'deny'] as const).map(effect => <option key={effect} value={effect}>{effect}</option>)}</NativeSelect>
          <NativeSelect aria-label={`Rule ${index + 1} method`} value={rule.method} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, method: event.target.value as ClientMethodName } : one) })}>{(Object.keys(PERMISSION_LABELS) as ClientMethodName[]).map(method => <option key={method} value={method} title={method}>{PERMISSION_LABELS[method]}</option>)}</NativeSelect>
          <Input aria-label={`Rule ${index + 1} action`} placeholder="All actions" value={rule.action ?? ''} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, action: event.target.value || null } : one) })} />
          <Input aria-label={`Rule ${index + 1} project`} placeholder="Approved project" value={rule.project ?? ''} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, project: event.target.value || null } : one) })} />
        </FormStack>} control={<Button variant="quiet" disabled={pending} onClick={() => setPolicy({ ...policy, rules: policy.rules.filter(one => one.id !== rule.id) })}>Remove rule</Button>} />)}
        <Row title="Rules" control={<Button variant="outline" disabled={pending || policy.rules.length >= LEAD_LIMITS.rules} onClick={() => setPolicy({ ...policy, rules: [...policy.rules, { id: crypto.randomUUID(), effect: 'ask', method: 'flow/start-goal', action: null, project: null }] })}>Add rule</Button>} />
      </Rows>
      <Row title={null} control={<Button disabled={pending || !policyChanged} aria-busy={pending} onClick={() => void submit({ policy: { ...policy, revision: settings.policy.revision + 1 } })}>Save permissions</Button>} />
      {waiting('permission-change')}
      </Section>

    {remove && <ConfirmDialog title="Remove Lead key?" confirmLabel="Remove key" cancelLabel="Keep key" tone="destructive" busy={pending} onConfirm={() => void submit({ credential: { provider: 'anthropic', key: null } })} onCancel={() => setRemove(false)}><Text role="prose">Removes the saved provider key and stops paid Lead requests.</Text></ConfirmDialog>}
  </>
}


/** Settings owns this route; the capability gate prevents mounting it while disabled. */
export const LeadSettingsSection = () => {
  const store = useStore(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (active) void store.lead.readSettings().catch(error => setError(leadRefusalText(error))) }, [active, store])
  return state.settings ? <LeadSettings settings={state.settings} expiry={state.planConsentExpiresAt} cards={state.thread?.cards}
    error={error} onError={error => setError(leadRefusalText(error))} update={value => { setError(null); return store.lead.updateSettings(value) }}
    onOpen={focus => store.openDestination({ kind: 'lead', focus })} /> : error ? <Banner role="alert" tone="warning">{error}</Banner> : null
}
