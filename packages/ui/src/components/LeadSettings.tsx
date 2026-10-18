import { useRef, useState } from 'react'
import { CLIENT_METHODS, LEAD_LIMITS, type ClientMethodName, type LeadPermissionPolicy, type LeadSettingsProjection, type LeadSettingsUpdate } from '@harnessdesk/protocol'
import { Banner, Button, ConfirmDialog, Dialog, FormStack, Input, NativeSelect, Row, Rows, Text } from '../design'

const modes = { plan: 0, default: 1, manage: 2 }
const effects = { deny: 0, ask: 1, allow: 2 }
const widens = (previous: LeadPermissionPolicy, next: LeadPermissionPolicy) => modes[next.mode] > modes[previous.mode] ||
  previous.rules.some(old => !next.rules.some(rule => rule.id === old.id) && old.effect !== 'allow') || next.rules.some(rule => {
    const old = previous.rules.find(old => old.id === rule.id)
    return old ? effects[rule.effect] > effects[old.effect] || rule.method !== old.method || rule.action !== old.action || rule.project !== old.project : rule.effect === 'allow'
  })

export const LeadSettings = ({ settings, expiry, update, onClose, onError, error }: {
  readonly error?: string | null
  readonly settings: LeadSettingsProjection
  readonly expiry: number | null
  readonly update: (value: Omit<LeadSettingsUpdate, 'expectedRevision'>) => Promise<unknown>
  readonly onClose: () => void
  readonly onError: (error: unknown) => void
}) => {
  // Credentials never enter React state. The uncontrolled input is emptied before
  // the single credential request, including on refusal; updates never combine it.
  const key = useRef<HTMLInputElement>(null), busy = useRef(false)
  const [pending, setPending] = useState(false), [remove, setRemove] = useState(false)
  const [policy, setPolicy] = useState(settings.policy)
  const [dollars, setDollars] = useState(String(settings.caps.usdMicros / 1000000)), [rounds, setRounds] = useState(String(settings.caps.rounds))
  const widening = widens(settings.policy, policy)
  const micros = Math.round(Number(dollars) * 1000000), roundCount = Number(rounds)
  const validCaps = dollars.trim() !== '' && rounds.trim() !== '' && Number.isSafeInteger(micros) && micros >= 0 && micros <= LEAD_LIMITS.maxUsdMicros && Number.isSafeInteger(roundCount) && roundCount >= 0 && roundCount <= LEAD_LIMITS.rounds
  const capsWiden = micros > settings.caps.usdMicros || roundCount > settings.caps.rounds
  const submit = async (value: Omit<LeadSettingsUpdate, 'expectedRevision'>, close = false) => {
    if (busy.current) return
    busy.current = true; setPending(true)
    try { await update(value); if (close) onClose(); setRemove(false) }
    catch (error) { onError(error) }
    finally { busy.current = false; setPending(false) }
  }
  const credential = () => {
    if (busy.current || !key.current?.value.trim()) return
    const value = key.current.value; key.current.value = ''
    void submit({ credential: { provider: 'anthropic', key: value } })
  }
  return <>
    <Dialog title="Lead settings" onClose={() => { if (key.current) key.current.value = ''; onClose() }} footer={<Button onClick={onClose}>Done</Button>}>
      {error && <Banner role="alert" tone="warning">{error}</Banner>}
      <Rows>
        <Row title="Provider key" desc={settings.key.configured ? 'Configured' : 'Not configured'} />
        <Row title={settings.key.configured ? 'Replace key' : 'Add key'} control={<Input ref={key} aria-label="Provider key" type="password" autoComplete="new-password" disabled={pending} />} />
        <Row title="Save key" control={<Button disabled={pending || settings.key.protection !== 'encrypted'} aria-busy={pending} onClick={credential}>{settings.key.configured ? 'Replace key' : 'Add key'}</Button>} />
        {settings.key.configured && <Row title="Remove saved key" control={<Button variant="destructive" disabled={pending} onClick={() => setRemove(true)}>Remove key</Button>} />}
        <Row title="Model" desc={settings.model} />
      </Rows>
      {settings.key.protection !== 'encrypted' && <Banner>Encrypted key storage is unavailable.</Banner>}
      <Rows>
        <Row title="Permission mode" desc={widening ? 'Creates a card for your approval.' : 'Tightening applies at once.'} control={<NativeSelect aria-label="Permission mode" value={policy.mode} disabled={pending} onChange={event => setPolicy({ ...policy, mode: event.target.value as LeadPermissionPolicy['mode'] })}><option value="plan">Plan</option><option value="default">Default</option><option value="manage">Manage</option></NativeSelect>} />
        {policy.rules.map((rule, index) => <Row key={rule.id} title={`Rule ${index + 1}`} desc={<FormStack>
          <NativeSelect aria-label={`Rule ${index + 1} effect`} value={rule.effect} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, effect: event.target.value as typeof rule.effect } : one) })}>{(['allow', 'ask', 'deny'] as const).map(effect => <option key={effect} value={effect}>{effect}</option>)}</NativeSelect>
          <NativeSelect aria-label={`Rule ${index + 1} method`} value={rule.method} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, method: event.target.value as ClientMethodName } : one) })}>{(Object.keys(CLIENT_METHODS) as ClientMethodName[]).map(method => <option key={method} value={method}>{method}</option>)}</NativeSelect>
          <Input aria-label={`Rule ${index + 1} action`} placeholder="All actions" value={rule.action ?? ''} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, action: event.target.value || null } : one) })} />
          <Input aria-label={`Rule ${index + 1} project`} placeholder="Approved project" value={rule.project ?? ''} disabled={pending} onChange={event => setPolicy({ ...policy, rules: policy.rules.map(one => one.id === rule.id ? { ...one, project: event.target.value || null } : one) })} />
        </FormStack>} control={<Button variant="quiet" disabled={pending} onClick={() => setPolicy({ ...policy, rules: policy.rules.filter(one => one.id !== rule.id) })}>Remove rule</Button>} />)}
        <Row title="Rules" control={<Button variant="outline" disabled={pending || policy.rules.length >= LEAD_LIMITS.rules} onClick={() => setPolicy({ ...policy, rules: [...policy.rules, { id: crypto.randomUUID(), effect: 'ask', method: 'flow/start-goal', action: null, project: null }] })}>Add rule</Button>} />
        <Row title="Apply permission policy" control={<Button disabled={pending} aria-busy={pending} onClick={() => void submit({ policy: { ...policy, revision: settings.policy.revision + 1 } }, true)}>Save policy</Button>} />
      </Rows>
      <Rows>
        <Row title="Dollar allowance" control={<Input aria-label="Dollar allowance" type="number" min={0} step="0.000001" value={dollars} disabled={pending} onChange={event => setDollars(event.target.value)} />} />
        <Row title="Round allowance" control={<Input aria-label="Round allowance" type="number" min={0} max={LEAD_LIMITS.rounds} step={1} value={rounds} disabled={pending} onChange={event => setRounds(event.target.value)} />} />
        <Row title="Apply allowances" desc={capsWiden ? 'Creates a card for your approval.' : 'Tightening applies at once. Stops when reported spend reaches the cap.'} control={<Button disabled={pending || !validCaps} aria-busy={pending} onClick={() => void submit({ caps: { usdMicros: micros, rounds: roundCount } }, true)}>Save caps</Button>} />
        {expiry !== null && <Row title="Plan consent expires" desc={new Date(expiry).toLocaleString()} />}
      </Rows>
    </Dialog>
    {remove && <ConfirmDialog title="Remove Lead key?" confirmLabel="Remove key" cancelLabel="Keep key" tone="destructive" busy={pending} onConfirm={() => void submit({ credential: { provider: 'anthropic', key: null } })} onCancel={() => setRemove(false)}><Text role="prose">Removes the saved provider key and stops paid Lead requests.</Text></ConfirmDialog>}
  </>
}
