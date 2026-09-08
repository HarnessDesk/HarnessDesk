/**
 * Unified diff parsing.
 *
 * The runtime already hands us a unified diff, so the only work is classifying
 * lines and tracking gutter numbers. A diff library would be a dependency that
 * re-derives what we were given.
 */

export type LineKind = 'context' | 'add' | 'remove' | 'hunk' | 'meta'

export interface DiffLine {
  readonly kind: LineKind
  readonly text: string
  readonly oldNumber: number | null
  readonly newNumber: number | null
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const HEADER = /^(?:diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/

export const parseDiff = (diff: string): DiffLine[] => {
  const lines: DiffLine[] = []
  let oldNumber = 0
  let newNumber = 0
  let sawHunk = false

  for (const raw of diff.split('\n')) {
    const hunk = HUNK.exec(raw)
    if (hunk) {
      sawHunk = true
      oldNumber = Number(hunk[1])
      newNumber = Number(hunk[2])
      lines.push({ kind: 'hunk', text: raw, oldNumber: null, newNumber: null })
      continue
    }
    // `+++`/`---` are headers before the first hunk and content after it, so the
    // check has to be positional rather than purely textual.
    if (!sawHunk && HEADER.test(raw)) {
      lines.push({ kind: 'meta', text: raw, oldNumber: null, newNumber: null })
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), oldNumber: null, newNumber: newNumber++ })
      continue
    }
    if (raw.startsWith('-')) {
      lines.push({ kind: 'remove', text: raw.slice(1), oldNumber: oldNumber++, newNumber: null })
      continue
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      lines.push({ kind: 'meta', text: raw, oldNumber: null, newNumber: null })
      continue
    }
    const text = raw.startsWith(' ') ? raw.slice(1) : raw
    lines.push({ kind: 'context', text, oldNumber: oldNumber++, newNumber: newNumber++ })
  }

  // The trailing blank from the final newline is an artefact, not a line.
  if (lines.length > 0 && lines[lines.length - 1]?.text === '') lines.pop()
  return lines
}

/** Whole-file content, as runtimes send for added files, shown as all additions. */
export const asAdditions = (content: string): DiffLine[] => {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((text, index) => ({
    kind: 'add' as const,
    text,
    oldNumber: null,
    newNumber: index + 1,
  }))
}

export const countChanges = (diff: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return { added, removed }
}

export interface DiffHunk {
  /** The `@@ …` line, verbatim. */
  readonly header: string
  /** Header plus body — a unified-diff fragment that reads on its own. */
  readonly text: string
}

/**
 * One file's diff as its hunks, for per-hunk review actions. The pre-hunk
 * headers (`diff --git`, `index`, `---`, `+++`) are dropped: a quoted hunk
 * names its file in the sentence around it, not in a header.
 */
export const splitHunks = (diff: string): DiffHunk[] => {
  const hunks: { header: string; lines: string[] }[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      hunks.push({ header: line, lines: [line] })
      continue
    }
    hunks[hunks.length - 1]?.lines.push(line)
  }
  return hunks.map((hunk) => ({ header: hunk.header, text: hunk.lines.join('\n').trimEnd() }))
}

export interface FileDiff {
  /** The new path, or the old one for a deletion. */
  readonly path: string
  readonly diff: string
}

/**
 * Splits a multi-file unified diff into one diff per file, keyed by the path
 * in its `diff --git` header. A diff without headers — a single file's, or
 * a runtime's aggregated turn diff that omitted them — is one entry with no
 * path.
 */
export const splitByFile = (diff: string): FileDiff[] => {
  const files: FileDiff[] = []
  let current: { path: string; lines: string[] } | null = null
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (header) {
      if (current) files.push({ path: current.path, diff: current.lines.join('\n') })
      current = { path: header[2] ?? header[1] ?? '', lines: [line] }
      continue
    }
    if (!current) current = { path: '', lines: [] }
    current.lines.push(line)
  }
  if (current && current.lines.some((line) => line.trim().length > 0)) {
    files.push({ path: current.path, diff: current.lines.join('\n') })
  }
  return files
}
