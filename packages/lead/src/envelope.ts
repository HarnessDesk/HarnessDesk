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

/** The most a closing line after the envelope may hold ("Let me know!") and the envelope still be the reply's own. */
export const LEAD_ENVELOPE_CLOSING_MAX = 120

/** What follows a block that ends the reply: nothing, or one short closing line with no fence. Null when more follows. */
const closingAfter = (text: string, end: number): string | null => {
  const rest = text.slice(end).trim()
  return rest === '' || rest.length <= LEAD_ENVELOPE_CLOSING_MAX && !/[\r\n]/.test(rest) && !rest.includes('```') ? rest : null
}

/** Whether a block that runs from `start` to `end` is the reply's own trailing block: it opens a line, at most one short
 * closing line follows it, and it is not inside a fence that holds other text. An envelope in a `>` quote, a list
 * item, a worker's log or the middle of the prose is somebody's output being shown, not the Lead's own. */
const trailing = (text: string, start: number, end: number): boolean => {
  if (closingAfter(text, end) === null) return false
  const before = text.slice(0, start)
  if (!/(?:^|\n)[ \t]*$/.test(before)) return false
  return (before.match(/```/g)?.length ?? 0) % 2 === 0
}

/** One envelope's span around a marker: the balanced object that decodes as `lead-output` (and the fence that holds
 * only it), or, for a reply cut short, the opening that never closes up to the end. Null when the marker is in neither,
 * as when prose spells the marker out. */
const around = (text: string, at: number): { start: number; end: number; envelope?: Record<string, unknown> } | null => {
  let attempts = 0, cut = -1
  for (let start = text.lastIndexOf('{', at); start >= 0 && attempts < ATTEMPTS; start = text.lastIndexOf('{', start - 1), attempts++) {
    const end = closing(text, start)
    if (end < 0) { if (cut < 0) cut = start; continue }
    if (end < at) continue
    let decoded: unknown
    try { decoded = JSON.parse(text.slice(start, end + 1)) } catch { continue }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded) || (decoded as Record<string, unknown>).type !== 'lead-output') continue
    return { ...fenced(text, start, end + 1), envelope: decoded as Record<string, unknown> }
  }
  if (cut < 0) return null
  const fence = /```[a-zA-Z]*[ \t]*\r?\n[ \t]*$/.exec(text.slice(0, cut))
  return { start: fence ? fence.index : cut, end: text.length }
}

/** Finds the `lead-output` envelope that ends `text`, after its prose or as a final fence's only content, with at most
 * one short closing line after it. Null when there is none: an envelope anywhere else is never parsed (and
 * `stripLeadOutput` keeps it from being shown). When the last marker sits in a trailing object that never closes, a
 * reply cut short, everything from that opening on is dropped, so a cut envelope is never shown either. */
export const splitLeadOutput = (text: string): LeadEnvelopeSplit | null => {
  let marker: RegExpExecArray | null = null
  for (const found of text.matchAll(new RegExp(MARKER.source, 'g'))) marker = found as RegExpExecArray
  if (!marker) return null
  const span = around(text, marker.index)
  if (!span || !trailing(text, span.start, span.end)) return null
  const prose = `${text.slice(0, span.start).trim()}\n\n${closingAfter(text, span.end) ?? ''}`.trim()
  return span.envelope ? { prose, envelope: span.envelope } : { prose }
}

/** Removes every envelope a text still carries, wherever it sits, so protocol JSON is never drawn: the trailing one the
 * parser could not validate, and one quoted from a worker or left mid-text, which is never parsed. A quote or list
 * marker the removal leaves bare goes with it. `dropped` says whether there was any; the caller warns by code only. */
export const stripLeadOutput = (text: string): { readonly text: string; readonly dropped: boolean } => {
  let current = text, dropped = false
  for (let guard = 0; guard < 16; guard++) {
    let span: ReturnType<typeof around> = null
    for (const found of current.matchAll(new RegExp(MARKER.source, 'g'))) if ((span = around(current, found.index))) break
    if (!span) break
    dropped = true
    current = current.slice(0, span.start) + current.slice(span.end)
  }
  if (!dropped) return { text, dropped }
  return { text: current.split('\n').filter(line => !/^[ \t]*(?:>|[-*+]|\d+[.)])[ \t]*$/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped }
}
