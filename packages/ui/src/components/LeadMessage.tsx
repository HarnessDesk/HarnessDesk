import type { LeadAsk, LeadAskState, LeadProactive } from '@harnessdesk/protocol'
import { LeadProactiveCard } from './LeadCards'
import { useState, type ReactNode } from 'react'
import { itemId, leadTriggerLine, type LeadMessageTrigger, type LeadName } from '@harnessdesk/protocol'
import { Button, Chip, CodeText, Dialog, Text, LeadAvatar, LeadLineNote, LeadTurn, LeadAskOptions } from '../design'
import { ItemView } from './Items'
import { sanitizeText } from '../lib/sanitize'
import { openExternal } from '../lib/desktop'
import { LeadCheckpointNotice } from './LeadCheckpoint'

/** The same item renderer as a session, without inventing a protocol Session. A Lead line keeps a face column; only a turn's first line fills it. */
export const LeadMessage = ({ role, text, name = 'Lead', lead = null, face = false, note, proactive, ask, settled, onAnswer, disabled, picked, onAction, working }: { readonly working?: ReactNode; readonly role: 'user' | 'assistant'; readonly text: string; readonly name?: string; readonly lead?: LeadName | null; readonly face?: boolean; readonly note?: ReactNode; readonly proactive?: LeadProactive; readonly ask?: LeadAsk; readonly settled?: LeadAskState; readonly onAnswer?: (label: string) => void; readonly disabled?: boolean; readonly picked?: string; readonly onAction?: (action: NonNullable<LeadProactive['action']>) => void }) => {
  const item = text.trim() ? <ItemView item={role === 'user' ? { id: itemId('lead-user'), type: 'userMessage', content: [{ type: 'text', text }] } : { id: itemId('lead-assistant'), type: 'assistantMessage', text }} /> : null
  return <article aria-label={role === 'user' ? 'You' : name}>
    {role === 'user' ? <>{item}{note && <LeadLineNote>{note}</LeadLineNote>}</> : <LeadTurn face={face && <LeadAvatar name={lead} size="turn" />}>{working ?? (proactive ? <LeadProactiveCard report={proactive} onAction={onAction} onAnswer={onAnswer} disabled={disabled} picked={picked} settled={settled} /> : <>{item}{ask && <LeadAskOptions ask={ask} settled={settled} onAnswer={onAnswer} disabled={disabled} picked={picked} />}</>)}{!working && note}</LeadTurn>}
  </article>
}

/** A host acknowledgement is data, never an assistant turn or Markdown authored by the Lead. */
export const LeadHostNotice = ({ message }: { readonly message: import('@harnessdesk/protocol').LeadMessage }) => {
  const [open, setOpen] = useState(false), approval = message.approval
  if (message.checkpoint) return <LeadCheckpointNotice checkpoint={message.checkpoint} />
  if (message.trigger) return <LeadTriggerNotice trigger={message.trigger} />
  return <article aria-label="Desk">
    <Text as="p" role="meta">{sanitizeText(message.text)}</Text>
    {approval?.diff !== undefined && <Button variant="secondary" onClick={() => setOpen(true)}>View changes</Button>}
    {open && approval?.diff !== undefined && <Dialog title="Changes under this approval" description={sanitizeText(approval.target)} onClose={() => setOpen(false)}
      footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      {message.id.startsWith('worker-rule-orphan-') && <Chip tone="warning">Needs review</Chip>}
      <CodeText block wrap>{sanitizeText(approval.diff)}</CodeText>
    </Dialog>}
  </article>
}

/**
 * What opened a goal a trigger started (#2183), in place of the prompt the model read: the desk's own line, made from
 * the trigger's validated facts and linked to where it happened, then the asker's words (or the event's title) quoted as
 * plain, untrusted text. It is never the person's bubble, and the words never pass as the desk's or the person's own.
 */
export const LeadTriggerNotice = ({ trigger }: { readonly trigger: LeadMessageTrigger }) => {
  const line = leadTriggerLine(trigger), url = trigger.url && /^https:\/\//i.test(trigger.url) ? trigger.url : null
  const words = trigger.words ? sanitizeText(trigger.words).trim() : ''
  return <article aria-label={line} data-slot="lead-trigger">
    <Text as="p" role="meta">{url ? <Button variant="link" size="inline-link" title={url} onClick={() => openExternal(url)}>{line}</Button> : line}</Text>
    {words && <Text as="p" role="muted" data-lead-trigger-words="">{`\u201c${words}\u201d`}</Text>}
  </article>
}
