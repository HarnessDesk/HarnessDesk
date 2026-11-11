/** Where the structured `lead-output` envelope sits in a reply that is not the envelope alone.
 *
 * The instructions ask for the envelope as the whole text, but a model also writes it after its prose, or inside a
 * final code fence. Either way it is the reply's last block, and it is read as the envelope; what is left is the prose.
 * An envelope anywhere else, quoted from a worker or in the middle of the words, is somebody's output being shown and
 * stays text. Nothing here grants authority; the caller validates the decoded value as before. */

const MARKER = /"type"\s*:\s*"lead-output"/
/** Bounds the search: the candidate openings tried before the marker. */
const ATTEMPTS = 64

/** The end of the balanced object that opens at `start`, string-aware; -1 when it never closes. */
const closing = (text: string, start: number): number => {
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return index
  }
  return -1
}

/** Widens a span to the code fence around it, when the envelope is the fence's only content. */
const fenced = (text: string, start: number, end: number): { start: number; end: number } => {
  const open = /```[a-zA-Z]*[ \t]*\r?\n[ \t]*$/.exec(text.slice(0, start))
  const close = /^[ \t]*\r?\n?[ \t]*```/.exec(text.slice(end))
  return open && close ? { start: open.index, end: end + close[0].length } : { start, end }
}

export interface LeadEnvelopeSplit {
  /** The words around the envelope, trimmed: what the person may read. */
  readonly prose: string
  /** The decoded envelope, or undefined when the marker was there but no envelope could be read. */
  readonly envelope?: Record<string, unknown>
}

/** Whether a block that runs from `start` to `end` is the reply's own trailing block: it opens a line, nothing but
 * white space follows it, and it is not inside a fence that holds other text. An envelope in a `>` quote, a list item,
 * a worker's log or the middle of the prose is somebody's output being shown, not the Lead's own. */
const trailing = (text: string, start: number, end: number): boolean => {
  if (text.slice(end).trim() !== '') return false
  const before = text.slice(0, start)
  if (!/(?:^|\n)[ \t]*$/.test(before)) return false
  return (before.match(/```/g)?.length ?? 0) % 2 === 0
}

/** Finds the `lead-output` envelope that ends `text`, after its prose or as a final fence's only content. Null when
 * there is none: an envelope anywhere else stays text, never parsed. When the last marker sits in a trailing object
 * that never closes, a reply cut short, everything from that opening on is dropped, so a cut envelope is never shown
 * either. */
export const splitLeadOutput = (text: string): LeadEnvelopeSplit | null => {
  let marker: RegExpExecArray | null = null
  for (const found of text.matchAll(new RegExp(MARKER.source, 'g'))) marker = found as RegExpExecArray
  if (!marker) return null
  let attempts = 0, cut = -1
  for (let start = text.lastIndexOf('{', marker.index); start >= 0 && attempts < ATTEMPTS; start = text.lastIndexOf('{', start - 1), attempts++) {
    const end = closing(text, start)
    if (end < 0) { if (cut < 0) cut = start; continue }
    if (end < marker.index) continue
    let decoded: unknown
    try { decoded = JSON.parse(text.slice(start, end + 1)) } catch { continue }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || (decoded as Record<string, unknown>).type !== 'lead-output') continue
    const span = fenced(text, start, end + 1)
    if (!trailing(text, span.start, span.end)) return null
    return { prose: text.slice(0, span.start).trim(), envelope: decoded as Record<string, unknown> }
  }
  if (cut < 0) return null
  const fence = /```[a-zA-Z]*[ \t]*\r?\n[ \t]*$/.exec(text.slice(0, cut))
  const from = fence ? fence.index : cut
  return trailing(text, from, text.length) ? { prose: text.slice(0, from).trim() } : null
}

/** Removes every envelope a text still carries. `dropped` says whether there was any. */
export const stripLeadOutput = (text: string): { readonly text: string; readonly dropped: boolean } => {
  let current = text, dropped = false
  for (let split = splitLeadOutput(current); split; split = splitLeadOutput(current)) {
    dropped = true
    if (split.prose === current) break
    current = split.prose
  }
  return { text: current, dropped }
}
