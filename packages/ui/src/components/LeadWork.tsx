import { useEffect, useState, useSyncExternalStore } from 'react'
import { LEAD_WORK_GROUPS, LEAD_WORK_GROUP_LABELS, runtimeId, sessionId, sessionKey, type LeadReminder, type LeadWorkBoard, type LeadWorkCard, type LeadWorkGroup, type LeadWorkOutcome } from '@harnessdesk/protocol'
import { Button, Chip, ListRow, ListRows, Menu, MenuItem, MenuNote, MenuSeparator, Popover, ToolGroup, ToolProse, ToolSection } from '../design'
import { formatLeadRunTime } from '../lib/lead-time'
import { useStore } from '../state/context'
import { openExternal } from '../lib/desktop'
import { sanitizeText } from '../lib/sanitize'
import { leadRefusalText } from './lead-refusals'
import { CheckIcon, CommentIcon, CrossIcon, MoreIcon, PullRequestIcon, StopIcon, TeamIcon } from './Icons'

/** The board in its four groups, Needs you first; the phone draws the same groups from the same board. */
export const leadWorkGroups = (board: LeadWorkBoard): readonly { readonly group: LeadWorkGroup; readonly label: string; readonly items: readonly LeadWorkCard[] }[] =>
  LEAD_WORK_GROUPS.map(group => ({ group, label: LEAD_WORK_GROUP_LABELS[group], items: board.items.filter(item => item.group === group) }))
    .filter(entry => entry.items.length > 0)

const PULL_REQUEST = /^([\w.-]+\/[\w.-]+)#(\d+)$/
const chatKey = (id: string) => { const at = id.indexOf(':'); return at > 0 ? { runtime: runtimeId(id.slice(0, at)), session: sessionId(id.slice(at + 1)) } : null }

/** One item's doors: its latest chat, Team and pull request, Stop while its chat works, then the person's Done or Drop. */
const WorkActions = ({ card, onClose }: { readonly card: LeadWorkCard; readonly onClose: (outcome: LeadWorkOutcome) => void }) => {
  const store = useStore()
  const chat = card.links.chats.at(-1), team = card.links.teams.at(-1), pr = card.links.prs.at(-1)?.match(PULL_REQUEST)
  const open = card.closedAt === undefined
  // The same stop the chat's own composer sends; the host then records the chat as stopped, not finished.
  const running = open && card.stage === 'working' && chat ? chatKey(chat) : null
  if (!chat && !team && !pr && !open) return null
  return <Popover label={<MoreIcon size={16} />} aria-label={`Actions for ${sanitizeText(card.title)}`} triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} icons="all">
    {close => <Menu close={close}>
      {running && <MenuItem icon={<StopIcon size={16} />} label="Stop" title="Stop the chat's current turn" onSelect={() => { void store.interrupt(sessionKey(running.runtime, running.session)) }} />}
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

/** Reminders the person can see: every one still set, and the ones that fired in the last day. A cancelled one is gone. */
export const leadVisibleReminders = (board: LeadWorkBoard | null | undefined): readonly LeadReminder[] =>
  (board?.reminders ?? []).filter(entry => entry.state === 'set' || entry.state === 'fired')

/**
 * The Lead's work, as the host derives it from the desk: every piece of work the person asked for, grouped by who it
 * waits on. Stages are read, never set here; the only change this card makes is the person's own Done or Drop.
 */
export const LeadWork = () => {
  const store = useStore(), state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void store.lead.readWork().catch(() => {}) }, [store, state.revision])
  const board = state.work
  const reminders = leadVisibleReminders(board)
  // Nothing tracked yet is not a card: the rail stays as it was until the Lead starts work or sets a reminder.
  if (!board || board.items.length === 0 && reminders.length === 0) return null
  const groups = leadWorkGroups(board), open = board.items.filter(item => item.closedAt === undefined).length
  const close = async (card: LeadWorkCard, outcome: LeadWorkOutcome) => {
    setError(null)
    try { await store.lead.closeWork(card.id, outcome) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  const cancel = async (entry: LeadReminder) => {
    setError(null)
    try { await store.lead.cancelReminder(entry.id) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  return <ToolSection label="Work" fold value={open || undefined}>
    {groups.map(({ group, label, items }) => <ToolGroup key={group} label={label} heading={`${label} · ${items.length}`} data-work-group={group}>
      <ListRows surface="panel">{items.map(card => <ListRow key={card.id} size="sm" data-work-item={card.id}
        title={<span title={card.fact ? sanitizeText(card.fact) : undefined}>{sanitizeText(card.title)}</span>} wrapTitle
        // A reason someone waits is a fact that varies, so it earns the line; everything else stays on hover.
        subtitle={group === 'needs-you' && card.blocker ? sanitizeText(card.blocker) : undefined} wrapSubtitle
        // A chat the person stopped is not finished: its state is a word on the label's line, not a second line.
        trail={<>{card.outcome === 'dropped' ? <Chip tone="neutral">Dropped</Chip> : card.stage === 'stopped' && <Chip tone="neutral">Stopped</Chip>}<WorkActions card={card} onClose={outcome => { void close(card, outcome) }} /></>} />)}</ListRows>
    </ToolGroup>)}
    {reminders.length > 0 && <ToolGroup label="Reminders" heading={`Reminders · ${reminders.length}`} data-work-group="reminders">
      <ListRows surface="panel">{reminders.map(entry => <ListRow key={entry.id} size="sm" data-work-reminder={entry.id}
        title={sanitizeText(entry.text)} wrapTitle
        // When it is due, or when it fired, is the fact that varies, so it earns the line.
        subtitle={entry.state === 'fired' ? `Fired ${formatLeadRunTime(new Date(entry.firedAt ?? entry.dueAt))}` : `Due ${formatLeadRunTime(new Date(entry.dueAt))}`}
        trail={entry.state === 'fired' ? <Chip tone="neutral">Fired</Chip>
          : <Button variant="ghost" size="icon-sm" aria-label={`Cancel reminder: ${sanitizeText(entry.text)}`} title="Cancel reminder" onClick={() => { void cancel(entry) }}><CrossIcon size={16} /></Button>} />)}</ListRows>
    </ToolGroup>}
    {board.more > 0 && <ToolProse variant="note">{board.more} older closed {board.more === 1 ? 'item' : 'items'} not shown</ToolProse>}
    {error && <ToolProse variant="note">{error}</ToolProse>}
  </ToolSection>
}
