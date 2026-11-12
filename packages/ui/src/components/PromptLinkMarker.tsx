import { useEffect, useRef } from 'react'

import { ComposerNotice } from '../design'
import { useSnapshotSelector, useStore } from '../state/context'

/**
 * The mark over a new chat's composer whose words came from a prompt link
 * (`harnessdesk://new`): those words are someone else's until the person
 * has read them. It stays while the composer holds exactly what the link
 * put there, and ends at the first edit or the send — the words are the
 * person's own from then on. The link's own text is only ever in the
 * composer; the mark says what else it asked for in plain words.
 */
export const PromptLinkMarker = ({ text }: { readonly text: string }) => {
  const store = useStore()
  const marked = useSnapshotSelector((snapshot) => snapshot.promptLinkDraft)
  const matches = marked !== null && text === marked.text
  // The composer is filled a frame after the draft opens; only a change
  // after the words have landed is an edit.
  const landed = useRef(false)
  useEffect(() => {
    if (!marked) {
      landed.current = false
      return
    }
    if (matches) landed.current = true
    else if (landed.current) {
      landed.current = false
      store.endPromptLinkDraft()
    }
  }, [marked, matches, store])
  if (!marked || !matches) return null
  return (
    <ComposerNotice
      message={{
        id: 'composer-prompt-link',
        tone: 'info',
        title: 'From a link — review before sending.',
        ...(marked.context ? { body: marked.context } : {}),
      }}
    />
  )
}
