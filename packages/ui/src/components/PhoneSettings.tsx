import { AccountLinkSettingsSection } from './AccountLinkSettings'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PhoneDeviceView, PhoneLinkState, PhonePairing, PhonePendingView, PhoneTier } from '@harnessdesk/protocol'
import { Banner, Button, Chip, ConfirmDialog, InlineParts, QrCode, Row, Rows, Section, Text } from '../design'

import { useStore } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'

const TIER_WORDS: Readonly<Record<PhoneTier, string>> = { read: 'Read', run: 'Run', answer: 'Answer' }
const tiersText = (tiers: readonly PhoneTier[]) => tiers.map(tier => TIER_WORDS[tier]).join(', ') || 'None'
const lastSeen = (at: number | null) => at === null ? 'Not connected yet' : `Last seen ${new Date(at).toLocaleString()}`

const refusal = (error: unknown): string => {
  const code = (error as { wireCode?: string })?.wireCode
  if (code === 'phone-link-unavailable') return 'The phone link is off on this desk.'
  return error instanceof Error ? error.message : 'The phone link did not answer.'
}

export const PhoneSettings = ({ state, pairing, error, busy, onPair, onAllow, onDeny, onRevoke }: {
  readonly state: PhoneLinkState
  readonly pairing: PhonePairing | null
  readonly error: string | null
  readonly busy: boolean
  readonly onPair: () => void
  readonly onAllow: (pending: PhonePendingView) => void
  readonly onDeny: (pending: PhonePendingView) => void
  readonly onRevoke: (device: PhoneDeviceView) => void
}) => {
  const [removing, setRemoving] = useState<PhoneDeviceView | null>(null)
  if (!state.enabled) return <Banner>The phone link is off on this desk.</Banner>
  return <>
    {error && <Banner role="alert" tone="warning">{error}</Banner>}
    <Section title="Add a phone">
      <Rows>
        <Row title="Pairing code" desc={pairing ? `Scan it with the phone on this network. It works once, until ${new Date(pairing.expiresAt).toLocaleTimeString()}.` : 'Shows a code that works once, for ten minutes.'}
          control={<Button variant="outline" disabled={busy} onClick={onPair}>{pairing ? 'New code' : 'Show code'}</Button>} />
        {pairing && <Row title="Scan with the phone" desc="Open HarnessDesk on the phone and point it here." control={<QrCode text={pairing.url} label="Pairing code" />} />}
      </Rows>
    </Section>
    {state.pending.length > 0 && <Section title="Waiting for you">
      <Rows>{state.pending.map(pending => <Row key={pending.id} title={`Allow ${pending.name}?`}
        desc="It showed this desk's code. It can read the Lead's conversation, send to it and answer its cards."
        control={<InlineParts><Button disabled={busy} onClick={() => onAllow(pending)}>Allow</Button><Button variant="quiet" disabled={busy} onClick={() => onDeny(pending)}>Not now</Button></InlineParts>} />)}</Rows>
    </Section>}
    <Section title="Phones">
      {state.devices.length === 0 ? <Text role="prose">No phone is paired.</Text> : <Rows>{state.devices.map(device =>
        <Row key={device.id} title={device.name} titleChip={<Chip tone="neutral">{tiersText(device.tiers)}</Chip>} desc={lastSeen(device.lastSeenAt)}
          control={<Button variant="destructive" disabled={busy} onClick={() => setRemoving(device)}>Remove</Button>} />)}</Rows>}
    </Section>
    {removing && <ConfirmDialog title={`Remove ${removing.name}?`} confirmLabel="Remove phone" cancelLabel="Keep phone" tone="destructive" busy={busy}
      onConfirm={() => { onRevoke(removing); setRemoving(null) }} onCancel={() => setRemoving(null)}>
      <Text role="prose">The phone is disconnected now and has to be paired again to come back.</Text>
    </ConfirmDialog>}
  </>
}

const usePhone = () => {
  const store = useStore()
  const state = useSyncExternalStore(store.phone.subscribe, () => store.phone.state)
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [pairing, setPairing] = useState<PhonePairing | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await action() } catch (cause) { setError(refusal(cause)) } finally { setBusy(false) }
  }
  return { store, state, error, busy, pairing, setPairing, run }
}

export const PhoneSettingsSection = () => {
  const { store, state, error, busy, pairing, setPairing, run } = usePhone(), active = useDestinationActive()
  useEffect(() => { if (active) void store.phone.refresh().catch(() => {}) }, [active, store])
  return <>
    <AccountLinkSettingsSection />
    {state.enabled && <PhoneSettings state={state} pairing={pairing} error={error} busy={busy}
    onPair={() => void run(async () => setPairing(await store.phone.pairing()))}
    onAllow={pending => void run(() => store.phone.allow(pending.id))} onDeny={pending => void run(() => store.phone.deny(pending.id))}
    onRevoke={device => void run(() => store.phone.revoke(device.id))} />}
  </>
}

/** A phone is asking to join. Whatever page is open, the person at the desk is asked once. */
export const PhoneAsk = () => {
  const { store, state, busy, run, error } = usePhone()
  const ask = state.pending[0]
  if (!ask) return null
  return <ConfirmDialog title="Allow this phone?" confirmLabel="Allow" cancelLabel="Not now" busy={busy}
    onConfirm={() => void run(() => store.phone.allow(ask.id))} onCancel={() => void run(() => store.phone.deny(ask.id))}>
    <Text role="prose">{ask.name} showed this desk's pairing code. Once allowed, it can read the Lead's conversation, send to it and answer its cards.</Text>
    {error && <Banner role="alert" tone="warning">{error}</Banner>}
  </ConfirmDialog>
}
