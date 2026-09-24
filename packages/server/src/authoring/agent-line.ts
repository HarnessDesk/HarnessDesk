/**
 * One front-matter line of an `AGENT.md`, replaced in place.
 *
 * Everything else in the file is its author's — a byte-order mark, CRLF
 * line ends, the spacing around the colon, a trailing comment, the brief —
 * and stays exactly as it was. Only a field a row edits is reachable here,
 * only one line is ever written, and a field that spans lines (a block
 * scalar, a multiline list) is refused with a route to the file editor rather
 * than flattened. This is a source-level splice; `model.ts` re-reads the
 * result with the Agent parser, which stays the judge of what it means.
 */

const ROW_FIELDS = /^(name|description|ceiling|answers|produces|prefer)$/

export function replaceAgentLine(source: string, key: string, encoded: string): string {
  if (!ROW_FIELDS.test(key)) {
    throw new Error('This field is edited in the file.')
  }
  if (/[\r\n]/.test(encoded) || encoded.length === 0) {
    throw new Error('Use one YAML value on this line.')
  }
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const text = source.slice(bom.length)
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const body = (line: string): string => line.replace(/\r?\n$/, '')
  if (!/^---[ \t]*$/.test(body(lines[0] ?? ''))) {
    throw new Error('Open the file to add its front matter first.')
  }
  const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(body(line)))
  if (close < 0) throw new Error('Close the front matter before editing a field.')
  const hits: number[] = []
  for (let index = 1; index < close; index += 1) {
    if (new RegExp(`^${key}[ \\t]*:`).test(body(lines[index]!))) hits.push(index)
  }
  if (hits.length > 1) throw new Error('Keep one declaration of this field in the file.')
  const index = hits[0]
  if (index === undefined) {
    const newline = lines[0]!.endsWith('\r\n') ? '\r\n' : '\n'
    lines.splice(close, 0, `${key}: ${encoded}${newline}`)
    return bom + lines.join('')
  }
  const original = lines[index]!
  const line = body(original)
  const colon = line.indexOf(':')
  let quote: string | null = null
  let comment = line.length
  for (let at = colon + 1; at < line.length; at += 1) {
    const char = line[at]!
    if (quote !== null) {
      if (char === '\\' && quote === '"') at += 1
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#' && /[ \t]/.test(line[at - 1]!)) {
      comment = at
      break
    }
  }
  const old = line.slice(colon + 1, comment).trim()
  const child = lines.slice(index + 1, close).find((next) => {
    const value = body(next)
    return value.trim() !== '' && !value.trimStart().startsWith('#')
  })
  // A value continued below its key — indented, or a `- item` YAML lets sit at the key's own column.
  if (/^[|>]/.test(old) || (child !== undefined && (/^[ \t]/.test(child) || (old === '' && /^-([ \t]|\r?\n?$)/.test(child))))) {
    throw new Error('This field spans lines. Open the file to preserve its formatting.')
  }
  const leading = line.slice(colon + 1).match(/^[ \t]*/)?.[0] || ' '
  const trailing = line.slice(colon + 1, comment).match(/[ \t]*$/)?.[0] ?? ''
  const suffix = comment < line.length ? (trailing || ' ') + line.slice(comment) : trailing
  lines[index] = line.slice(0, colon + 1) + leading + encoded + suffix + original.slice(line.length)
  return bom + lines.join('')
}
