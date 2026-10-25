import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AccountLinkState } from '@harnessdesk/protocol'
import { Banner, Button, Chip, CodeText, Row, Rows } from '../design'
import { openExternal } from '../lib/desktop'
import { useStore } from '../state/context'

/** Account linking uses the same settings rows as local phone pairing; no service calls belong in the window. */
export const AccountLinkSettings = ({ state, onStart, onCancel, onOpen, onCopy }: {
  readonly state: AccountLinkState
  readonly onStart: () => void
  readonly onCancel: () => void
  readonly onOpen: (url: string) => void
  readonly onCopy: (code: string) => void
}) => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (state.status !== 'waiting') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state.status])
  if (state.status === 'unavailable') return null
  const seconds = state.status === 'waiting' ? Math.max(0, Math.ceil((state.expiresAt - now) / 1000)) : 0
  const left = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`
  const retry = state.status === 'denied' || state.status === 'expired' || state.status === 'error'
  return <Rows aria-label="Link to your account">
    <Row title="Link to your account" desc="Reach this desk from your phone through your account."
      titleChip={state.status === 'linked' ? <Chip tone="success">Linked</Chip> : undefined}
      control={state.status === 'idle' || state.status === 'starting' || retry
        ? <Button variant="outline" disabled={state.status === 'starting'} onClick={onStart}>{state.status === 'starting' ? 'Linking…' : retry ? 'Try again' : 'Link'}</Button> : undefined} />
    {state.status === 'starting' && <Row title="Preparing a link code…" control={<Button variant="quiet" onClick={onCancel}>Cancel</Button>} />}
    {state.status === 'waiting' && <>
      <Row title={<CodeText as="code" size="display" spaced aria-label="Account link code">{state.userCode}</CodeText>} desc={left}
        control={<Button variant="outline" onClick={() => onCopy(state.userCode)}>Copy code</Button>} />
      <Row title="Approve this code on the link page" control={<Button onClick={() => onOpen(state.verifyUrl)}>Open the link page</Button>} />
      <Row title="Waiting for your approval" control={<Button variant="quiet" onClick={onCancel}>Cancel</Button>} />
    </>}
    {state.status === 'linked' && <Row title="Linked on" control={<time dateTime={new Date(state.linkedAt).toISOString()}>{new Date(state.linkedAt).toLocaleDateString()}</time>} />}
    {retry && <Row title={state.status === 'denied' ? 'The link was declined.' : state.status === 'expired' ? 'The link code expired.' : state.status === 'error' ? state.reason : ''} />}
  </Rows>
}

export const AccountLinkSettingsSection = () => {
  const store = useStore(), state = useSyncExternalStore(store.accountLink.subscribe, () => store.accountLink.state)
  const [copyError, setCopyError] = useState(false)
  return <>
    <AccountLinkSettings state={state} onStart={() => { setCopyError(false); void store.accountLink.start() }} onCancel={() => void store.accountLink.cancel()}
      onOpen={openExternal} onCopy={code => { void Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(() => setCopyError(false), () => setCopyError(true)) }} />
    {copyError && state.status !== 'unavailable' && <Banner tone="warning">The code could not be copied. Select it and copy it.</Banner>}
  </>
}
