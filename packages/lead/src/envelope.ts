/** Where the structured `lead-output` envelope sits in a reply that is not the envelope alone.
 *
 * The instructions ask for the envelope as the whole text, but a model also writes it after its prose, or inside a
 * code fence. Protocol JSON is never words for the person: whichever way it arrives it is read as the envelope, and
 * what is left is the prose. Nothing here grants authority; the caller validates the decoded value as before. */

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

/** Finds one `lead-output` envelope inside `text`. Null when the text names none. When the marker is there but no
 * balanced object around it parses, everything from the opening before the marker to the end is dropped, so a cut
 * or broken envelope is never shown either. */
export const splitLeadOutput = (text: string): LeadEnvelopeSplit | null => {
  const marker = MARKER.exec(text)
  if (!marker) return null
  let attempts = 0
  for (let start = text.lastIndexOf('{', marker.index); start >= 0 && attempts < ATTEMPTS; start = text.lastIndexOf('{', start - 1), attempts++) {
    const end = closing(text, start)
    if (end < marker.index) continue
    let decoded: unknown
    try { decoded = JSON.parse(text.slice(start, end + 1)) } catch { continue }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || (decoded as Record<string, unknown>).type !== 'lead-output') continue
    const span = fenced(text, start, end + 1)
    return { prose: `${text.slice(0, span.start).trimEnd()}\n\n${text.slice(span.end).trimStart()}`.trim(), envelope: decoded as Record<string, unknown> }
  }
  const opening = text.lastIndexOf('{', marker.index)
  const cut = opening < 0 ? marker.index : opening
  const fence = /```[a-zA-Z]*[ \t]*\r?\n[ \t]*$/.exec(text.slice(0, cut))
  return { prose: text.slice(0, fence ? fence.index : cut).trim() }
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
