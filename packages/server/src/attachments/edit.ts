/**
 * One `AGENT.md`'s `skills:` and `mcp:` front-matter lines, edited together
 * while every other byte survives untouched — the brief, comments, the
 * `ceiling`/`permission` line and its own provenance, `answers`, `prefer`.
 *
 * Built on exactly the pattern `agent-def.ts`'s `ceilingEdit` already
 * proved for one scalar line: find the front-matter fence, locate the one
 * field, replace only its own line(s), and hand back both the whole
 * rewritten file and a unified diff a person can actually read before
 * approving it. Two fields instead of one, because decision 7 treats
 * `skills` and `mcp` as a matched pair — an empty or omitted list means
 * runtime defaults for both, not "none".
 *
 * This is a pure function: no disk, no clock, no network. The caller reads
 * the current file, calls this, and — if it does not want to keep the
 * result — writes it back through `AuthoringPlane.rewriteAgent`, the one
 * writer of Agent files, under the caller's own digest check, which is what makes "stale preview never overwrites a newer edit" true
 * without this file needing to know anything about time.
 */

export interface AttachmentFields {
  readonly skills: readonly string[]
  readonly mcp: readonly string[]
}

export interface AttachmentFieldEdit {
  readonly next: string
  readonly diff: string
}

const FENCE = /^---[ \t]*\r?$/
const fieldKey = (name: 'skills' | 'mcp'): RegExp => new RegExp(`^${name}[ \\t]*:`)
const shown = (line: string): string => line.replace(/\r$/, '')

const render = (name: 'skills' | 'mcp', values: readonly string[]): string =>
  values.length === 0 ? `${name}: []` : `${name}: [${values.join(', ')}]`

/** The key line plus any block-list `- item` lines directly under it — the one shape this editor reads back out again. A flow list that itself spans several physical lines is not one of these; decision-scoped: such a file is refused rather than mis-patched. */
const fieldRange = (front: readonly string[], name: 'skills' | 'mcp'): { readonly at: number; readonly end: number } | null => {
  const at = front.findIndex((line) => fieldKey(name).test(line))
  if (at === -1) return null
  let end = at + 1
  while (end < front.length && /^[ \t]+-/.test(front[end] ?? '')) end += 1
  return { at, end }
}

const duplicateKey = (front: readonly string[], name: 'skills' | 'mcp'): boolean =>
  front.filter((line) => fieldKey(name).test(line)).length > 1

/** Build one combined `skills:`/`mcp:` edit, preserving every other byte. */
export const attachmentFieldEdit = (source: string, fields: AttachmentFields): AttachmentFieldEdit | { readonly refused: string } => {
  const bom = source.startsWith('﻿') ? '﻿' : ''
  const text = source.slice(bom.length)
  const eol = text.match(/\r?\n/)?.[0] ?? '\n'
  const lines = text.split(eol)
  const joined = (next: readonly string[]): string => `${bom}${next.join(eol)}`

  if (!FENCE.test(lines[0] ?? '')) return { refused: 'its front matter opens with "---" and is never closed' }
  const close = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  if (close === -1) return { refused: 'its front matter opens with "---" and is never closed' }
  const front = lines.slice(1, close)

  if (duplicateKey(front, 'skills')) return { refused: 'it lists skills: more than once — keep one line by hand' }
  if (duplicateKey(front, 'mcp')) return { refused: 'it lists mcp: more than once — keep one line by hand' }

  let nextFront = [...front]
  const singleLineDiffs: { readonly at: number; readonly removed: readonly string[]; readonly added: readonly string[] }[] = []
  for (const name of ['skills', 'mcp'] as const) {
    const values = fields[name]
    const range = fieldRange(nextFront, name)
    const rendered = render(name, values)
    if (range) {
      singleLineDiffs.push({ at: range.at, removed: nextFront.slice(range.at, range.end).map(shown), added: [rendered] })
      nextFront = [...nextFront.slice(0, range.at), rendered, ...nextFront.slice(range.end)]
    } else {
      singleLineDiffs.push({ at: nextFront.length, removed: [], added: [rendered] })
      nextFront = [...nextFront, rendered]
    }
  }

  const next = joined([lines[0] ?? '---', ...nextFront, ...lines.slice(close)])
  const diff = singleLineDiffs
    .filter((one) => one.removed.join('\n') !== one.added.join('\n'))
    .map((one) => {
      const removedCount = one.removed.length
      const addedCount = one.added.length
      const header = `@@ -${one.at + 1},${removedCount || 1} +${one.at + 1},${addedCount || 1} @@`
      const body = [...one.removed.map((line) => `-${line}`), ...one.added.map((line) => `+${line}`)].join('\n')
      return `${header}\n${body}\n`
    })
    .join('')
  return { next, diff: diff || '(no change)\n' }
}
