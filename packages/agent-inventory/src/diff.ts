/**
 * A unified diff, generated.
 *
 * The renderer already parses standard unified diffs (`lib/diff` in the UI),
 * so the write path's previews are produced in exactly that format — one
 * generator here rather than a dependency, because the inputs are skill
 * definitions and configuration entries, not repositories.
 *
 * Plain LCS over lines. The quadratic table is fine at these sizes; inputs
 * big enough to make it not fine fall back to a whole-file replacement,
 * which for a preview of "this file becomes that file" is still the truth.
 */

interface Edit {
  readonly kind: 'context' | 'add' | 'remove'
  readonly text: string
}

const MAX_CELLS = 4_000_000

const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  // A trailing newline is file convention, not an extra empty line.
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const editScript = (before: readonly string[], after: readonly string[]): Edit[] => {
  if (before.length * after.length > MAX_CELLS) {
    return [
      ...before.map((text) => ({ kind: 'remove' as const, text })),
      ...after.map((text) => ({ kind: 'add' as const, text })),
    ]
  }
  // LCS lengths, then walk back. One flat array keeps this readable enough.
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
    }
  }
  const out: Edit[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      out.push({ kind: 'context', text: before[i] ?? '' })
      i += 1
      j += 1
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ kind: 'remove', text: before[i] ?? '' })
      i += 1
    } else {
      out.push({ kind: 'add', text: after[j] ?? '' })
      j += 1
    }
  }
  for (; i < before.length; i += 1) out.push({ kind: 'remove', text: before[i] ?? '' })
  for (; j < after.length; j += 1) out.push({ kind: 'add', text: after[j] ?? '' })
  return out
}

/**
 * `before` → `after` as a unified diff with three lines of context, headed by
 * the labels — usually the path being written, spoken twice the way `diff -u`
 * would. Identical inputs produce an empty string, which callers read as
 * "nothing to show".
 */
export const unifiedDiff = (
  before: string,
  after: string,
  options: { readonly fromLabel?: string; readonly toLabel?: string; readonly context?: number } = {},
): string => {
  if (before === after) return ''
  const context = options.context ?? 3
  const edits = editScript(splitLines(before), splitLines(after))

  // Group edits into hunks: runs of changes padded with `context` lines.
  interface Hunk {
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
    lines: string[]
  }
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let oldLine = 1
  let newLine = 1
  let trailing = 0

  const changedAhead = (from: number): boolean => {
    for (let look = from; look < edits.length && look < from + context + 1; look += 1) {
      if (edits[look]?.kind !== 'context') return true
    }
    return false
  }

  edits.forEach((edit, index) => {
    if (edit.kind === 'context') {
      if (current) {
        if (trailing < context && changedAhead(index)) {
          current.lines.push(` ${edit.text}`)
          current.oldCount += 1
          current.newCount += 1
          trailing = 0
        } else if (trailing < context) {
          current.lines.push(` ${edit.text}`)
          current.oldCount += 1
          current.newCount += 1
          trailing += 1
        } else {
          current = null
        }
      }
      oldLine += 1
      newLine += 1
      return
    }
    if (!current) {
      current = {
        oldStart: Math.max(1, oldLine - context),
        oldCount: 0,
        newStart: Math.max(1, newLine - context),
        newCount: 0,
        lines: [],
      }
      // Leading context, pulled from what we just walked past.
      for (let back = Math.max(0, index - context); back < index; back += 1) {
        const lead = edits[back]
        if (lead?.kind !== 'context') continue
        current.lines.push(` ${lead.text}`)
        current.oldCount += 1
        current.newCount += 1
      }
      // The starts must match how many context lines actually got pulled.
      current.oldStart = oldLine - current.oldCount
      current.newStart = newLine - current.newCount
      hunks.push(current)
    }
    trailing = 0
    if (edit.kind === 'remove') {
      current.lines.push(`-${edit.text}`)
      current.oldCount += 1
      oldLine += 1
    } else {
      current.lines.push(`+${edit.text}`)
      current.newCount += 1
      newLine += 1
    }
  })

  const head = [
    `--- ${options.fromLabel ?? 'before'}`,
    `+++ ${options.toLabel ?? 'after'}`,
  ]
  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldCount === 0 ? Math.max(0, hunk.oldStart - 1) : hunk.oldStart},${hunk.oldCount} +${hunk.newCount === 0 ? Math.max(0, hunk.newStart - 1) : hunk.newStart},${hunk.newCount} @@`,
    ...hunk.lines,
  ])
  return [...head, ...body].join('\n')
}
