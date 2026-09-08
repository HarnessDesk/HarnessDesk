/**
 * Matching-line extraction and highlight ranges for search results.
 *
 * Given a query and a block of text, finds the first line containing a
 * case-insensitive match and returns the line trimmed to a display-friendly
 * length with the match span marked. Used by the CommandPalette to show where
 * in a session the hit occurred.
 *
 * Text is stripped of HTML before matching (rule 5: agent output is untrusted).
 */

/** A span within a line where the query matched. */
export interface HighlightSpan {
  /** Byte offset of the match start within `line`. */
  readonly start: number
  /** Byte offset one past the match end within `line`. */
  readonly end: number
}

export interface SearchHit {
  /** The line containing the match, trimmed to `maxLen`. */
  readonly line: string
  /** Spans within `line` to highlight. */
  readonly spans: readonly HighlightSpan[]
}

const MAX_LINE_LEN = 120

const STRIP_HTML = /<[^>]*>/g
const COLLAPSE_SPACES = /[^\S\n]+/g
const TRIM_BLANK_LINES = /\n{3,}/g

/** Removes HTML tags and collapses runs of spaces (preserving line breaks). */
export const stripForSearch = (text: string): string =>
  text
    .replace(STRIP_HTML, ' ')
    .replace(COLLAPSE_SPACES, ' ')
    .replace(TRIM_BLANK_LINES, '\n\n')
    .trim()

/**
 * Finds the first line in `text` that contains `query` (case-insensitive) and
 * returns it trimmed with the match span.  Returns `null` when there is no
 * match.
 */
export const extractHit = (query: string, text: string): SearchHit | null => {
  if (!query || !text) return null
  const clean = stripForSearch(text)
  const needle = query.toLowerCase()
  const idx = clean.toLowerCase().indexOf(needle)
  if (idx === -1) return null

  // Walk back to the nearest line break or start; forward to the next or end.
  let lineStart = clean.lastIndexOf('\n', idx)
  lineStart = lineStart === -1 ? 0 : lineStart + 1
  let lineEnd = clean.indexOf('\n', idx + needle.length)
  if (lineEnd === -1) lineEnd = clean.length

  let line = clean.slice(lineStart, lineEnd)
  let matchStart = idx - lineStart
  let matchEnd = matchStart + needle.length

  // Trim long lines around the match, keeping the match visible.
  if (line.length > MAX_LINE_LEN) {
    const pad = Math.floor((MAX_LINE_LEN - needle.length) / 2)
    let trimStart = Math.max(0, matchStart - pad)
    let trimEnd = Math.min(line.length, matchEnd + pad)
    if (trimEnd - trimStart < MAX_LINE_LEN) {
      trimEnd = Math.min(line.length, trimStart + MAX_LINE_LEN)
    }
    if (trimEnd - trimStart < MAX_LINE_LEN) {
      trimStart = Math.max(0, trimEnd - MAX_LINE_LEN)
    }
    const prefix = trimStart > 0 ? '…' : ''
    const suffix = trimEnd < line.length ? '…' : ''
    line = prefix + line.slice(trimStart, trimEnd) + suffix
    matchStart = matchStart - trimStart + prefix.length
    matchEnd = matchStart + needle.length
  }

  return { line, spans: [{ start: matchStart, end: matchEnd }] }
}

/**
 * Finds all non-overlapping matches in `text` and returns them as spans,
 * operating on a single line (already extracted). Case-insensitive.
 */
export const highlightAll = (query: string, line: string): readonly HighlightSpan[] => {
  if (!query || !line) return []
  const needle = query.toLowerCase()
  const haystack = line.toLowerCase()
  const spans: HighlightSpan[] = []
  let from = 0
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    spans.push({ start: at, end: at + needle.length })
    from = at + needle.length
  }
  return spans
}
