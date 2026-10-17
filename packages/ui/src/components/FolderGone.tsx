import { sessionKey, splitSessionKey } from '@harnessdesk/protocol'

import { useSessionKey, useSnapshot, useStore } from '../state/context'
import { Banner, BannerAction, MiddleTruncate } from '../design'

/**
 * What a conversation says when the folder it ran in is gone.
 *
 * It sits where the composer would be, because that is the thing it is
 * answering: there is nowhere to send a message to. The transcript above it is
 * whole — the host keeps its own copy and serves it when the agent cannot —
 * so the pane is not broken, it is *read-only*, and saying which of those two
 * it is was the whole complaint (#127). This used to be a toast per open, and
 * three conversations from one deleted worktree were three identical toasts
 * over three perfectly readable transcripts.
 *
 * Keep the agent's refusal, shortening only the folder path to its name. The
 * full path stays on hover; a refusal that omits it gets the name as a prefix.
 */
export const FolderGone = ({ folder, said }: { readonly folder: string; readonly said: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const key = useSessionKey()
  const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder
  const folderName = <MiddleTruncate title={folder}>{name}</MiddleTruncate>
  const parts = said.split(folder)
  /* Every conversation this folder took, not only the one in front. A deleted
     worktree is one piece of news however many conversations ran in it, and
     the count is what tells the reader whether the row they are looking at is
     the whole of it — a review room's three members are the case that made
     this an issue.
     We check both active sessions and history, deduplicated by session key. */
  const inFolder = new Set<string>()
  for (const session of snapshot.sessions.values()) {
    if (session.cwd === folder) {
      inFolder.add(String(sessionKey(session.runtime, session.id)))
    }
  }
  for (const summary of snapshot.history) {
    if (summary.cwd === folder) {
      inFolder.add(String(sessionKey(summary.runtime, summary.id)))
    }
  }
  const also = Math.max(0, inFolder.size - 1)

  return (
    <Banner
      tone="warning"
      role="status"
      title="This conversation's folder is gone"
      actions={<>
        <BannerAction
          title="Starts a new conversation with this one's summary; you choose the folder."
          onClick={() => { if (key) void store.openCopyElsewhere(key) }}
        >Open a copy in another folder</BannerAction>
        <BannerAction variant="secondary" onClick={() => {
          if (!key) return
          const { runtime, id } = splitSessionKey(key)
          void store.archiveSession(id, runtime)
        }}>Archive</BannerAction>
      </>}
    >
      {parts.length > 1
        ? parts.map((part, index) => <span key={index}>{index > 0 && folderName}{part}</span>)
        : <>{folderName}: {said}</>} The transcript is here to read; nothing more can be sent to it.
      {also > 0 && ` ${also === 1 ? 'One other conversation' : `${also} other conversations`} ran in the same folder.`}
    </Banner>
  )
}
