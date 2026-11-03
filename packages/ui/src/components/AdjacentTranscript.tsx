import type { Session } from '@harnessdesk/protocol'
import { ConversationShell, ConversationThread, Separator } from '../design'
import { ItemView, ReadOnlyTranscript } from './Items'

/** The shared transcript items, without the conversation's composer or controls. */
export const AdjacentTranscript = ({ session }: { session: Session }) => <ReadOnlyTranscript>
  <ConversationShell><ConversationThread data-transcript="" aria-label="Read-only transcript">
    {session.turns.map((turn, index) => <div key={turn.id}>
      {index > 0 && <Separator />}
      {turn.items.map(item => <ItemView key={item.id} item={item} root={session.cwd} sentAt={turn.startedAt ?? undefined} />)}
    </div>)}
  </ConversationThread></ConversationShell>
</ReadOnlyTranscript>
