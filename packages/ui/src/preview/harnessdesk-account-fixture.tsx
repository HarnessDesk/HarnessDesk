import { useEffect, useMemo } from 'react'
import accountPicture from '../../../../assets/avatars/128/guardian.png?inline'
import type { HarnessDeskAccountStatus } from '@harnessdesk/protocol'
import { StoreProvider, useStore } from '../state/context'
import { App } from '../app/App'
import { previewStore } from './harness'
import { frameDestinationStore } from './frame-destination-store'

/** Every identity and phone here is synthetic; this preview never opens a real sign-in page. */
export const HarnessDeskAccountPreview = () => {
  const fixture = useStore()
  const params = new URLSearchParams(window.location.search)
  const stage = params.get('desk-account')
  const store = useMemo(() => {
    const pending = stage === 'pending' || stage === 'pending-staging'
    const status: HarnessDeskAccountStatus = {
      status: pending ? 'pending' : stage === 'signed-out' ? 'signedOut' : 'signedIn',
      desk: { name: 'Jane’s MacBook Pro', reachable: true },
      phones: stage === 'signed-out' || pending ? [] : [{ deviceId: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'iPhone', lastSeenAt: Math.floor(Date.now() / 1000) - 120 }],
      ...(pending ? { pending: { userCode: 'ABCD-EFGH', verifyUrl: `https://${stage === 'pending-staging' ? 'app-staging.harnessdesk.app' : 'app.harnessdesk.app'}/link#code=ABCD-EFGH`, expiresAt: Math.floor(Date.now() / 1000) + 600 } }
        : stage === 'signed-out' ? {} : { account: { name: 'Jane Doe', email: 'jane@example.com', pictureUrl: null, pictureDataUrl: accountPicture } }),
    }
    const next = frameDestinationStore(previewStore({ ...fixture.getSnapshot(), harnessDeskAccount: status,
      theme: params.get('theme') === 'dark' ? 'dark' : 'light' }))
    if (stage === 'settings' || stage === 'settings-offline') next.openDestination({ kind: 'settings', route: { kind: 'section', section: 'profile', focus: null } })
    if (stage === 'settings-offline') {
      const signOut = next.signOutOfHarnessDesk.bind(next)
      next.signOutOfHarnessDesk = async localOnly => {
        if (!localOnly) throw Object.assign(new Error('The account service could not be reached.'), { code: 'accountCloudUnreachable' })
        await signOut(true)
      }
    }
    return next
  }, [fixture, stage])
  useEffect(() => {
    const resize = () => store.setWindowSize(window.innerWidth, window.innerHeight)
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [store])
  return <StoreProvider store={store}><div className="h-screen"><App /></div></StoreProvider>
}
