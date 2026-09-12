import { openingOf, opensEnvelope } from './context-envelope'

/**
 * A conversation's display name. Titles win; otherwise the preview — the
 * first thing the user wrote — with any context block HarnessDesk prepended
 * (a hand-off packet, a referenced conversation) stripped, since that block
 * was written for the model, not for the list. A message that is only blocks —
 * a hand-off sent with nothing typed — is called by its first block's label,
 * the hand-off's, which is how the host, the adapters and the Cursor bridge
 * name it too (`openingOf`, #186).
 */
export const sessionLabel = (
  title: string | null | undefined,
  preview: string | null | undefined,
  fallback = 'Untitled session',
): string => {
  const firstLine = (raw: string): string => {
    const text = openingOf(raw)
    // An agent's own title may be a truncated block with no closing tag —
    // the splitter leaves it whole: all envelope, no name. What counts as an
    // envelope is the protocol's to say, not a fourth copy of the pattern
    // here: words that only start with it, `<context-free grammars`, are a
    // name (review of #207, round 1; #224).
    const candidate = opensEnvelope(text) ? '' : text
    return candidate.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
  }
  const titled = firstLine(title?.trim() ?? '')
  if (titled) return titled
  return firstLine(preview?.trim() ?? '') || fallback
}

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
