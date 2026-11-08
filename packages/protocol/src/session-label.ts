import { openingOf, openingOfContent, opensEnvelope } from './context-envelope.js'
import type { Session } from './session.js'

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
 * How the opening message is called, for a row with no name yet, by the rule
 * every adapter's preview follows (`openingOf`): the person's first line, or
 * for a message that's only blocks, the block that says what the
 * conversation is. It reads every text block of a message, because the
 * composer puts attached context in blocks of its own before the typed words.
 * The first message that says anything answers (review of #231).
 */
export const firstAsk = (session: Session): string | null => {
  for (const turn of session.turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue
      const opening = openingOfContent(item.content)
      if (opening) return opening
    }
  }
  return null
}
