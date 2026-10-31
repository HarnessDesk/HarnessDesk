import type { LeadProactive } from '@harnessdesk/protocol'
import { LeadProactiveCard } from './LeadCards'
import { useState, type ReactNode } from 'react'
import { itemId, type LeadName } from '@harnessdesk/protocol'
import { Button, CodeText, Dialog, Text, LeadAvatar, LeadLineNote, LeadTurn } from '../design'
import { ItemView } from './Items'

/** The same item renderer as a session, without inventing a protocol Session. A Lead line keeps a face column; only a turn's first line fills it. */
export const LeadMessage = ({ role, text, name = 'Lead', lead = null, face = false, note, proactive, onAction }: { readonly role: 'user' | 'assistant'; readonly text: string; readonly name?: string; readonly lead?: LeadName | null; readonly face?: boolean; readonly note?: ReactNode; readonly proactive?: LeadProactive; readonly onAction?: (action: NonNullable<LeadProactive['action']>) => void }) => {
  const item = <ItemView item={role === 'user' ? { id: itemId('lead-user'), type: 'userMessage', content: [{ type: 'text', text }] } : { id: itemId('lead-assistant'), type: 'assistantMessage', text }} />
  return <article aria-label={role === 'user' ? 'You' : name}>
    {role === 'user' ? <>{item}{note && <LeadLineNote>{note}</LeadLineNote>}</> : <LeadTurn face={face && <LeadAvatar name={lead} size="turn" />}>{proactive ? <LeadProactiveCard report={proactive} onAction={onAction} /> : item}</LeadTurn>}
  </article>
}

/** A host acknowledgement is data, never an assistant turn or Markdown authored by the Lead. */
export const LeadHostNotice = ({ message }: { readonly message: import('@harnessdesk/protocol').LeadMessage }) => {
  const [open, setOpen] = useState(false), approval = message.approval
  return <article aria-label="Desk">
    <Text as="p" role="meta">{message.text}</Text>
    {approval?.diff !== undefined && <Button variant="secondary" onClick={() => setOpen(true)}>View allowed diff</Button>}
    {open && approval?.diff !== undefined && <Dialog title="Allowed diff" description={approval.target} onClose={() => setOpen(false)}
      footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      <CodeText block wrap>{approval.diff}</CodeText>
    </Dialog>}
  </article>
}
