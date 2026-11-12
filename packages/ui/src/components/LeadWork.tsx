import { useEffect, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { LEAD_WORK_GROUPS, LEAD_WORK_GROUP_LABELS, leadTeamKey, leadWorkOpenCount, leadWorkWaiting, runtimeId, sessionId, sessionKey, type LeadReminder, type LeadWorkBoard, type LeadWorkCard, type LeadWorkGroup, type LeadWorkOutcome, type LeadWorkWaiting } from '@harnessdesk/protocol'
import { Button, Chip, ListRow, ListRows, Menu, MenuItem, MenuNote, MenuSeparator, Popover, ToolGroup, ToolProse, ToolSection } from '../design'
import { formatLeadRunTime } from '../lib/lead-time'
import { useSnapshot, useStore } from '../state/context'
import { useLeadInbox } from './use-inbox-waiting'
import { useRailLeave } from '../panels/top-bar'
import { openExternal } from '../lib/desktop'
import { sanitizeText } from '../lib/sanitize'
import { leadRefusalText } from './lead-refusals'
import { CheckIcon, CommentIcon, CrossIcon, MoreIcon, PullRequestIcon, StopIcon, TeamIcon } from './Icons'

/**
 * The board in its four groups, Needs you first; the phone draws the same groups from the same board. Needs you also
 * holds the Teams and chats the desk says wait on the person that no item stands for, so it counts what the header counts.
 */
export const leadWorkGroups = (board: LeadWorkBoard, waiting: readonly LeadWorkWaiting[] = []): readonly { readonly group: LeadWorkGroup; readonly label: string; readonly items: readonly LeadWorkCard[]; readonly waiting: readonly LeadWorkWaiting[] }[] =>
  LEAD_WORK_GROUPS.map(group => ({ group, label: LEAD_WORK_GROUP_LABELS[group], items: board.items.filter(item => item.group === group), waiting: group === 'needs-you' ? waiting : [] }))
    .filter(entry => entry.items.length + entry.waiting.length > 0)

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

/**
 * A press on the row's own body: its name or its line. The trail's controls, and a menu they open (portalled, so its
 * clicks still reach the row through React), answer for themselves.
 */
const fromRow = (event: MouseEvent<HTMLElement>): boolean =>
  event.target instanceof Node && event.currentTarget.contains(event.target) && !(event.target instanceof Element && event.target.closest('[data-slot="list-row-trail"]'))

/** How often its attempts were stopped, on hover: "Stopped 2 times, by you each time". Nothing for a single stop. */
const stopsTitle = (card: LeadWorkCard): string | undefined => {
  const stops = card.stops ?? []
  if (stops.length < 2) return card.stoppedBy === 'lead' ? 'The Lead stopped its chat' : undefined
  const mine = stops.filter(stop => stop.by === 'person').length
  return `Stopped ${stops.length} times${mine === stops.length ? ', by you each time' : mine ? `, ${mine} by you` : ''}`
}

/** A reminder's line: when it is due, or what became of it. A fired reminder for the person is Said once the Lead's
 * message was written, Missed when it never was, and not said yet while the Lead is still writing it. */
const reminderLine = (entry: LeadReminder): string => {
  if (entry.state !== 'fired') return `Due ${formatLeadRunTime(new Date(entry.dueAt))}`
  if (entry.delivery === 'said') return `Said ${formatLeadRunTime(new Date(entry.deliveredAt ?? entry.firedAt ?? entry.dueAt))}`
  if (entry.delivery === 'missed') return `Missed ${formatLeadRunTime(new Date(entry.deliveredAt ?? entry.firedAt ?? entry.dueAt))}`
  const fired = `Fired ${formatLeadRunTime(new Date(entry.firedAt ?? entry.dueAt))}`
  return entry.for === 'person' ? `${fired}, not said yet` : fired
}

/** Reminders the person can see: every one still set, and the ones that fired in the last day. A cancelled one is gone. */
/** The Work card's header: where a door to a row that is gone lands, so the person is shown where it was. */
export const LEAD_WORK_LANDING = 'section[data-slot="tool-section"][aria-label="Work"] [data-slot="tool-section-fold"]'
export const leadVisibleReminders = (board: LeadWorkBoard | null | undefined): readonly LeadReminder[] =>
  (board?.reminders ?? []).filter(entry => entry.state === 'set' || entry.state === 'fired')

/**
 * The Lead's work, as the host derives it from the desk: every piece of work the person asked for, grouped by who it
 * waits on. Stages are read, never set here; the only change this card makes is the person's own Done or Drop.
 */
export const LeadWork = () => {
  const store = useStore(), state = useSyncExternalStore(store.lead.subscribe, () => store.lead.state)
  const [error, setError] = useState<string | null>(null), leave = useRailLeave()
  useEffect(() => { void store.lead.readWork().catch(() => {}) }, [store, state.revision])
  const board = state.work, inbox = useLeadInbox(), goals = useSnapshot().goals
  const reminders = leadVisibleReminders(board)
  // A Team is one Team whichever of its names the board and the inbox hold: its goal id or the room its board is.
  const waiting = board ? leadWorkWaiting(board, inbox, leadTeamKey([...goals.values()].map(view => ({ goal: view.goal.id, room: view.board?.id ?? null })))) : []
  // Nothing tracked yet is not a card: the rail stays as it was until the Lead starts work or sets a reminder.
  if (!board || board.items.length === 0 && reminders.length === 0 && waiting.length === 0) return null
  const groups = leadWorkGroups(board, waiting), open = leadWorkOpenCount(board, waiting)
  // Opening what a row stands for takes the person there, so a floating rail goes with them (#2175).
  const openWaiting = (entry: LeadWorkWaiting) => {
    if (entry.kind === 'team') { store.openGoal(entry.id); leave(); return }
    const key = chatKey(entry.id)
    if (key) { void store.openSession(key.session, { runtime: key.runtime }); leave() }
  }
  // An item opens what it stands for: its Team when it has one, else its latest chat. Nothing to open, nothing to press.
  const itemDoor = (card: LeadWorkCard): (() => void) | undefined => {
    const team = card.links.teams.at(-1), chat = card.links.chats.at(-1), key = chat ? chatKey(chat) : null
    if (team) return () => { store.openTeamRoom(team); leave() }
    if (key) return () => { void store.openSession(key.session, { runtime: key.runtime }); leave() }
    return undefined
  }
  const close = async (card: LeadWorkCard, outcome: LeadWorkOutcome) => {
    setError(null)
    try { await store.lead.closeWork(card.id, outcome) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  const cancel = async (entry: LeadReminder) => {
    setError(null)
    try { await store.lead.cancelReminder(entry.id) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  const clear = async (entry: LeadReminder) => {
    setError(null)
    try { await store.lead.clearReminder(entry.id) } catch (failure) { setError(leadRefusalText(failure)) }
  }
  return <ToolSection label="Work" fold value={open || undefined}>
    {groups.map(({ group, label, items, waiting: others }) => <ToolGroup key={group} label={label} heading={`${label} · ${items.length + others.length}`} data-work-group={group}>
      <ListRows surface="panel">{others.map(entry => <ListRow key={`${entry.kind}:${entry.id}`} size="sm" data-work-waiting={entry.id}
        interactive onClick={event => { if (fromRow(event)) openWaiting(entry) }}
        // Where it lives is on hover: the row says what waits, and its own page says why.
        title={<span title={entry.project ? sanitizeText(entry.project) : undefined}>{sanitizeText(entry.title)}</span>} wrapTitle
        trail={<Button variant="ghost" size="icon-sm" aria-label={`Open ${sanitizeText(entry.title)}`} title={entry.kind === 'team' ? 'Open Team' : 'Open chat'}
          onClick={() => openWaiting(entry)}>{entry.kind === 'team' ? <TeamIcon size={16} /> : <CommentIcon size={16} />}</Button>} />)}
      {items.map(card => { const door = itemDoor(card); return <ListRow key={card.id} size="sm" data-work-item={card.id}
        interactive={!!door} onClick={door && (event => { if (fromRow(event)) door() })}
        title={<span title={card.fact ? sanitizeText(card.fact) : undefined}>{sanitizeText(card.title)}</span>} wrapTitle
        // A reason someone waits is a fact that varies, so it earns the line; everything else stays on hover.
        subtitle={group === 'needs-you' && card.blocker ? sanitizeText(card.blocker) : undefined} wrapSubtitle
        // A chat the person stopped is not finished: its state is a word on the label's line, not a second line. Who
        // stopped it is the host's record, said in the reader's words, as the digest and the phone say it.
        trail={<>{card.outcome === 'dropped' ? <Chip tone="neutral">Dropped</Chip> : card.stage === 'stopped' && <Chip tone="neutral" title={stopsTitle(card)}>{card.stoppedBy === 'person' ? 'You stopped it' : 'Stopped'}</Chip>}<WorkActions card={card} onClose={outcome => { void close(card, outcome) }} /></>} /> })}</ListRows>
    </ToolGroup>)}
    {reminders.length > 0 && <ToolGroup label="Reminders" heading={`Reminders · ${reminders.length}`} data-work-group="reminders">
      <ListRows surface="panel">{reminders.map(entry => <ListRow key={entry.id} size="sm" data-work-reminder={entry.id} tabIndex={-1}
        title={sanitizeText(entry.text)} wrapTitle
        // When it is due, or what became of it, is the fact that varies, so it earns the line. A person's reminder says
        // Said only once the Lead's message was written; one the Lead never wrote says Missed, never Fired as if said.
        subtitle={reminderLine(entry)}
        // The Lead's own check-back is a kind, so it is a word on the label's line: quiet hours and autonomy hold it.
        // A set one is cancelled; one that fired is cleared, which takes it off this card and out of what the Lead is told.
        trail={entry.state === 'set' ? <>{entry.for === 'lead' && <Chip tone="neutral" title="The Lead's own check-back: quiet hours and your autonomy settings hold it">Check-back</Chip>}
          <Button variant="ghost" size="icon-sm" aria-label={`Cancel reminder: ${sanitizeText(entry.text)}`} title="Cancel reminder" onClick={() => { void cancel(entry) }}><CrossIcon size={16} /></Button></>
          : <Button variant="ghost" size="icon-sm" aria-label={`Clear reminder: ${sanitizeText(entry.text)}`} title="Clear reminder" onClick={() => { void clear(entry) }}><CrossIcon size={16} /></Button>} />)}</ListRows>
    </ToolGroup>}
    {board.more > 0 && <ToolProse variant="note">{board.more} older closed {board.more === 1 ? 'item' : 'items'} not shown</ToolProse>}
    {error && <ToolProse variant="note">{error}</ToolProse>}
  </ToolSection>
}
