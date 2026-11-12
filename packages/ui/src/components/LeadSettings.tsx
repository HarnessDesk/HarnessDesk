import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { focusWhenDrawn } from '../lib/focus-when-drawn'
import { LEAD_LIMITS, leadNoSpendLimit, type ClientMethodName, type LeadWindowProjection, type LeadPermissionPolicy, type LeadSettingsProjection, type LeadSettingsUpdate, type LeadCard } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, FormStack, InlineParts, Input, NativeSelect, Row, Rows, Section, LeadNameChoice, Switch, Text } from '../design'

import { useStore } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'
import { leadRefusalText } from './lead-refusals'
import { formatLeadConsentTime } from './lead-consent-time'
import { PERMISSION_LABELS } from './lead-permission-labels'
import { LeadTriggerSettings } from './LeadTriggerSettings'
import { LeadPlanSettingsSection } from './LeadPlanSettings'
import { LeadContextSection } from './LeadCheckpoint'
import { LeadBriefSettingsSection } from './LeadBriefSettings'
import { LeadMemorySection } from './LeadMemory'
import { LeadAutonomySection } from './LeadAutonomySettings'
import { LeadRulesSection } from './LeadRulesSettings'

const modes = { plan: 0, default: 1, manage: 2 }
const effects = { deny: 0, ask: 1, allow: 2 }
export const leadPolicyWidens = (previous: LeadPermissionPolicy, next: LeadPermissionPolicy) => modes[next.mode] > modes[previous.mode] ||
  previous.rules.some(old => !next.rules.some(rule => rule.id === old.id) && old.effect !== 'allow') || next.rules.some(rule => {
    const old = previous.rules.find(old => old.id === rule.id)
    return old ? effects[rule.effect] > effects[old.effect] || rule.method !== old.method || rule.action !== old.action || rule.project !== old.project : rule.effect === 'allow'
  })

/** The person's standing money limit, or null for Off. A desk that has not recorded one reads it from the goal's cap. */
const spendLimitOf = (settings: LeadSettingsProjection): number | null => settings.spendLimitUsdMicros !== undefined ? settings.spendLimitUsdMicros
  : leadNoSpendLimit(settings.caps.usdMicros) ? null : settings.caps.usdMicros

export const LeadSettings = ({ settings, expiry, update, setSpendLimit, onError, error, cards = [], onOpen }: {
  readonly error?: string | null
  readonly settings: LeadSettingsProjection
  readonly expiry: number | null
  readonly update: (value: Omit<LeadSettingsUpdate, 'expectedRevision'>) => Promise<unknown>
  readonly setSpendLimit: (usdMicros: number | null) => Promise<LeadWindowProjection>
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
  const limit = spendLimitOf(settings)
  const [limitOn, setLimitOn] = useState(limit !== null), [dollars, setDollars] = useState(limit === null ? '' : String(limit / 1000000))
  const [rounds, setRounds] = useState(String(settings.caps.rounds))
  // A widening waits on a card, and a declined one changes nothing: the draft goes back to what holds once the card settles.
  const policyCard = cards.find(card => card.type === 'permission-change')?.id ?? null, capsCard = cards.find(card => card.type === 'budget-change')?.id ?? null
  useEffect(() => { if (!policyCard) setPolicy(settings.policy) }, [settings.policy.revision, policyCard])
  useEffect(() => { setLimitOn(limit !== null); setDollars(limit === null ? '' : String(limit / 1000000)) }, [limit])
  useEffect(() => { if (!capsCard) setRounds(String(settings.caps.rounds)) }, [settings.caps.rounds, capsCard])
  const policyChanged = JSON.stringify({ ...policy, revision: 0 }) !== JSON.stringify({ ...settings.policy, revision: 0 })
  const widening = leadPolicyWidens(settings.policy, policy)
  const micros = Math.round(Number(dollars) * 1000000), roundCount = Number(rounds)
  const limitChanged = (limitOn ? micros : null) !== limit, roundsChanged = roundCount !== settings.caps.rounds
  // A legacy limit of $0 stays as it is until the person changes it; a new one is at least one microdollar.
  const validLimit = !limitOn || !limitChanged || dollars.trim() !== '' && Number.isSafeInteger(micros) && micros >= 1 && micros < LEAD_LIMITS.maxUsdMicros
  const validCaps = validLimit && rounds.trim() !== '' && Number.isSafeInteger(roundCount) && roundCount >= 0 && roundCount <= LEAD_LIMITS.rounds
  const roundsWiden = roundCount > settings.caps.rounds
  // The limit first, then rounds against the dollars it left: a rounds card drafted on the old dollars would go stale.
  const saveAllowances = async () => {
    if (busy.current) return
    busy.current = true; setPending(true)
    try {
      const after = limitChanged ? (await setSpendLimit(limitOn ? micros : null)).settings.caps : settings.caps
      if (roundsChanged) await update({ caps: { usdMicros: after.usdMicros, rounds: roundCount } })
    } catch (error) { onError(error) }
    finally { busy.current = false; setPending(false) }
  }
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
        <Row title="Spending limit" desc={limitOn ? 'Stops when reported spend reaches the limit. Applies to the goal in hand once saved.' : 'Off. No dollar limit; work still stops at the round allowance or when you stop it.'}
          control={<Switch aria-label="Spending limit" checked={limitOn} disabled={pending} onCheckedChange={setLimitOn} />} />
        {limitOn && <Row title="Limit per goal" control={<Input aria-label="Spending limit amount" type="number" min={0.000001} step="0.000001" placeholder="Dollars" value={dollars} disabled={pending} onChange={event => setDollars(event.target.value)} />} />}
        <Row title="Round allowance" desc={roundsWiden ? 'Asks for your approval in the conversation.' : 'Tightening applies at once.'} control={<Input aria-label="Round allowance" type="number" min={0} max={LEAD_LIMITS.rounds} step={1} value={rounds} disabled={pending} onChange={event => setRounds(event.target.value)} />} />
        {expiry !== null && <Row title="Plan consent expires" desc={formatLeadConsentTime(expiry)} />}
      </Rows>
      <Row title={null} control={<Button disabled={pending || !validCaps || !limitChanged && !roundsChanged} aria-busy={pending} onClick={() => void saveAllowances()}>Save allowances</Button>} />
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


/**
 * A door into one row of this page, from a digest item or anywhere else that names it: a kept note (`memory:m4`), an
 * autonomy kind (`autonomy:brief`) or a rule section (`rules:done`). Each section reads its own view, so the row may
 * arrive after the page does: the page waits for it (a few seconds at most), then brings it into view and focus once.
 */
const SETTINGS_ROW_FOCUS = /^(?:memory|autonomy|rules):[\w.:-]{1,200}$/
const useSettingsRowFocus = (focus: string | null | undefined): void => {
  const store = useStore(), done = useRef<string | null>(null)
  useEffect(() => {
    if (!focus) { done.current = null; return }
    if (!SETTINGS_ROW_FOCUS.test(focus) || done.current === focus) return
    // A note forgotten since the door was drawn: the person lands on the Memory section rather than nowhere.
    const [section, id] = [focus.slice(0, focus.indexOf(':')), focus.slice(focus.indexOf(':') + 1)]
    const gone = section === 'memory' ? () => { const view = store.lead.state.memory; return !!view && ![...view.core, ...view.archive].some(entry => entry.id === id) } : undefined
    return focusWhenDrawn(`[data-lead-settings-focus="${focus}"]`, () => { done.current = focus }, { fallback: [`[data-lead-settings-focus="${section}"]`], gone })
  }, [focus, store])
}

/** Settings owns this route; the capability gate prevents mounting it while disabled. */
export const LeadSettingsSection = ({ focus }: { readonly focus?: string | null }) => {
  const store = useStore(), active = useDestinationActive()
  const state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (active) void store.lead.readSettings().catch(error => setError(leadRefusalText(error))) }, [active, store])
  useSettingsRowFocus(active ? focus : null)
  return state.settings ? <><LeadSettings settings={state.settings} expiry={state.planConsentExpiresAt} cards={state.thread?.cards}
    error={error} onError={error => setError(leadRefusalText(error))} update={value => { setError(null); return store.lead.updateSettings(value) }}
    setSpendLimit={usdMicros => { setError(null); return store.lead.setSpendLimit(usdMicros) }}
    onOpen={focus => store.openDestination({ kind: 'lead', focus })} />
    <LeadTriggerSettings follow={state.settings.follow} root={state.thread?.project?.path ?? null} update={value => store.lead.updateSettings(value)} onError={error => setError(leadRefusalText(error))} />
    <LeadContextSection />
    <LeadAutonomySection />
    <LeadRulesSection />
    <LeadBriefSettingsSection label={state.settings.name === 'lex' ? 'Lex' : 'Dex'} />
    <LeadPlanSettingsSection focus={focus} label={state.settings.name === 'lex' ? 'Lex' : 'Dex'} />
    <LeadMemorySection label={state.settings.name === 'lex' ? 'Lex' : 'Dex'} cards={state.thread?.cards} /></> : error ? <Banner role="alert" tone="warning">{error}</Banner> : null
}
