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

/**
 * Which raw line is a header and which is content — the one rule `parseDiff`
 * and `countChanges` share, so the diff a reader sees and the `+N −M` beside
 * it cannot disagree. They did: `countChanges` skipped `+++`/`---` anywhere
 * while `parseDiff` skipped them only before the first hunk, so a removed
 * `--count;` was drawn as a removal and not counted.
 *
 * `+++` and `---` are headers before a file's first hunk and content after it,
 * so the test is positional — and positional **per file**. A multi-file diff,
 * a turn's whole diff, opens every file with a `diff ` line, and the position
 * never restarted there: every file after the first had its `diff --git`,
 * `---` and `+++` drawn as context, a removal and an addition, each with a
 * gutter number it had no right to. A raw line can only begin with `diff ` if
 * it is a header — content always carries a ` `, `+`, `-` or `\` prefix — so
 * restarting on it is exact rather than a guess.
 */
const classifier = (): ((raw: string) => LineKind) => {
  let sawHunk = false
  return (raw) => {
    if (HUNK.test(raw)) {
      sawHunk = true
      return 'hunk'
    }
    if (raw.startsWith('diff ')) {
      sawHunk = false
      return 'meta'
    }
    if (!sawHunk && HEADER.test(raw)) return 'meta'
    if (raw.startsWith('+')) return 'add'
    if (raw.startsWith('-')) return 'remove'
    // "\ No newline at end of file"
    if (raw.startsWith('\\')) return 'meta'
    return 'context'
  }
}

export const parseDiff = (diff: string): DiffLine[] => {
  const lines: DiffLine[] = []
  const classify = classifier()
  let oldNumber = 0
  let newNumber = 0

  /* The empty string after a final newline is an artefact of the split, not
     a line, and is dropped as what it is. It used to be dropped by what it
     read as — any last line with empty text — and a last line that is an
     added or removed blank is `+` or `-` with nothing after it: dropped from
     the drawing while the count beside it kept it. */
  const raws = diff.split('\n')
  if (raws[raws.length - 1] === '') raws.pop()
  for (const raw of raws) {
    const kind = classify(raw)
    if (kind === 'hunk') {
      const hunk = HUNK.exec(raw)
      oldNumber = Number(hunk?.[1])
      newNumber = Number(hunk?.[2])
      lines.push({ kind, text: raw, oldNumber: null, newNumber: null })
    } else if (kind === 'meta') {
      lines.push({ kind, text: raw, oldNumber: null, newNumber: null })
    } else if (kind === 'add') {
      lines.push({ kind, text: raw.slice(1), oldNumber: null, newNumber: newNumber++ })
    } else if (kind === 'remove') {
      lines.push({ kind, text: raw.slice(1), oldNumber: oldNumber++, newNumber: null })
    } else {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw
      lines.push({ kind, text, oldNumber: oldNumber++, newNumber: newNumber++ })
    }
  }

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

/**
 * Additions and removals, by the same rule `parseDiff` draws them with. A
 * counter of its own is what let the two disagree; this allocates nothing per
 * line, which matters because the review pane counts every file on render.
 */
export const countChanges = (diff: string): { added: number; removed: number } => {
  const classify = classifier()
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    const kind = classify(line)
    if (kind === 'add') added += 1
    else if (kind === 'remove') removed += 1
  }
  return { added, removed }
}

/**
 * The `+N −M` for one file change, counted from what its view draws.
 *
 * `DiffView` draws an added file's whole content as additions when it carries
 * no hunks, and a diff otherwise; this counts by that rule, so the badge and
 * the view beneath it cannot disagree. `Items` counted an added file's
 * removals with `countChanges` — reading whole-file content as though it were
 * a diff — so a markdown `- item` was a removal from a file that had just been
 * created, and once headers were read positionally a front-matter `---` was
 * one too. Review caught it. The addition count had an error of its own:
 * `split('\n').length` counts the artefact after a final newline, which the
 * view drops.
 */
export const countDrawn = (diff: string, wholeFile: boolean): { added: number; removed: number } =>
  wholeFile && !diff.includes('@@') ? { added: asAdditions(diff).length, removed: 0 } : countChanges(diff)

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

const GIT_HEADER = 'diff --git '

/** The escapes git writes inside a quoted path, and the byte each stands for. */
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/**
 * The git C-quoted path token whose opening quote is at `at`, unescaped — or
 * null when it never closes.
 *
 * **Bytes, then UTF-8.** With `core.quotePath` on, which is git's default, a
 * non-ASCII name is written as octal escapes of its UTF-8 *bytes*: `café.txt`
 * is `"caf\303\251.txt"`. Turning each escape into a character on its own
 * gives `cafÃ©.txt`, which is a name no file has. With it off, the same name
 * can arrive raw *inside* the quotes beside an escaped tab, so raw text is
 * encoded back to bytes and the whole token decoded once. Both settings were
 * measured against git before this was written.
 */
const readQuoted = (text: string, at: number): { value: string; end: number } | null => {
  const encoder = new TextEncoder()
  const bytes: number[] = []
  for (let i = at + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 }
    if (ch !== '\\') {
      // A whole code point, so a character outside the BMP is not split into
      // two halves that each encode as a replacement character.
      const point = String.fromCodePoint(text.codePointAt(i) ?? 0xfffd)
      bytes.push(...encoder.encode(point))
      i += point.length - 1
      continue
    }
    const next = text[i + 1] ?? ''
    const known = C_ESCAPES[next]
    if (known !== undefined) {
      bytes.push(known)
      i += 1
    } else if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1))?.[0] ?? next
      bytes.push(Number.parseInt(octal, 8) & 0xff)
      i += octal.length
    } else {
      /* An escape git does not write, kept as written — the backslash too.
         This used to say the same while keeping only the character after it,
         which is the comment describing code it did not match. */
      bytes.push(92, ...encoder.encode(next))
      i += 1
    }
  }
  return null
}

/**
 * The path a `diff --git` line names: the new side, or the old one when the
 * new side cannot be read.
 *
 * Git quotes **each side on its own** — measured: a rename from `plain.txt` to
 * a name with a tab in it is `diff --git a/plain.txt "b/tab\tname.txt"` — so
 * each side is read as a quoted token or a bare path independently. The old
 * pattern required a literal `a/` straight after `diff --git `, and every
 * quoted header failed it.
 *
 * Two bare sides are ambiguous when a name contains ` b/`. Git does not quote
 * for a space, so `diff --git a/x b/y.txt b/x b/y.txt` is one file, `x b/y.txt`
 * — and a lazy match splits it at the first ` b/`. When both sides are the
 * same name, which is every change but a rename, the line is `a/X b/X`, so
 * the halves are found by length. A rename between such names is ambiguous to
 * git as well, which is why it writes the name again beneath — and
 * `splitByFile` reads it there (`namedBelow`). The first ` b/` is only this
 * line's last guess.
 */
const headerPath = (line: string): string => {
  /* A diff that arrives with CRLF endings keeps the `\r` after `split('\n')`,
     and on this line it breaks all three readings: a quoted b-side no longer
     ends with `"`, the equal-halves arithmetic goes fractional, and a bare
     path is returned with a carriage return on the end. Review caught it. */
  const rest = line.slice(GIT_HEADER.length).replace(/\r$/, '')
  let a: string | null = null
  let b: string | null = null
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0)
    if (first) {
      a = first.value
      const tail = rest.slice(first.end + 1)
      b = tail.startsWith('"') ? (readQuoted(tail, 0)?.value ?? null) : tail
    }
  } else {
    const quoted = rest.indexOf(' "b/')
    if (quoted !== -1 && rest.endsWith('"')) {
      a = rest.slice(0, quoted)
      b = readQuoted(rest, quoted + 1)?.value ?? null
    } else {
      // `a/` + X + ` b/` + X, when the two names are one.
      const n = (rest.length - 5) / 2
      if (
        Number.isInteger(n) &&
        n > 0 &&
        rest.slice(2 + n, 5 + n) === ' b/' &&
        rest.slice(2, 2 + n) === rest.slice(5 + n)
      ) {
        a = `a/${rest.slice(2, 2 + n)}`
        b = `b/${rest.slice(5 + n)}`
      } else {
        const split = rest.indexOf(' b/')
        if (split !== -1) {
          a = rest.slice(0, split)
          b = rest.slice(split + 1)
        }
      }
    }
  }
  const strip = (side: string | null, prefix: string): string | null =>
    side !== null && side.startsWith(prefix) ? side.slice(prefix.length) : null
  return strip(b, 'b/') ?? strip(a, 'a/') ?? ''
}

/**
 * The new path a line of a file's extended header names outright — `rename
 * to`, `copy to`, or `+++ b/` — or null when the line names none.
 *
 * The `diff --git` line cannot always say: a rename between two names that
 * each contain ` b/` is ambiguous to git itself, so git writes the answer
 * underneath — `rename to Plan b/y.md` for every rename, and
 * `+++ b/Plan b/y.md` wherever there is content. Measured against git, with
 * two habits the reading has to know: a `+++` name containing a space is
 * followed by a tab, so that patch(1) can find where it ends; and a
 * `rename to` name is quoted by the header's rule, without the `b/`.
 */
const namedBelow = (line: string): string | null => {
  const text = line.replace(/\r$/, '')
  const token = (value: string): string | null =>
    value.startsWith('"') ? (readQuoted(value, 0)?.value ?? null) : value.replace(/\t$/, '')
  for (const lead of ['rename to ', 'copy to ']) {
    if (text.startsWith(lead)) return token(text.slice(lead.length))
  }
  if (!text.startsWith('+++ ')) return null
  const named = token(text.slice(4))
  // `/dev/null` for a deletion, where the header's name is the one to keep.
  return named !== null && named.startsWith('b/') ? named.slice(2) : null
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
  let current: { path: string; lines: string[]; introducing: boolean } | null = null
  for (const line of diff.split('\n')) {
    /* Every `diff --git` line is a boundary, whether or not its path can be
       read. One the old pattern could not match was taken as content, so a
       quoted file's whole diff was filed under the previous file's path. */
    if (line.startsWith(GIT_HEADER)) {
      if (current) files.push({ path: current.path, diff: current.lines.join('\n') })
      current = { path: headerPath(line), lines: [line], introducing: true }
      continue
    }
    if (!current) current = { path: '', lines: [], introducing: false }
    /* Until its first hunk a file is still being introduced, and what git
       writes there names it better than its `diff --git` line can — see
       `namedBelow`. From the first hunk on, a `+++` line is content. */
    if (current.introducing) {
      if (line.startsWith('@@')) current.introducing = false
      else current.path = namedBelow(line) ?? current.path
    }
    current.lines.push(line)
  }
  if (current && current.lines.some((line) => line.trim().length > 0)) {
    files.push({ path: current.path, diff: current.lines.join('\n') })
  }
  return files
}
