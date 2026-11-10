import { useEffect, useState, useSyncExternalStore } from 'react'
import { LEAD_WORK_GROUPS, LEAD_WORK_GROUP_LABELS, runtimeId, sessionId, type LeadWorkBoard, type LeadWorkCard, type LeadWorkGroup, type LeadWorkOutcome } from '@harnessdesk/protocol'
import { Chip, ListRow, ListRows, Menu, MenuItem, MenuNote, MenuSeparator, Popover, SectionHead, Text, ToolSection } from '../design'
import { useStore } from '../state/context'
import { openExternal } from '../lib/desktop'
import { sanitizeText } from '../lib/sanitize'
import { leadRefusalText } from './lead-refusals'
import { CheckIcon, CommentIcon, CrossIcon, MoreIcon, PullRequestIcon, TeamIcon } from './Icons'

/** The board in its four groups, Needs you first; the phone draws the same groups from the same board. */
export const leadWorkGroups = (board: LeadWorkBoard): readonly { readonly group: LeadWorkGroup; readonly label: string; readonly items: readonly LeadWorkCard[] }[] =>
  LEAD_WORK_GROUPS.map(group => ({ group, label: LEAD_WORK_GROUP_LABELS[group], items: board.items.filter(item => item.group === group) }))
    .filter(entry => entry.items.length > 0)

const PULL_REQUEST = /^([\w.-]+\/[\w.-]+)#(\d+)$/
const chatKey = (id: string) => { const at = id.indexOf(':'); return at > 0 ? { runtime: runtimeId(id.slice(0, at)), session: sessionId(id.slice(at + 1)) } : null }

/** One item's doors: its latest chat, Team and pull request, then the person's Done or Drop. */
const WorkActions = ({ card, onClose }: { readonly card: LeadWorkCard; readonly onClose: (outcome: LeadWorkOutcome) => void }) => {
  const store = useStore()
  const chat = card.links.chats.at(-1), team = card.links.teams.at(-1), pr = card.links.prs.at(-1)?.match(PULL_REQUEST)
  const open = card.closedAt === undefined
  if (!chat && !team && !pr && !open) return null
  return <Popover label={<MoreIcon size={16} />} aria-label={`Actions for ${sanitizeText(card.title)}`} triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} icons="all">
    {close => <Menu close={close}>
      {chat && chatKey(chat) && <MenuItem icon={<CommentIcon size={16} />} label="Open chat" onSelect={() => { const key = chatKey(chat)!; void store.openSession(key.session, { runtime: key.runtime }) }} />}
      {team && <MenuItem icon={<TeamIcon size={16} />} label="Open Team" onSelect={() => store.openTeamRoom(team)} />}
      {pr && <MenuItem icon={<PullRequestIcon size={16} />} label="Open pull request" title={`${pr[1]}#${pr[2]}`} onSelect={() => openExternal(`https://github.com/${pr[1]}/pull/${pr[2]}`)} />}
      {open && (chat || team || pr) && <MenuSeparator />}
      {open && <MenuItem icon={<CheckIcon size={16} />} label="Done" onSelect={() => onClose('done')} />}
      {open && <MenuItem icon={<CrossIcon size={16} />} label="Drop" onSelect={() => onClose('dropped')} />}
      {open && <MenuNote>Closing leaves its chats, Teams and pull requests as they are.</MenuNote>}
    </Menu>}
  </Popover>
}

/**
 * The Lead's work, as the host derives it from the desk: every piece of work the person asked for, grouped by who it
 * waits on. Stages are read, never set here; the only change this card makes is the person's own Done or Drop.
 */
export const LeadWork = () => {
  const store = useStore(), state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void store.lead.readWork().catch(() => {}) }, [store, state.revision])
  const board = state.work
  // Nothing tracked yet is not a card: the rail stays as it was until the Lead starts work.
  if (!board || board.items.length === 0) return null
  const groups = leadWorkGroups(board), open = board.items.filter(item => item.closedAt === undefined).length
  const close = async (card: LeadWorkCard, outcome: LeadWorkOutcome) => {
    setError(null)
    try { await store.lead.closeWork(card.id, outcome) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  return <ToolSection label="Work" fold value={open || undefined}>
    {groups.map(({ group, label, items }) => <section key={group} aria-label={label} data-work-group={group}>
      <SectionHead level="label" name={`${label} · ${items.length}`} />
      <ListRows>{items.map(card => <ListRow key={card.id} size="sm" data-work-item={card.id}
        title={<span title={card.fact ? sanitizeText(card.fact) : undefined}>{sanitizeText(card.title)}</span>} wrapTitle
        // A reason someone waits is a fact that varies, so it earns the line; everything else stays on hover.
        subtitle={group === 'needs-you' && card.blocker ? sanitizeText(card.blocker) : undefined} wrapSubtitle
        trail={<>{card.outcome === 'dropped' && <Chip tone="neutral">Dropped</Chip>}<WorkActions card={card} onClose={outcome => { void close(card, outcome) }} /></>} />)}</ListRows>
    </section>)}
    {board.more > 0 && <Text role="muted">{board.more} older closed {board.more === 1 ? 'item' : 'items'} not shown</Text>}
    {error && <Text role="muted">{error}</Text>}
  </ToolSection>
}
