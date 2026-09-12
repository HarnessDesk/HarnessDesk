import { useSnapshot, useStore } from '../state/context'
import { Banner, BannerAction } from '../design/primitives/Banner'

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
 * The refusal is printed in the agent's own words rather than paraphrased: it
 * names the agent, the folder, and why, and a second sentence written here
 * would only be a worse version of one we already have.
 */
export const FolderGone = ({ folder, said }: { readonly folder: string; readonly said: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  /* Every conversation this folder took, not only the one in front. A deleted
     worktree is one piece of news however many conversations ran in it, and
     the count is what tells the reader whether the row they are looking at is
     the whole of it — a review room's three members are the case that made
     this an issue. */
  const also = [...snapshot.sessions.values()].filter((one) => one.cwd === folder).length - 1

  return (
    <Banner
      tone="warning"
      role="status"
      title="This conversation's folder is gone"
      actions={<BannerAction onClick={() => void store.openCopyElsewhere()}>Open a copy in another folder</BannerAction>}
    >
      {said} The transcript is here to read; nothing more can be sent to it.
      {also > 0 && ` ${also === 1 ? 'One other conversation' : `${also} other conversations`} ran in the same folder.`}
    </Banner>
  )
}
