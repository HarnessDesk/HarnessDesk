import type { ReactNode, Ref } from 'react'
import { itemId } from '@harnessdesk/protocol'
import { ItemView } from '../../components/Items'
import { Markdown } from '../../components/Markdown'
import { TranscriptAssistantMessage } from './ConversationShell'
import { Text } from './Settings'

/** A decision's details are ordinary assistant prose; its controls live in the dock. */
export const LeadContract = ({ summary, children, cardId, cardType, focusRef, state }: {
  readonly summary?: string
  readonly children?: ReactNode
  readonly cardType?: string
  readonly cardId?: string
  readonly focusRef?: Ref<HTMLElement>
  readonly state?: string
}) => <TranscriptAssistantMessage><section ref={focusRef} tabIndex={-1} data-slot="lead-contract" data-lead-card={cardId} data-lead-card-type={cardType} aria-label="Lead decision" className="min-w-0 break-words">
  {summary !== undefined && <div data-lead-prose><Markdown text={summary} /></div>}
  {children}
  {state && <Text as="p" role="meta" data-lead-state>{state}</Text>}
</section></TranscriptAssistantMessage>

/** The same item renderer as a session, without inventing a protocol Session. */
export const LeadMessage = ({ role, text, name = 'Dex' }: { readonly role: 'user' | 'assistant'; readonly text: string; readonly name?: string }) => <article aria-label={role === 'user' ? 'You' : name}>
  <ItemView item={role === 'user' ? { id: itemId('lead-user'), type: 'userMessage', content: [{ type: 'text', text }] } : { id: itemId('lead-assistant'), type: 'assistantMessage', text }} />
</article>
