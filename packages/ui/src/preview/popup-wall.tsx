import { sessionKey, type TeamPeerInfo } from '@harnessdesk/protocol'
import { MemberHoverCard, type MemberCardFacts } from '../components/AgentCards'
import { BudgetFooter } from '../components/TeamRoomPane'
import { itemId } from '@harnessdesk/protocol'
import { Publication } from '../components/Publication'
import { Button, SubjectActionsMenu, HeaderStatusGroup, HeaderStatusReading } from '../design'
import { useSnapshot } from '../state/context'
import { triggerBudgetState } from './intake-fixture'
const MemberFactsProbe = () => {
  const snapshot = useSnapshot()
  const runtime = snapshot.runtimes[0]!
  const session = [...snapshot.sessions.values()].find(one => one.runtime === runtime.id)!
  const peer: TeamPeerInfo = { runtime: runtime.id, sessionId: session.id, title: session.title ?? null, agent: runtime.presentation.name, nickname: 'Scout', busy: false, here: true, inbound: 'hold' }
  const member: MemberCardFacts = { peer, key: sessionKey(peer.runtime, peer.sessionId), busy: false, here: true, canUseBoard: true, idleOnBoard: false, task: null, title: session.title ?? null }
  return <MemberHoverCard source="member" member={member}><Button variant="outline">Frame member facts</Button></MemberHoverCard>
}
const BudgetFactsProbe = () => <BudgetFooter state={triggerBudgetState()} now={1_700_000_060_000} />

import { DropdownExample, MenuExample, DisabledRowsExample, WideMenuExample, MeteredMenuExample, InfoCardExample, SuggestionsExample, SelectExample, DisabledSelectExample, InboxExample, PaletteResultExample } from '../design/catalog/popup-examples'
export const PopupWall = () => {
  const one = new URLSearchParams(location.search).get('popup')
  const body = (() => {
    switch (one) {
      case 'menu-icons': return <MenuExample />
      case 'menu-none': return <MenuExample icons="none" />
      case 'disabled-rows': return <DisabledRowsExample />
      case 'palette-result': return <PaletteResultExample />
      case 'dropdown-icons': return <DropdownExample icons="all" />
      case 'dropdown-none': return <DropdownExample icons="none" />
      case 'wide': return <WideMenuExample />
      case 'metered': return <MeteredMenuExample />
      case 'info': return <InfoCardExample />
      case 'info-and-menu': return <><InfoCardExample /><MenuExample /></>
      case 'header-info': return <HeaderStatusGroup><HeaderStatusReading label="Status" detail="Idle"><Button variant="ghost">Frame status facts</Button></HeaderStatusReading></HeaderStatusGroup>
      case 'member-info': return <MemberFactsProbe />
      case 'budget-info': return <BudgetFactsProbe />
      case 'publication-info': return <PublicationFactsProbe />
      case 'subject-actions': return <SubjectActionsProbe />
      case 'suggestions': return <SuggestionsExample />
      case 'inbox': return <InboxExample />
      case 'select': return <SelectExample />
      case 'select-disabled': return <DisabledSelectExample />
      default: return null
    }
  })()
  return <div className="fixed left-(--hd-sidebar-width) top-(--hd-bar-h)">{body}</div>
}

const PublicationFactsProbe = () => <Publication root="workspace/storefront" item={{ id: itemId('frame-publication'), type: 'publication', reference: {
  kind: 'pullRequest', action: 'opened', repo: 'acme/storefront', number: 12, url: 'https://forge.example/acme/storefront/pull/12',
  title: 'Storefront catalogue and checkout boundary review before publication', state: 'open', author: 'Jane Doe', files: 9, additions: 128, deletions: 42,
  excerpt: '发布前检查。The checkout route keeps its retry policy and publication evidence together.', via: 'gh', signature: null,
} }} />
const SubjectActionsProbe = () => <SubjectActionsMenu label="Scout" actions={[{ label: 'Open', onSelect: () => {} }, { label: 'Message', onSelect: () => {} }, { label: 'Remove', disabled: 'This record cannot be changed.', onSelect: () => {} }]} choice={{ label: 'Messages', value: 'hold', options: [{ value: 'accept', label: 'Accept' }, { value: 'hold', label: 'Hold' }, { value: 'refuse', label: 'Refuse' }], onChange: () => {} }} />
