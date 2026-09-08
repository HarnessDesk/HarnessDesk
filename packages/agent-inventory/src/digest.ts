import { createHash } from 'node:crypto'

/**
 * The one digest both halves of the library use. The scanner detects
 * `differs` with it and the manifest vouches with it, so they must never
 * disagree about what a definition hashes to — trimmed, because a trailing
 * newline is file convention rather than content.
 */
export const digestOf = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
