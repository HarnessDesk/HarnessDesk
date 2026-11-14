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

/** Where a run of JSON-shaped text that opens at `start` stops: just past the brace that balances it, at the first
 * character JSON could not hold there (a word, a backtick, "nullable"), or at a line break inside a string, which no
 * JSON string holds. With `multiline` it goes on past a line break only when the next line carries on as JSON, its
 * first character a quote, brace or bracket; a prose line after it ends it at the break. Without, it stops at the end
 * of the line. String-aware. */
const jsonEnd = (text: string, start: number, multiline: boolean): number => {
  let depth = 0, quoted = false, escaped = false, index = start
  for (; index < text.length; index++) {
    const char = text[index]!
    if (char === '\n' || char === '\r') {
      if (quoted || !multiline || !/^\s*["{[\]}]/.test(text.slice(index))) return index
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') depth++
    else if (char === '}' || char === ']') { if (--depth <= 0) return index + 1 }
    else if (/^(?:true|false|null)(?![\p{L}\p{N}_])/u.test(text.slice(index, index + 6))) index += text[index] === 'f' ? 4 : 3
    else if (!/[ \t:,0-9.eE+-]/.test(char)) return index
  }
  return index
}

const QUOTE_LINE = /^[ \t]*>/
/** The end of the line that holds `at`, before its line break. */
const lineEnd = (text: string, at: number) => { const found = text.indexOf('\n', at); return found < 0 ? text.length : found }

/** The span a clipped or malformed envelope opening at `cut` takes away. A reply cut short at its end loses everything
 * from the opening (and a fence opened just before it) on. Anywhere else only the envelope's own place goes: the rest
 * of its quote block, the line or lines it fills from a line's start, or, inline, the JSON-shaped fragment itself. */
const clipped = (text: string, cut: number): { start: number; end: number } => {
  const fence = /```[a-zA-Z]*[ \t]*\r?\n[ \t]*$/.exec(text.slice(0, cut))
  const opened = fence ? fence.index : cut
  if (jsonEnd(text, cut, true) >= text.trimEnd().length && trailing(text, opened, text.length)) return { start: opened, end: text.length }
  const lineStart = text.lastIndexOf('\n', cut - 1) + 1
  if (QUOTE_LINE.test(text.slice(lineStart, cut))) {
    let end = lineEnd(text, cut)
    while (end < text.length && QUOTE_LINE.test(text.slice(end + 1, lineEnd(text, end + 1)))) end = lineEnd(text, end + 1)
    return { start: cut, end }
  }
  if (/^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?$/.test(text.slice(lineStart, cut))) {
    // The rest of the envelope's own line goes with it; on a later line, only up to where the JSON stopped.
    let end = jsonEnd(text, cut, true)
    if (text.lastIndexOf('\n', end - 1) < cut) end = lineEnd(text, end)
    else while (end > cut && /[ \t]/.test(text[end - 1]!)) end--
    return fenced(text, cut, end)
  }
  let end = jsonEnd(text, cut, false)
  while (end > cut && /[ \t]/.test(text[end - 1]!)) end--
  return { start: cut, end }
}

/** One envelope's span around a marker: the balanced object that decodes as `lead-output` (and the fence that holds
 * only it), or, for one clipped or malformed, the span `clipped` gives from its opening. An opening counts only when
 * the JSON-shaped text from it reaches past the marker, so an unrelated `{` in the prose ("a template like {name")
 * never cuts anything. Null when the marker is in neither, as when prose spells the marker out. */
const around = (text: string, at: number): { start: number; end: number; envelope?: Record<string, unknown> } | null => {
  const markerEnd = at + (MARKER.exec(text.slice(at))?.[0].length ?? 0)
  let attempts = 0, cut = -1
  for (let start = text.lastIndexOf('{', at); start >= 0 && attempts < ATTEMPTS; start = text.lastIndexOf('{', start - 1), attempts++) {
    const end = closing(text, start)
    if (end >= 0 && end < at) continue
    if (end >= 0) {
      let decoded: unknown
      try { decoded = JSON.parse(text.slice(start, end + 1)) } catch { decoded = null }
      if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) && (decoded as Record<string, unknown>).type === 'lead-output') {
        return { ...fenced(text, start, end + 1), envelope: decoded as Record<string, unknown> }
      }
    }
    if (cut < 0 && jsonEnd(text, start, true) >= markerEnd) cut = start
  }
  return cut < 0 ? null : clipped(text, cut)
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

/** Tidies the place one removal joined, and only there: a quote or list marker the removal left bare goes with its
 * line, an inline code span it emptied goes, and the blank lines that meet there close to one. */
const tidy = (text: string, at: number): string => {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1, end = lineEnd(text, at)
  if (/^[ \t]*(?:>|[-*+]|\d+[.)])?[ \t]*$/.test(text.slice(lineStart, end))) {
    text = text.slice(0, lineStart) + text.slice(Math.min(end + 1, text.length)); at = lineStart
  } else {
    if (text[at - 1] === '`' && text[at] === '`' && text[at - 2] !== '`' && text[at + 1] !== '`') { text = text.slice(0, at - 1) + text.slice(at + 1); at-- }
    if (text[at - 1] === ' ' && text[at] === ' ') text = text.slice(0, at) + text.slice(at + 1)
  }
  let back = at, ahead = at
  while (back > 0 && /[ \t\n]/.test(text[back - 1]!)) back--
  while (ahead < text.length && /[ \t\n]/.test(text[ahead]!)) ahead++
  const run = text.slice(back, ahead)
  if ((run.match(/\n/g)?.length ?? 0) < 3) return text
  return text.slice(0, back) + '\n\n' + run.slice(run.lastIndexOf('\n') + 1) + text.slice(ahead)
}

/** Removes every envelope a text still carries, wherever it sits, so protocol JSON is never drawn: the trailing one the
 * parser could not validate, and one quoted from a worker or left mid-text, which is never parsed. Only the place each
 * removal joined is tidied; the rest of the reply's lines are left as they are. `dropped` says whether there was any;
 * the caller warns by code only. */
export const stripLeadOutput = (text: string): { readonly text: string; readonly dropped: boolean } => {
  let current = text, dropped = false
  for (let guard = 0; guard < 16; guard++) {
    let span: ReturnType<typeof around> = null
    for (const found of current.matchAll(new RegExp(MARKER.source, 'g'))) if ((span = around(current, found.index))) break
    if (!span) break
    dropped = true
    current = tidy(current.slice(0, span.start) + current.slice(span.end), span.start)
  }
  return dropped ? { text: current.trim(), dropped } : { text, dropped }
}

/** The tags of a tool call, with or without a namespace prefix: what a model writes when it means to call a tool and
 * prints the call as words instead (#2148). */
const CALL_TAG = /<\/?(?:[a-z]+:)?(?:function_calls|function_results|invoke|parameter)\b[^>]*>/gi
/** A whole call written out as words: an opened call through its own close. */
const CALL_BLOCK = /<((?:[a-z]+:)?(?:function_calls|function_results|invoke))\b[^>]*>[\s\S]*?<\/\1>/gi
/** Code the reply shows on purpose: a fence (closed or cut short) or an inline span. Markup there is the subject. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g
const GONE = '\u0001'

/** Removes tool-call markup a model wrote into its words, so a misfired call never reaches either surface: a whole call
 * goes with what it held, a stray opening or closing tag goes alone, and a line left with nothing on it goes too. Code
 * the reply quotes on purpose, a fence or an inline span, stays as written. `dropped` says whether any was there. */
export const stripLeadToolMarkup = (text: string): { readonly text: string; readonly dropped: boolean } => {
  const kept: string[] = []
  // Code is put aside first, under placeholders the model cannot have written, and put back last.
  const shielded = text.replace(CODE, code => `\u0002${kept.push(code) - 1}\u0003`)
  const marked = shielded.replace(CALL_BLOCK, GONE).replace(CALL_TAG, GONE)
  if (!marked.includes(GONE)) return { text, dropped: false }
  const lines = marked.split('\n').flatMap(line => !line.includes(GONE) ? [line] : line.split(GONE).join('').trim() === '' ? [] : [line.split(GONE).join('')])
  const restored = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\u0002(\d+)\u0003/g, (_whole, index: string) => kept[Number(index)]!)
  return { text: restored.trim(), dropped: true }
}
