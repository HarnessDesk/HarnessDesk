import { sessionKey, type TeamPeerInfo } from '@harnessdesk/protocol'
import { MemberHoverCard, type MemberCardFacts } from '../components/AgentCards'
import { BudgetFooter } from '../components/TeamRoomPane'
import { itemId } from '@harnessdesk/protocol'
import { Publication } from '../components/Publication'
import { Button, SubjectActionsMenu } from '../design'
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

import { DropdownExample, MenuExample, WideMenuExample, MeteredMenuExample, InfoCardExample } from '../design/catalog/popup-examples'
export const PopupWall = () => {
  const one = new URLSearchParams(location.search).get('popup')
  if (one === 'dropdown-none' || one === 'dropdown-icons') return <div className="fixed left-(--hd-sidebar-width) top-(--hd-bar-h)"><DropdownExample icons={one === 'dropdown-icons' ? 'all' : 'none'} /></div>
  return <div className="fixed left-(--hd-sidebar-width) top-(--hd-bar-h)">{one === 'menu-icons' ? <MenuExample /> : one === 'menu-none' ? <MenuExample icons="none" /> : one === 'wide' ? <WideMenuExample /> : one === 'metered' ? <MeteredMenuExample /> : one === 'publication-info' ? <PublicationFactsProbe /> : one === 'subject-actions' ? <SubjectActionsProbe /> : one === 'member-info' ? <MemberFactsProbe /> : one === 'budget-info' ? <BudgetFactsProbe /> : one === 'info' ? <InfoCardExample /> : one === 'info-and-menu' ? <><InfoCardExample /><MenuExample /></> : null}</div>
