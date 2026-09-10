/**
 * Detecting `/` and `@` in the composer.
 *
 * Extracted so the rules are testable on their own: the difference between a
 * command and a path, or a mention and an email address, is exactly the kind of
 * thing that regresses silently inside a component.
 */

export type TriggerMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'command'; readonly query: string }
  | { readonly kind: 'file'; readonly query: string }

/** A command runs from the start of a line only — `src/a.ts` is a path, not `/a`. */
export const COMMAND_PATTERN = /(?:^|\n)\/([^\s/]*)$/
/** A mention starts a word, so `user@example.com` does not open the file picker. */
export const MENTION_PATTERN = /(?:^|\s)@([^\s@]*)$/

export const detectTrigger = (text: string): TriggerMatch => {
  const command = COMMAND_PATTERN.exec(text)
  if (command) return { kind: 'command', query: command[1] ?? '' }
  const mention = MENTION_PATTERN.exec(text)
  if (mention) return { kind: 'file', query: mention[1] ?? '' }
  return { kind: 'none' }
}

/** Removes the trigger token, keeping whatever was typed around it. */
export const stripTrigger = (text: string, kind: 'command' | 'file'): string =>
  kind === 'command'
    ? text.replace(COMMAND_PATTERN, (whole) => (whole.startsWith('\n') ? '\n' : ''))
    : text.replace(MENTION_PATTERN, (whole) => (whole.startsWith('@') ? '' : whole.slice(0, 1)))

/** Wraps an index into range, so arrow keys cycle rather than stopping. */
export const cycle = (index: number, delta: number, length: number): number =>
  length === 0 ? 0 : (index + delta + length) % length

/**
 * The `@` alone, for a surface where it points at a person rather than a file.
 *
 * The room's composer and the conversation's share this pattern deliberately:
 * `@` means *point at something by name* in both, and what is worth pointing
 * at is what differs — a file in a conversation, a member in a room. Sharing
 * the regex is what keeps `user@example.com` from opening a picker in one of
 * them and not the other.
 */
export const detectMention = (text: string): { readonly query: string } | null => {
  const mention = MENTION_PATTERN.exec(text)
  return mention ? { query: mention[1] ?? '' } : null
}

/**
 * Removes the `@token`, keeping whatever was typed around it.
 *
 * Its own implementation rather than `stripTrigger(text, 'file')`, which is
 * what it was. The two share `MENTION_PATTERN`, and that coupling is the
 * point — `@` detects identically in both surfaces. Sharing the *strip* was
 * incidental: it meant a change to how a file trigger is removed from a
 * conversation's draft would silently change how a member mention is removed
 * from a room's, and nothing would fail.
 */
export const stripMention = (text: string): string =>
  text.replace(MENTION_PATTERN, (whole) => (whole.startsWith('@') ? '' : whole.slice(0, 1)))

/**
 * The space a picked mention leaves behind, when the next thing typed is
 * punctuation.
 *
 * `Hey @Claude` picked leaves `Hey ` — right, because the next thing is
 * usually a word. Then the person types `, could you run the build?` and the
 * draft reads `Hey , could you run the build?`. The orphan space is the one
 * artifact this gesture produces, and it produces it in the shape people
 * write most: a name, a comma, a request.
 *
 * So it is closed on the *next keystroke* rather than at strip time, where
 * the punctuation does not exist yet: exactly one character, one of these
 * five, typed straight onto the space a pick left. Narrow on purpose —
 * anything wider is a text box that edits what you typed.
 */
export const closeMentionGap = (before: string, after: string): string =>
  before.endsWith(' ') && after.length === before.length + 1 && after.startsWith(before) && /[,.;:!?]/.test(after.slice(-1))
    ? `${before.slice(0, -1)}${after.slice(-1)}`
    : after
