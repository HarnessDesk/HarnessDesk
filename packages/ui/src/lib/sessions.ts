import { sessionLabel, type Session } from '@harnessdesk/protocol'

export { firstAsk, sessionLabel } from '@harnessdesk/protocol'

/**
 * Indexed titles keep the person's name when live runtime metadata is older.
 * Live titles fill a missing indexed title; live previews fill out a row whose
 * first ask has not reached the index yet.
 */
export const indexedSessionLabel = (
  indexed: Pick<Session, 'title' | 'preview'>,
  live?: Pick<Session, 'title' | 'preview'>,
  fallback?: string,
): string => sessionLabel(indexed.title ?? live?.title, live?.preview ?? indexed.preview, fallback)

/**
 * How long a name may be where nothing can elide it for us. 60 keeps the
 * Window menu and the Dock's window list readable at their usual widths.
 */
const TITLE_LIMIT = 60

/** Below this a leading sentence is an interjection ("OK.", "Hi."), not a name. */
const MIN_SENTENCE = 16

/** Trailing punctuation that ends a sentence but should not end a name. */
const tidy = (text: string): string => text.replace(/[.:]$/, '').trim()

/**
 * A name short enough for somewhere that cannot shorten it itself.
 *
 * Lists let CSS truncate, so they keep the whole label and stay searchable.
 * A window title has no such luxury, and an untitled conversation is named by
 * whatever the user typed first — routinely a paragraph. Cutting at the first
 * sentence end usually leaves a real phrase, which is the thing a hard slice
 * at the character limit can never do.
 *
 * A dot inside `index.html` or `v1.2` does not end a sentence; only one
 * followed by a space or the end of the line does.
 */
export const shortLabel = (label: string, max = TITLE_LIMIT): string => {
  const trimmed = label.trim()
  const sentence = tidy(trimmed.match(/^[\s\S]*?[.!?:](?=\s|$)/)?.[0] ?? '')
  const candidate = sentence.length >= MIN_SENTENCE && sentence.length <= max ? sentence : trimmed
  if (candidate.length <= max) return tidy(candidate)
  // Land the ellipsis on a word boundary — unless the opening word runs past
  // the limit on its own and there is no boundary to land on.
  const cut = candidate.slice(0, max)
  const space = cut.lastIndexOf(' ')
  const body = space > max / 2 ? cut.slice(0, space) : cut
  return `${body.replace(/[\s,;:.!?—-]+$/, '')}…`
}
