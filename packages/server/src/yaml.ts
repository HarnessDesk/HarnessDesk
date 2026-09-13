/**
 * The slice of YAML a flow file is written in — and nothing else.
 *
 * A flow lives in the repository it serves so it can be versioned with the
 * code it governs and proposed in a pull request, which means a person writes
 * one by hand and another person reads it in a diff. That is a small document:
 * maps, lists, scalars, and the block scalars a standing order needs. So this
 * reads exactly that and **refuses everything else by name** — anchors,
 * aliases, tags, multiple documents, tabs — rather than guessing.
 *
 * Refusing is the point. A hand-rolled parser that quietly mis-reads a
 * document is worse than no parser, and a flow that is mis-read is a room of
 * agents doing the wrong thing unattended. Every refusal below carries the
 * line number and says what was found, so the failure is a sentence rather
 * than a surprise.
 *
 * Why not a library. `pnpm verify` gates third-party notices and this project
 * has read dependencies' claims before; the accepted subset here is the whole
 * of what a flow needs, and everything outside it is refused loudly rather
 * than silently accepted and half-supported. The seam is one function, so if
 * the canvas's round-tripping (see docs/flows.md) turns out to want a real
 * document model, adopting one is a contained change behind `parseYaml`.
 *
 * What it deliberately does *not* do: type coercion beyond the obvious.
 * `true`, `false`, `null`, `~` and numbers become their JavaScript values;
 * everything else is a string. A flow's own reader is what decides whether
 * `count: 3` means anything, and a parser that guesses dates and sexagesimals
 * is a parser with opinions about a document it has not read.
 */

/** Where a line is, so a refusal can point at it. */
interface Line {
  readonly n: number
  readonly indent: number
  /** Comment stripped, right-trimmed. Empty when the line was blank or a comment. */
  readonly text: string
  /** Exactly as written, for block scalars, which keep their own comments. */
  readonly raw: string
}

export class YamlError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.line = line
    this.name = 'YamlError'
  }
}

/** Where a `#` turns into a comment: at the start, or after a space, outside quotes. */
const stripComment = (text: string): string => {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return text.slice(0, i)
  }
  return text
}

const indentOf = (raw: string): number => {
  let n = 0
  while (raw[n] === ' ') n += 1
  return n
}

/** `"a b"`, `'a b'`, `true`, `3`, or the text as it stands. */
const scalar = (text: string, line: number): unknown => {
  const value = text.trim()
  if (value === '') return ''
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new YamlError('a double-quoted string is not closed', line)
    }
    return value
      .slice(1, -1)
      .replace(/\\(["\\/nrt])/g, (_whole, code: string) =>
        code === 'n' ? '\n' : code === 'r' ? '\r' : code === 't' ? '\t' : code,
      )
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new YamlError('a single-quoted string is not closed', line)
    }
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d*\.\d+$/.test(value)) return Number(value)
  if (value.startsWith('&') || value.startsWith('*')) {
    throw new YamlError(
      `anchors and aliases are not read here (found "${value.split(/\s/)[0]}") — write the value out`,
      line,
    )
  }
  if (value.startsWith('!')) {
    throw new YamlError(`tags are not read here (found "${value.split(/\s/)[0]}")`, line)
  }
  return value
}

/** `[a, b]` and `{a: b, c: d}` on one line, nested. Everything else is a scalar. */
const flowValue = (text: string, line: number): unknown => {
  const value = text.trim()
  if (!value.startsWith('[') && !value.startsWith('{')) return scalar(value, line)
  let at = 0
  const read = (): unknown => {
    skip()
    const ch = value[at]
    if (ch === '[') {
      at += 1
      const list: unknown[] = []
      skip()
      if (value[at] === ']') {
        at += 1
        return list
      }
      for (;;) {
        list.push(read())
        skip()
        if (value[at] === ',') {
          at += 1
          continue
        }
        if (value[at] === ']') {
          at += 1
          return list
        }
        throw new YamlError('a [list] is missing a comma or its closing bracket', line)
      }
    }
    if (ch === '{') {
      at += 1
      const map: Record<string, unknown> = {}
      skip()
      if (value[at] === '}') {
        at += 1
        return map
      }
      for (;;) {
        skip()
        const key = readPlain(':')
        skip()
        if (value[at] !== ':') throw new YamlError('a {map} entry is missing its colon', line)
        at += 1
        map[String(key)] = read()
        skip()
        if (value[at] === ',') {
          at += 1
          continue
        }
        if (value[at] === '}') {
          at += 1
          return map
        }
        throw new YamlError('a {map} is missing a comma or its closing brace', line)
      }
    }
    return readPlain(',]}')
  }
  const skip = (): void => {
    while (value[at] === ' ' || value[at] === '\t') at += 1
  }
  const readPlain = (stop: string): unknown => {
    skip()
    const quote = value[at]
    if (quote === '"' || quote === "'") {
      let end = at + 1
      while (end < value.length && value[end] !== quote) end += quote === '"' && value[end] === '\\' ? 2 : 1
      if (value[end] !== quote) throw new YamlError('a quoted string is not closed', line)
      const raw = value.slice(at, end + 1)
      at = end + 1
      return scalar(raw, line)
    }
    const start = at
    while (at < value.length && !stop.includes(value[at] as string)) at += 1
    return scalar(value.slice(start, at), line)
  }
  const parsed = read()
  skip()
  if (at !== value.length) {
    throw new YamlError(`there is text after the end of the value: "${value.slice(at)}"`, line)
  }
  return parsed
}

/** Splits `key: value` at the first colon outside quotes. Null when there is none. */
const splitKey = (text: string): { key: string; rest: string } | null => {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') return null
    if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ')) {
      return { key: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

/**
 * Reads a subset of YAML into plain data, or throws a `YamlError` naming the
 * line and what is wrong with it.
 */
export const parseYaml = (source: string): unknown => {
  const rows = source.split(/\r?\n/)
  const lines: Line[] = rows.map((raw, index) => {
    if (/^\s*\t/.test(raw)) {
      throw new YamlError('indentation must be spaces — this line starts with a tab', index + 1)
    }
    const stripped = stripComment(raw).replace(/\s+$/, '')
    return { n: index + 1, indent: indentOf(raw), text: stripped.trim() === '' ? '' : stripped, raw }
  })
  /* A document marker is only a marker at column zero. Indented it is
     content, and the one place it is *routinely* content is a block scalar
     holding the shape of a file — front matter, which is how every document
     in this repository begins. This scan runs before anything is parsed, so
     it compared the line trimmed; there was then nowhere in a block scalar to
     put three hyphens, and quoting could not help because the scan sees the
     raw line list. Reading the indentation off `raw` keeps the refusal for a
     genuine second document and returns the block scalar's body to it. */
  for (const line of lines) {
    if (indentOf(line.raw) !== 0) continue
    if (line.text.trim() === '---' || line.text.trim() === '...') {
      throw new YamlError('one document per file — the "---" separator is not read here', line.n)
    }
  }

  /** The next line with content at or after `from`. */
  const next = (from: number): number => {
    let at = from
    while (at < lines.length && (lines[at] as Line).text === '') at += 1
    return at
  }

  /** A block scalar's body: every following line indented past `parent`. */
  const blockScalar = (
    header: string,
    from: number,
    parent: number,
    line: number,
  ): { value: string; at: number } => {
    const style = header[0] as string
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
    if (!/^[|>][-+]?\d*$/.test(header)) {
      throw new YamlError(`"${header}" is not a block scalar this reads — use |, |-, > or >-`, line)
    }
    let at = from
    let base: number | null = null
    const body: string[] = []
    while (at < lines.length) {
      const row = lines[at] as Line
      const blank = row.raw.trim() === ''
      if (!blank && indentOf(row.raw) <= parent) break
      if (!blank && base === null) base = indentOf(row.raw)
      body.push(blank ? '' : row.raw.slice(base ?? indentOf(row.raw)))
      at += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    let value =
      style === '|'
        ? body.join('\n')
        : /* Folded: a run of text becomes one line, a blank line stays a break. */
          body
            .reduce<string[]>((out, row) => {
              if (row === '') out.push('')
              else if (out.length === 0 || out[out.length - 1] === '') out.push(row)
              else out[out.length - 1] = `${out[out.length - 1] as string} ${row}`
              return out
            }, [])
            .join('\n')
    if (chomp !== 'strip' && value !== '') value += '\n'
    return { value, at }
  }

  const parseNode = (from: number, indent: number): { value: unknown; at: number } => {
    const start = next(from)
    if (start >= lines.length) return { value: null, at: start }
    const first = lines[start] as Line
    if (first.indent < indent) return { value: null, at: start }
    return first.text.trim() === '-' || first.text.trim().startsWith('- ')
      ? parseSeq(start, first.indent)
      : parseMap(start, first.indent)
  }

  const parseSeq = (from: number, indent: number): { value: unknown; at: number } => {
    const list: unknown[] = []
    let at = from
    for (;;) {
      at = next(at)
      if (at >= lines.length) break
      const line = lines[at] as Line
      if (line.indent < indent) break
      if (line.indent > indent) {
        throw new YamlError('this line is indented past the list it is in', line.n)
      }
      const body = line.text.trim()
      if (body !== '-' && !body.startsWith('- ')) break
      const rest = body === '-' ? '' : body.slice(2).trim()
      at += 1
      if (rest === '') {
        const nested = parseNode(at, indent + 1)
        list.push(nested.value)
        at = nested.at
        continue
      }
      /* `- key: value` opens a map whose first key sits on the dash's own
         line, which is how almost every list of records is written. Its other
         keys are indented to where that key starts. */
      const pair = splitKey(rest)
      if (pair) {
        const inner = line.text.indexOf(rest)
        const map: Record<string, unknown> = {}
        const value = readValue(pair.rest, at, inner, line.n)
        map[pair.key] = value.value
        at = value.at
        const more = parseMapInto(map, at, inner)
        list.push(map)
        at = more
        continue
      }
      if (/^[|>][-+]?$/.test(rest)) {
        const block = blockScalar(rest, at, indent, line.n)
        list.push(block.value)
        at = block.at
        continue
      }
      list.push(flowValue(rest, line.n))
    }
    return { value: list, at }
  }

  /** The value on the right of a `key:`, which may be on the following lines. */
  const readValue = (
    rest: string,
    from: number,
    indent: number,
    line: number,
  ): { value: unknown; at: number } => {
    if (rest === '') {
      const nested = parseNode(from, indent + 1)
      return nested.at === from && nested.value === null ? { value: null, at: from } : nested
    }
    if (/^[|>][-+]?\d*$/.test(rest)) return mapBlock(blockScalar(rest, from, indent, line))
    return { value: flowValue(rest, line), at: from }
  }

  const mapBlock = (block: { value: string; at: number }): { value: unknown; at: number } => ({
    value: block.value,
    at: block.at,
  })

  const parseMapInto = (map: Record<string, unknown>, from: number, indent: number): number => {
    let at = from
    for (;;) {
      at = next(at)
      if (at >= lines.length) return at
      const line = lines[at] as Line
      if (line.indent < indent) return at
      if (line.indent > indent) {
        throw new YamlError('this line is indented past the block it is in', line.n)
      }
      const body = line.text.trim()
      if (body.startsWith('- ') || body === '-') return at
      const pair = splitKey(body)
      if (!pair) {
        throw new YamlError(`"${body}" is not "key: value" — a map entry needs a colon`, line.n)
      }
      if (pair.key === '') throw new YamlError('a map entry has no key before its colon', line.n)
      const key = String(scalar(pair.key, line.n))
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        throw new YamlError(`"${key}" is set twice in the same block`, line.n)
      }
      at += 1
      const value = readValue(pair.rest, at, indent, line.n)
      map[key] = value.value
      at = value.at
    }
  }

  const parseMap = (from: number, indent: number): { value: unknown; at: number } => {
    const map: Record<string, unknown> = {}
    const at = parseMapInto(map, from, indent)
    return { value: map, at }
  }

  const head = next(0)
  if (head >= lines.length) return null
  const document = parseNode(head, (lines[head] as Line).indent)
  const trailing = next(document.at)
  if (trailing < lines.length) {
    throw new YamlError(
      'this line is outside the document — check the indentation above it',
      (lines[trailing] as Line).n,
    )
  }
  return document.value
}
