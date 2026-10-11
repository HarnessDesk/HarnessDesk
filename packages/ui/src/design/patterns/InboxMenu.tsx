import { Fragment, useRef, useState } from 'react'
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from './Menu'
import { Chip, CodeText } from './Settings'
import { MiddleTruncate } from '../ui/key-value'
import type { InboxList } from './Notices'

export const InboxMenu = ({ messages, onOpen, onMarkAllRead, onClear, now = Date.now(), close }:
  Parameters<typeof InboxList>[0] & { close: () => void }) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const unread = messages.filter(message => !message.read).length
  const marked = useRef(new Set<string>())
  const today = new Date(now).toDateString()
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  const groups: { name: string; items: (typeof messages)[number][] }[] = []
  for (const message of messages) {
    const day = new Date(message.at ?? now)
    const name = day.toDateString() === today ? 'Today' : day.toDateString() === yesterday.toDateString() ? 'Yesterday' : day.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    const group = groups.find(one => one.name === name)
    if (group) group.items.push(message)
    else groups.push({ name, items: [message] })
  }
  return <Menu close={close}>
    <MenuLabel>Inbox{unread ? ` · ${unread} new` : ''}</MenuLabel>
    {messages.length === 0 && <MenuNote>Nothing kept yet. Messages an Agent sends you wait here.</MenuNote>}
    {groups.map(group => <Fragment key={group.name}>
      <MenuLabel>{group.name}</MenuLabel>
      {group.items.map(message => <Fragment key={message.id}>
        <MenuItem label={message.title} expanded={expanded.has(message.id)} keepOpen
          badge={!message.read ? <Chip size="sm" tone="brand">Unread</Chip> : undefined}
          value={[message.count && message.count > 1 ? `×${message.count}` : '', message.at === undefined ? '' : new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ')}
          title={!message.read ? 'Mark read and expand message' : expanded.has(message.id) ? 'Collapse message' : 'Expand message'}
          onSelect={() => {
            if (!message.read && !marked.current.has(message.id)) { marked.current.add(message.id); onOpen?.(message.id) }
            setExpanded(current => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next })
          }} />
        {expanded.has(message.id) && <>
          <MenuNote tone={message.tone}><span data-part="inbox-full-title">{message.title}</span></MenuNote>
          {message.from && <MenuNote tone={message.tone}>{message.from}</MenuNote>}
          {message.body && <MenuNote tone={message.tone}>{message.body}</MenuNote>}
          {message.file && <MenuNote tone={message.tone}>In <MiddleTruncate>{message.file}</MiddleTruncate></MenuNote>}
          {message.settings?.map(setting => <MenuNote key={setting} tone={message.tone}><CodeText>{setting}</CodeText></MenuNote>)}
          {message.go && <MenuItem label={message.goLabel ?? 'Open the conversation'} onSelect={message.go} />}
          {[...(message.action ? [message.action] : []), ...(message.actions ?? [])].map(action => <MenuItem key={action.label} label={action.label} shortcut={action.shortcut} onSelect={action.onSelect} />)}
        </>}
      </Fragment>)}
    </Fragment>)}
    {(onMarkAllRead && unread > 0 || onClear && messages.length > 0) && <MenuSeparator />}
    {onMarkAllRead && unread > 0 && <MenuItem label="Mark all read" keepOpen onSelect={onMarkAllRead} />}
    {onClear && messages.length > 0 && <MenuItem label="Clear the inbox" onSelect={onClear} />}
    <MenuSeparator /><div data-menu-footer="">Kept until you clear them.</div>
  </Menu>
}
