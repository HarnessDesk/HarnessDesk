import { useState, useSyncExternalStore } from 'react'
import type { PhoneRelayState } from '@harnessdesk/protocol'
import { ActionError, Banner, BannerAction, Button, Chip, CodeText, ConfirmDialog, Dialog, Face, Input, Note, NoticeHost, Row, Rows, RowValue, Section, SectionHead, Spinner, Switch } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { shownDeskName } from '../lib/accounts'
import { formatAge } from '../lib/usage'
import { MobileIcon } from './Icons'

/** Account actions always return the host's current state; no credentials enter the renderer. */
export const useHarnessDeskAccountAction = () => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    setErrorCode(null)
    try { await action(); return true }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setErrorCode(typeof failure === 'object' && failure !== null && 'code' in failure && typeof failure.code === 'string' ? failure.code : null)
      return false
    }
    finally { setBusy(false) }
  }
  return { busy, error, errorCode, run }
}

const signInLocation = (verifyUrl: string): string => {
  try {
    const url = new URL(verifyUrl)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return `on ${url.hostname}`
  } catch { /* A malformed approval URL must not name a different service. */ }
  return 'using your browser'
}

export const HarnessDeskSignInPending = () => {
  const store = useStore()
  const { harnessDeskAccount: status } = useSnapshot()
  const { busy, error, run } = useHarnessDeskAccountAction()
  if (status?.status !== 'pending' || !status.pending) return null
  return <NoticeHost size="compact"><Banner title="Finish in your browser" icon={<Spinner />} role="status" measure="container" layout="stack"
    actions={<><BannerAction size="sm" disabled={busy} onClick={() => void run(() => store.openHarnessDeskSignIn())}>Open the page again</BannerAction>
      <BannerAction variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => store.cancelHarnessDeskSignIn())}>Cancel</BannerAction></>}>
    Sign in {signInLocation(status.pending.verifyUrl)}. Match this code: <CodeText>{status.pending.userCode}</CodeText>.
    {(error || status.error) && <ActionError>{error || status.error}</ActionError>}
  </Banner></NoticeHost>
}

export const HarnessDeskSignOut = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const { busy, error, errorCode, run } = useHarnessDeskAccountAction()
  const signOut = (localOnly?: boolean) => void run(() => localOnly ? store.signOutOfHarnessDesk(true) : store.signOutOfHarnessDesk()).then(done => { if (done) onClose() })
  const localOnlyAvailable = errorCode === 'accountCloudUnreachable'
  return <ConfirmDialog title="Sign out of HarnessDesk?" confirmLabel="Sign out" cancelLabel="Keep signed in" tone="destructive"
    busy={busy} onCancel={onClose} onConfirm={() => signOut()}
    alternative={localOnlyAvailable ? { label: 'Sign out on this desk only', onClick: () => signOut(true) } : undefined}>
    This desk will no longer be reachable through your HarnessDesk account. Your agent accounts stay signed in.
    {error && <ActionError>{error}</ActionError>}
    {localOnlyAvailable && <Note>Signing out on this desk only removes its local sign-in. This desk stays linked to your account until you unlink it from another device.</Note>}
  </ConfirmDialog>
}

const HarnessDeskDeleteAccount = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const { busy, error, run } = useHarnessDeskAccountAction()
  return <ConfirmDialog title="Delete your HarnessDesk account?" confirmLabel="Delete account" cancelLabel="Keep account" tone="destructive"
    busy={busy} onCancel={() => { if (!busy) onClose() }} onConfirm={() => void run(() => store.deleteHarnessDeskAccount()).then(done => { if (done) onClose() })}>
    This removes the account and unlinks every desk and phone. Agents and local work on this Mac are not affected. This cannot be undone.
    {error && <ActionError>{error}</ActionError>}
  </ConfirmDialog>
}

/** The desk's relay socket, beside Reachable from your phone. Off draws nothing: the switch already says so. */
const RELAY_CHIPS: Readonly<Record<Exclude<PhoneRelayState, 'off'>, { readonly word: string; readonly warn: boolean; readonly title?: string }>> = {
  connected: { word: 'Connected', warn: false },
  connecting: { word: 'Connecting…', warn: false },
  unreachable: { word: 'Can’t reach HarnessDesk', warn: true, title: 'HarnessDesk keeps trying. Phones on this network still connect.' },
  replaced: { word: 'In use elsewhere', warn: true, title: 'Another copy of this desk took over. Turn this off and on to take it back.' },
  refused: { word: 'Refused', warn: true, title: 'Your account did not let this desk in. Sign out and sign in again.' },
}
const RelayChip = ({ state }: { state: PhoneRelayState }) => {
  if (state === 'off') return null
  const chip = RELAY_CHIPS[state]
  return <Chip tone={chip.warn ? 'warning' : 'neutral'} {...(chip.title ? { title: chip.title } : {})}>{chip.word}</Chip>
}

/** Account owns identity and desk lifecycle; Mobile owns phone access. */
export const HarnessDeskAccountSection = () => {
  const store = useStore()
  const { harnessDeskAccount: status, sidebarCollapsed, hideAccountAddresses: hide } = useSnapshot()
  const { busy, error, run } = useHarnessDeskAccountAction()
  const [signOut, setSignOut] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const signedIn = status?.status === 'signedIn'
  const account = status?.account
  return <>
    <Rows><Row kind="record" face={<Face pictureDataUrl={account?.pictureDataUrl} />} title={signedIn ? shownDeskName(account, hide) || 'HarnessDesk account' : 'Sign in to HarnessDesk'}
      desc={signedIn ? (hide ? undefined : account?.email) : 'Open this desk from your phone.'} control={signedIn
        ? <Button variant="outline" onClick={() => setSignOut(true)}>Sign out…</Button>
        : <Button disabled={busy || status?.status === 'pending'} onClick={() => void run(() => store.signInToHarnessDesk())}>Sign in…</Button>} /></Rows>
    {sidebarCollapsed && <HarnessDeskSignInPending />}
    {(error || (status?.status !== 'pending' && status?.error)) && <ActionError>{error || status?.error}</ActionError>}
    {signedIn && <>
      <SectionHead level="label" name="This desk" />
      <Rows>
        <Row title="Name" desc="How your phone lists this desk" control={<><RowValue>{status.desk.name}</RowValue><Button variant="outline" disabled={busy} onClick={() => { setName(status.desk.name); setRenaming(true) }}>Rename</Button></>} />
      </Rows>
    </>}
    <Section title="Mobile"><Rows><Row mark={<MobileIcon size={16} />} title="Connect your phone" control={<Button variant="outline"
      onClick={() => store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'phone', focus: null } })}>Mobile settings</Button>} /></Rows></Section>
    {signedIn && <><SectionHead level="label" name="HarnessDesk account" />
      <Rows><Row title="Delete account" control={<Button variant="destructive" disabled={busy} onClick={() => setDeleting(true)}>Delete account…</Button>} /></Rows></>}
    {signOut && <HarnessDeskSignOut onClose={() => setSignOut(false)} />}
    {deleting && <HarnessDeskDeleteAccount onClose={() => setDeleting(false)} />}
    {renaming && <Dialog title="Rename this desk" onClose={() => setRenaming(false)} footer={<>
      <Button disabled={busy || !name.trim()} onClick={() => void run(() => store.renameHarnessDesk(name.trim())).then(done => { if (done) setRenaming(false) })}>Rename</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setRenaming(false)}>Cancel</Button>
    </>}><Input aria-label="Desk name" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} />{error && <ActionError>{error}</ActionError>}</Dialog>}

  </>
}

/** Mobile owns nearby pairing and account relay access through the existing host service. */
export const HarnessDeskMobileSection = () => {
  const store = useStore(), { harnessDeskAccount: status } = useSnapshot()
  const { busy, error, run } = useHarnessDeskAccountAction()
  const [unlink, setUnlink] = useState<{ deviceId: string; name: string } | null>(null)
  const relay = useSyncExternalStore(store.phone.subscribe, () => store.phone.state.relay)
  if (status?.status !== 'signedIn') return <Section title="Away from this network"><Rows><Row title="Sign in to HarnessDesk"
    desc="Use your account to reach this desk from another network."
    control={<Button variant="outline" onClick={() => store.openDestination({ kind: 'settings', route: { kind: 'section', section: 'profile', focus: null } })}>Account settings</Button>} /></Rows></Section>
  return <>
    <Section title="Away from this network"><Rows>
      <Row title="Reachable from your phone" titleChip={status.desk.reachable ? <RelayChip state={relay} /> : undefined}
        desc="Your phones reach this desk through your account when they are away from its network. Messages stay encrypted end to end."
        control={<Switch aria-label="Reachable from your phone" checked={status.desk.reachable} disabled={busy}
          onCheckedChange={reachable => void run(() => store.setHarnessDeskReachable(reachable))} />} />
    </Rows></Section>
    <Section title="Linked phones"><Rows>{status.phones.map(phone => <Row key={phone.deviceId} mark={<MobileIcon size={16} />} title={phone.name}
      desc={phone.lastSeenAt === null ? 'Last seen unavailable' : `Last seen ${formatAge(phone.lastSeenAt * 1000, Date.now())}`}
      control={<Button variant="outline" disabled={busy} onClick={() => setUnlink(phone)}>Unlink</Button>} />)}</Rows>
      {status.phones.length === 0 && <Note>No phones linked yet.</Note>}
      <Note>Sign in on your phone with the same account to add another.</Note>
    </Section>
    {error && <ActionError>{error}</ActionError>}
    {unlink && <ConfirmDialog title={`Unlink ${unlink.name}?`} confirmLabel="Unlink" cancelLabel="Keep linked" tone="destructive" busy={busy}
      onCancel={() => setUnlink(null)} onConfirm={() => void run(() => store.unlinkHarnessDeskPhone(unlink.deviceId)).then(done => { if (done) setUnlink(null) })}>
      This phone will lose access to this desk.{error && <ActionError>{error}</ActionError>}
    </ConfirmDialog>}
  </>
}
