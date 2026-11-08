import type { Session } from '@harnessdesk/protocol'
import type { MouseEvent } from 'react'
import { ConversationShell, ConversationThread, Separator } from '../design'
import { fileLink } from '../lib/file-link'
import { useStore } from '../state/context'
import { ItemView, ReadOnlyTranscript } from './Items'

/** The shared transcript items, without the conversation's composer or controls. */
export const AdjacentTranscript = ({ session }: { session: Session }) => {
  const store = useStore()
  const fileClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link || !event.currentTarget.contains(link) || !fileLink(link.getAttribute('href') ?? '')) return
    event.preventDefault()
    store.notice('warning', 'File links are unavailable in the adjacent conversation.')
  }
  return <ReadOnlyTranscript>
    <ConversationShell><ConversationThread data-transcript="" aria-label="Read-only transcript" onClick={fileClick} onAuxClick={fileClick}>
      {session.turns.map((turn, index) => <div key={turn.id}>
        {index > 0 && <Separator />}
        {turn.items.map(item => <ItemView key={item.id} item={item} root={session.cwd} sentAt={turn.startedAt ?? undefined} />)}
      </div>)}
    </ConversationThread></ConversationShell>
  </ReadOnlyTranscript>
}
