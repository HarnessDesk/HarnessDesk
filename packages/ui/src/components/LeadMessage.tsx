import { itemId } from '@harnessdesk/protocol'
import { ItemView } from './Items'

/** The same item renderer as a session, without inventing a protocol Session. */
export const LeadMessage = ({ role, text, name = 'Lead' }: { readonly role: 'user' | 'assistant'; readonly text: string; readonly name?: string }) => <article aria-label={role === 'user' ? 'You' : name}>
  <ItemView item={role === 'user' ? { id: itemId('lead-user'), type: 'userMessage', content: [{ type: 'text', text }] } : { id: itemId('lead-assistant'), type: 'assistantMessage', text }} />
</article>
