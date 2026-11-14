import { useEffect, useRef, useState } from 'react'
import type { DeskFeature } from '@harnessdesk/protocol'
import { ActionError, Banner, Button, Chip, ConfirmDialog, Row, Rows, Switch, Text } from '../design'
import { useSnapshot, useStore } from '../state/context'

/** Host choices apply immediately; problems require an explicit, explained repair. */
export const FeatureSettings = ({ feature }: { readonly feature: DeskFeature }) => {
  const store = useStore(), { features } = useSnapshot()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [repair, setRepair] = useState(false)
  const enable = useRef<HTMLElement | null>(null)
  const label = feature === 'lead' ? 'Lead' : 'Mobile'
  const [target, setTarget] = useState<boolean | null>(null)
  useEffect(() => {
    if (!features) void store.loadFeatures().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [store, features])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action(); setRepair(false) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false); setTarget(null) }
  }
  return <>
    <Rows><Row title={`Enable ${label}`} titleChip={<Chip tone={features?.problem ? 'warning' : 'neutral'}><span role="status">{features?.problem ? 'Needs repair' : busy ? target === true ? 'Starting…' : target === false ? 'Stopping…' : 'Repairing…' : features ? features[feature] ? 'On' : 'Off' : 'Loading…'}</span></Chip>} desc={feature === 'lead'
      ? 'Let the Lead coordinate work on this desk. Turning it off stops Lead work; its history is kept.'
      : 'Connect phones to this desk. Turning it off disconnects phones; their pairings are kept.'}
      control={<Switch ref={enable} aria-label={`Enable ${label}`} checked={features?.[feature] ?? false} aria-busy={busy} disabled={busy || !features || !!features.problem}
        onCheckedChange={enabled => { setTarget(enabled); void run(() => store.setFeature(feature, enabled)) }} />} /></Rows>
    {!features && !error && <Banner>Loading feature settings…</Banner>}
    {features?.problem && <Banner role="alert" tone="warning" title="Feature settings need repair">
      {features.problem.message}
      <Button variant="outline" disabled={busy} onClick={() => setRepair(true)}>Repair feature settings</Button>
    </Banner>}
    {error && <ActionError>{error}{!features && <Button variant="outline" disabled={busy} onClick={() => void run(() => store.loadFeatures())}>Try again</Button>}</ActionError>}
    {repair && <ConfirmDialog title="Repair feature settings?" confirmLabel="Repair feature settings" cancelLabel="Cancel" busy={busy}
      finalFocus={() => store.getSnapshot().features?.problem ? true : enable.current}
      onCancel={() => setRepair(false)} onConfirm={() => void run(() => store.repairFeatures())}>
      <Text role="prose">Both Lead and Mobile turn off. Lead work and phone connections stop. History and phone pairings are retained.</Text>
      {error && <ActionError>{error}</ActionError>}
    </ConfirmDialog>}
  </>
}
