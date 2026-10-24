import { itemId, type LeadName } from '@harnessdesk/protocol'
import { LeadAvatar } from '../design'
import { ItemView } from './Items'
import styles from './Lead.module.css'

/** The same item renderer as a session, without inventing a protocol Session. A Lead line keeps a face column; only a turn's first line fills it. */
export const LeadMessage = ({ role, text, name = 'Lead', lead = null, face = false }: { readonly role: 'user' | 'assistant'; readonly text: string; readonly name?: string; readonly lead?: LeadName | null; readonly face?: boolean }) => {
  const item = <ItemView item={role === 'user' ? { id: itemId('lead-user'), type: 'userMessage', content: [{ type: 'text', text }] } : { id: itemId('lead-assistant'), type: 'assistantMessage', text }} />
  return <article aria-label={role === 'user' ? 'You' : name}>
    {role === 'user' ? item : <div className={styles.turn}><span className={styles.turnFace} data-slot="lead-turn-face">{face && <LeadAvatar name={lead} size="turn" />}</span><div className={styles.turnBody}>{item}</div></div>}
  </article>
}
