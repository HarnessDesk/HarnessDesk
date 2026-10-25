import type { AccountLinkState } from '@harnessdesk/protocol'
import { AccountLinkSettings } from '../components/AccountLinkSettings'
import { Frame } from './main'

export const ACCOUNT_LINK_FIXTURES: Readonly<Record<string, AccountLinkState>> = {
  idle: { status: 'idle' },
  waiting: { status: 'waiting', userCode: 'ABCD-EFGH', verifyUrl: 'https://example.com/link#code=ABCD-EFGH', expiresAt: Date.now() + 8 * 60_000 },
  linked: { status: 'linked', deskId: 'AAAAAAAAAAAAAAAAAAAAAA', linkedAt: Date.UTC(2026, 9, 24, 12) },
  denied: { status: 'denied' },
  expired: { status: 'expired' },
  error: { status: 'error', reason: 'The account service could not be reached. Try again.' },
  starting: { status: 'starting' },
}
/** Focused settings specimens contain synthetic state only and never contact the account service. */
export const AccountLinkFrames = () => {
  const scene = new URLSearchParams(location.search).get('desk-link')
  const scenes = scene && ACCOUNT_LINK_FIXTURES[scene] ? [scene] : Object.keys(ACCOUNT_LINK_FIXTURES)
  return <div className="grid gap-4 p-4">{scenes.map(key => <Frame key={key} id={`desk-link-${key}`} title={`Settings › Phone · ${key}`}>
    <div className="p-4"><AccountLinkSettings state={ACCOUNT_LINK_FIXTURES[key]!} onStart={() => {}} onCancel={() => {}} onCopy={() => {}} onOpen={() => {}} /></div>
  </Frame>)}</div>
}
