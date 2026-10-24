import { useState } from 'react'
import { ActionError, Banner, BannerAction, Button, CodeText, ConfirmDialog, Dialog, Face, Input, Note, NoticeHost, Row, Rows, RowValue, SectionHead, Spinner, Switch } from '../design'
import { useSnapshot, useStore } from '../state/context'
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
    This desk will no longer be reachable from your phone. Your agent accounts stay signed in.
    {error && <ActionError>{error}</ActionError>}
    {localOnlyAvailable && <Note>Signing out on this desk only removes its local sign-in. This desk stays linked to your account until you unlink it from another device.</Note>}
  </ConfirmDialog>
}

/** The Account page owns the HarnessDesk identity, desk and account-linked phones. */
export const HarnessDeskAccountSection = () => {
  const store = useStore()
  const { harnessDeskAccount: status, sidebarCollapsed } = useSnapshot()
  const { busy, error, run } = useHarnessDeskAccountAction()
  const [signOut, setSignOut] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [unlink, setUnlink] = useState<{ deviceId: string; name: string } | null>(null)
  const signedIn = status?.status === 'signedIn'
  const account = status?.account
  return <>
    <Rows><Row kind="record" face={<Face pictureDataUrl={account?.pictureDataUrl} />} title={signedIn ? account?.name || account?.email || 'HarnessDesk account' : 'Sign in to HarnessDesk'}
      desc={signedIn ? account?.email : 'Open this desk from your phone.'} control={signedIn
        ? <Button variant="outline" onClick={() => setSignOut(true)}>Sign out…</Button>
        : <Button disabled={busy || status?.status === 'pending'} onClick={() => void run(() => store.signInToHarnessDesk())}>Sign in…</Button>} /></Rows>
    {sidebarCollapsed && <HarnessDeskSignInPending />}
    {(error || (status?.status !== 'pending' && status?.error)) && <ActionError>{error || status?.error}</ActionError>}
    {signedIn && <>
      <SectionHead level="label" name="This desk" />
      <Rows>
        <Row title="Name" desc="How your phone lists this desk" control={<><RowValue>{status.desk.name}</RowValue><Button variant="outline" disabled={busy} onClick={() => { setName(status.desk.name); setRenaming(true) }}>Rename</Button></>} />
        <Row title="Reachable from your phone" desc="Save your preference for phone access. Phone connections are not available in this build."
          control={<Switch aria-label="Reachable from your phone" checked={status.desk.reachable} disabled={busy} onCheckedChange={reachable => void run(() => store.setHarnessDeskReachable(reachable))} />} />
      </Rows>
      <SectionHead level="label" name="Linked phones" />
      <Rows>{status.phones.map(phone => <Row key={phone.deviceId} mark={<MobileIcon size={16} />} title={phone.name}
        desc={phone.lastSeenAt === null ? 'Last seen unavailable' : `Last seen ${formatAge(phone.lastSeenAt * 1000, Date.now())}`}
        control={<Button variant="outline" disabled={busy} onClick={() => setUnlink(phone)}>Unlink</Button>} />)}</Rows>
      {status.phones.length === 0 && <Note>No phones linked yet.</Note>}
      <Note>Sign in on your phone with the same account to add another.</Note>
    </>}
    <SectionHead level="label" name="Without an account" />
    <Rows><Row mark={<MobileIcon size={16} />} title="Pair a phone with a code" desc="Not available in this build"
      control={<Button variant="outline" disabled>Show code</Button>} /></Rows>
    {signOut && <HarnessDeskSignOut onClose={() => setSignOut(false)} />}
    {renaming && <Dialog title="Rename this desk" onClose={() => setRenaming(false)} footer={<>
      <Button disabled={busy || !name.trim()} onClick={() => void run(() => store.renameHarnessDesk(name.trim())).then(done => { if (done) setRenaming(false) })}>Rename</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setRenaming(false)}>Cancel</Button>
    </>}><Input aria-label="Desk name" autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} />{error && <ActionError>{error}</ActionError>}</Dialog>}
    {unlink && <ConfirmDialog title={`Unlink ${unlink.name}?`} confirmLabel="Unlink" cancelLabel="Keep linked" tone="destructive" busy={busy}
      onCancel={() => setUnlink(null)} onConfirm={() => void run(() => store.unlinkHarnessDeskPhone(unlink.deviceId)).then(done => { if (done) setUnlink(null) })}>
      This phone will lose access to this desk.{error && <ActionError>{error}</ActionError>}
    </ConfirmDialog>}
  </>
}
