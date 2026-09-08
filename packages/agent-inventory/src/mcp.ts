/**
 * MCP servers: one canonical spec, per-agent codecs, and a `canHost`
 * preflight.
 *
 * Every agent measured stores the same idea — a name mapping to either a
 * command to run or a URL to reach — but each spells it in its own file and
 * its own dialect. The codec's job is faithful translation both ways, and
 * `canHost` is the honesty rule applied to writes: a pair the target's
 * format cannot represent is excluded and said so, never written
 * misrepresented. The example that forced this: Codex's TOML has no SSE
 * spelling, so writing an SSE server there persists a url-only entry Codex
 * loads as streamable HTTP — a silent reclassification the reader would
 * then confirm.
 */

/** The canonical shape every dialect encodes from and decodes to. */
export interface McpServerSpec {
  readonly name: string
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * A stable serialization of a spec — fixed field order, env/headers as sorted
 * pairs — so the same server means the same string however its dialect spelled
 * it or its optional keys were decoded. It is what "are these two copies the
 * same server?" must digest: comparing the per-dialect *text* reports a server
 * correctly present in two agents as `differs` forever, and refuses an
 * identical install as "different settings".
 */
export const canonicalMcp = (spec: McpServerSpec): string => {
  const sorted = (record: Readonly<Record<string, string>> | undefined): [string, string][] =>
    Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify({
    name: spec.name,
    transport: spec.transport,
    command: spec.command ?? null,
    url: spec.url ?? null,
    args: spec.args ?? [],
    env: sorted(spec.env),
    headers: sorted(spec.headers),
  })
}

/**
 * Which spelling family a configuration file uses. Derived from brand, not
 * format: Gemini's `settings.json` and Claude Code's `.claude.json` are both
 * JSON and disagree about what a bare `url` means.
 */
export type McpDialect = 'claude' | 'cursor' | 'gemini' | 'codex'

export const dialectFor = (brand: string): McpDialect | null => {
  if (brand === 'claudecode' || brand === 'claude') return 'claude'
  if (brand === 'cursor' || brand === 'cursoragent') return 'cursor'
  if (brand === 'geminicli' || brand === 'gemini') return 'gemini'
  if (brand === 'codex' || brand === 'openaicodex') return 'codex'
  return null
}

/**
 * Transport normalisation: `streamable-http`, `streamableHttp`, `Streamable
 * HTTP` and `http` are one transport; `local` is OpenCode's spelling of
 * stdio. Everything unrecognised returns null rather than a guess.
 */
const normaliseTransport = (raw: unknown): 'stdio' | 'http' | 'sse' | null => {
  if (typeof raw !== 'string') return null
  const squeezed = raw.toLowerCase().replace(/[\s_-]/g, '')
  if (squeezed === 'stdio' || squeezed === 'local') return 'stdio'
  if (squeezed === 'http' || squeezed === 'streamablehttp' || squeezed === 'remote') return 'http'
  if (squeezed === 'sse') return 'sse'
  return null
}

/**
 * "Present, but this format's value could not be carried faithfully." A
 * decoder that hits it returns `null` so the copy is *refused* rather than
 * written with a field silently dropped — the whole point of the canonical
 * layer is that a translation it cannot make honestly is one it declines.
 */
const LOSSY = Symbol('mcp-lossy')

const stringRecord = (value: unknown): Record<string, string> | undefined | typeof LOSSY => {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return LOSSY
  const entries = Object.entries(value as Record<string, unknown>)
  // A number or boolean env value (`PORT: 3000`) is meaningful; dropping it
  // would install a server that starts wrong, so refuse instead.
  if (entries.some(([, entry]) => typeof entry !== 'string')) return LOSSY
  const out: Record<string, string> = {}
  for (const [key, entry] of entries) out[key] = entry as string
  return Object.keys(out).length > 0 ? out : undefined
}

const stringArray = (value: unknown): string[] | undefined | typeof LOSSY => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return LOSSY
  // One non-string element (`8080`) would otherwise take the whole args list
  // with it and launch the server with no arguments at all.
  return value.every((one) => typeof one === 'string') ? (value as string[]) : LOSSY
}

/** One JSON declaration → canonical, per the dialect that wrote it. */
const decodeJsonEntry = (name: string, entry: unknown, dialect: McpDialect): McpServerSpec | null => {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const declared = normaliseTransport(record['type'] ?? record['transport'])
  const command = typeof record['command'] === 'string' ? record['command'] : undefined

  if (command !== undefined && (declared === null || declared === 'stdio')) {
    const args = stringArray(record['args'])
    const env = stringRecord(record['env'])
    if (args === LOSSY || env === LOSSY) return null
    return {
      name,
      transport: 'stdio',
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    }
  }

  // Gemini splits the meaning across two keys: `httpUrl` is streamable HTTP
  // and a bare `url` is SSE. Everyone else's bare `url` is streamable HTTP.
  const httpUrl = typeof record['httpUrl'] === 'string' ? record['httpUrl'] : undefined
  const url = typeof record['url'] === 'string' ? record['url'] : undefined
  const headers = stringRecord(record['headers'])
  if (headers === LOSSY) return null

  let transport: 'http' | 'sse' | null = declared === 'stdio' ? null : declared
  let resolved = url
  if (dialect === 'gemini' && httpUrl !== undefined) {
    transport ??= 'http'
    resolved = httpUrl
  } else if (dialect === 'gemini' && url !== undefined) {
    transport ??= 'sse'
  } else if (url !== undefined) {
    transport ??= 'http'
  }
  if (resolved === undefined || transport === null) return null
  return { name, transport, url: resolved, ...(headers ? { headers } : {}) }
}

/** One `[mcp_servers.<name>]` table body → canonical. */
const decodeTomlEntry = (name: string, body: string): McpServerSpec | null => {
  const string = (key: string): string | undefined =>
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(body)?.[1]
  const command = string('command')
  if (command !== undefined) {
    // Refuse rather than decode a partial server: a field this reader cannot
    // parse faithfully (a multi-line array, a sub-table `env`, an unusual key)
    // must not be silently dropped and then written as a different server.
    let args: string[] | undefined
    const argsRaw = /^\s*args\s*=\s*(\[[^\]]*\])/m.exec(body)?.[1]
    if (argsRaw !== undefined) {
      let parsed: unknown
      try {
        // A TOML array of double-quoted strings is JSON-compatible.
        parsed = JSON.parse(argsRaw)
      } catch {
        return null
      }
      const cleaned = stringArray(parsed)
      if (cleaned === LOSSY) return null
      args = cleaned
    } else if (/^\s*args\s*=/m.test(body)) {
      // An args line we could not even bracket-match (a multi-line array).
      return null
    }

    const env: Record<string, string> = {}
    const envRaw = /^\s*env\s*=\s*\{([^}]*)\}/m.exec(body)?.[1]
    if (envRaw !== undefined) {
      for (const pair of envRaw.split(',').map((one) => one.trim()).filter(Boolean)) {
        const match = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(pair)
        if (!match || match[1] === undefined || match[2] === undefined) return null
        env[match[1]] = match[2]
      }
    } else if (/^\s*env\s*=/m.test(body)) {
      // An env line in a shape this reader does not carry (a sub-table, or a
      // key spelling like `API-KEY` the encoder would mangle).
      return null
    }

    return {
      name,
      transport: 'stdio',
      command,
      ...(args ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    }
  }
  const url = string('url')
  // A url-only table is how Codex spells streamable HTTP — there is no SSE
  // spelling in this format at all, which is exactly why canHost refuses it.
  if (url !== undefined) return { name, transport: 'http', url }
  return null
}

/**
 * Whether this dialect can say what the spec means — not whether it would
 * accept the bytes. Refusals carry the sentence the cell shows.
 */
export const canHostMcp = (
  dialect: McpDialect | null,
  spec: McpServerSpec,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
  if (dialect === null) {
    return { ok: false, reason: 'No configuration location is known for this agent, so nothing can be written for it.' }
  }
  if (dialect === 'codex') {
    if (spec.transport === 'sse') {
      return {
        ok: false,
        reason:
          'Codex’s config.toml has no SSE spelling — a url-only entry would be loaded as streamable HTTP, a different server than the one configured.',
      }
    }
    if (spec.headers && Object.keys(spec.headers).length > 0) {
      return {
        ok: false,
        reason: 'This server sends custom headers, and no header spelling has been measured in Codex’s config.toml.',
      }
    }
  }
  if (dialect === 'cursor' && spec.transport === 'sse') {
    return {
      ok: false,
      reason:
        'Cursor’s mcp.json carries no explicit transport field, so an SSE server cannot be spelled unambiguously there.',
    }
  }
  if (spec.transport === 'stdio' && spec.command === undefined) {
    return { ok: false, reason: 'A stdio server without a command cannot be written anywhere.' }
  }
  if (spec.transport !== 'stdio' && spec.url === undefined) {
    return { ok: false, reason: 'A remote server without a URL cannot be written anywhere.' }
  }
  return { ok: true }
}

/** Canonical → one dialect's JSON declaration. Call `canHostMcp` first. */
export const encodeJsonEntry = (spec: McpServerSpec, dialect: McpDialect): Record<string, unknown> => {
  if (spec.transport === 'stdio') {
    return {
      command: spec.command,
      ...(spec.args && spec.args.length > 0 ? { args: spec.args } : {}),
      ...(spec.env && Object.keys(spec.env).length > 0 ? { env: spec.env } : {}),
    }
  }
  const headers = spec.headers && Object.keys(spec.headers).length > 0 ? { headers: spec.headers } : {}
  if (dialect === 'gemini') {
    return spec.transport === 'http'
      ? { httpUrl: spec.url, ...headers }
      : { url: spec.url, ...headers }
  }
  if (dialect === 'claude') {
    return { type: spec.transport, url: spec.url, ...headers }
  }
  // Cursor: a bare url is streamable HTTP; SSE was refused by the preflight.
  return { url: spec.url, ...headers }
}

/** Canonical → a `[<key>.<name>]` TOML block. Call `canHostMcp` first. */
export const encodeTomlBlock = (spec: McpServerSpec, key: string): string => {
  const lines = [`[${key}.${escapeTomlKey(spec.name)}]`]
  if (spec.transport === 'stdio') {
    lines.push(`command = ${JSON.stringify(spec.command ?? '')}`)
    if (spec.args && spec.args.length > 0) {
      lines.push(`args = [${spec.args.map((one) => JSON.stringify(one)).join(', ')}]`)
    }
    if (spec.env && Object.keys(spec.env).length > 0) {
      const pairs = Object.entries(spec.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      lines.push(`env = { ${pairs.join(', ')} }`)
    }
  } else {
    lines.push(`url = ${JSON.stringify(spec.url ?? '')}`)
  }
  return lines.join('\n')
}

/** A bare key where TOML allows it; quoted where it does not. */
const escapeTomlKey = (name: string): string =>
  /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)

/** A TOML line with any trailing `# comment` removed, trimmed. */
const tomlCode = (line: string): string => line.replace(/\s+#.*$/, '').trim()

/** Where one server's table sits in a TOML file, as [start, end) line indices. */
const tomlBlockRange = (
  lines: readonly string[],
  key: string,
  name: string,
): { readonly start: number; readonly end: number } | null => {
  const spellings = [name, JSON.stringify(name), `'${name}'`]
  const heads = spellings.map((one) => `[${key}.${one}]`)
  // Sub-tables of the same server ([key.name.tools.x]) belong to its block.
  const subHeads = spellings.map((one) => `[${key}.${one}.`)
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    // The header may carry a trailing comment (`[mcp_servers.x]  # work`), a
    // valid TOML form; matching the raw trimmed line missed it, and the write
    // path then appended a *second* table of the same name — which no TOML
    // parser accepts, breaking the whole config.
    const code = tomlCode(lines[index] ?? '')
    if (start === -1) {
      if (heads.includes(code)) start = index
      continue
    }
    if (code.startsWith('[') && !subHeads.some((one) => code.startsWith(one))) {
      // The blank lines and comments that sit just before the next table
      // belong to *that* server, not this one; leave them out of the range so
      // removing this block does not delete the next block's annotation.
      let end = index
      while (end > start + 1) {
        const prior = (lines[end - 1] ?? '').trim()
        if (prior === '' || prior.startsWith('#')) end -= 1
        else break
      }
      return { start, end }
    }
  }
  return start === -1 ? null : { start, end: lines.length }
}

/**
 * One server's declaration as it currently sits in the file — the guard
 * digest's input, and the "before" half of every preview. Null when absent
 * or unreadable, which reads as absent on purpose: a file this cannot parse
 * is one this must not edit either, and `applyMcpEdit` refuses it too.
 */
export const readRawMcpEntry = (
  text: string | null,
  format: 'json' | 'toml',
  key: string,
  name: string,
): string | null => {
  if (text === null) return null
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, key)) return null
      const servers = parsed[key]
      // Own-key only: a server named `constructor` or `toString` would
      // otherwise read a value off Object.prototype and return `undefined`
      // from JSON.stringify, which the callers then digest and crash on.
      if (!servers || typeof servers !== 'object' || !Object.hasOwn(servers, name)) return null
      const entry = (servers as Record<string, unknown>)[name]
      return entry === undefined ? null : JSON.stringify(entry, null, 2)
    } catch {
      return null
    }
  }
  const lines = text.split('\n')
  const range = tomlBlockRange(lines, key, name)
  return range === null ? null : lines.slice(range.start, range.end).join('\n').trimEnd()
}

/**
 * Decode one raw declaration on its own — the text `readRawMcpEntry` returns
 * and the backups keep — without the file around it. What a restore parses.
 */
export const decodeRawMcpEntry = (
  raw: string,
  format: 'json' | 'toml',
  name: string,
  dialect: McpDialect,
): McpServerSpec | null => {
  if (format === 'json') {
    try {
      return decodeJsonEntry(name, JSON.parse(raw), dialect)
    } catch {
      return null
    }
  }
  return decodeTomlEntry(name, raw)
}

/** Decode whatever spelling the file uses into the canonical spec. */
export const decodeMcpEntry = (
  text: string | null,
  format: 'json' | 'toml',
  key: string,
  name: string,
  dialect: McpDialect,
): McpServerSpec | null => {
  if (text === null) return null
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || !Object.hasOwn(parsed, key)) return null
      const servers = parsed[key]
      if (!servers || typeof servers !== 'object' || !Object.hasOwn(servers, name)) return null
      return decodeJsonEntry(name, (servers as Record<string, unknown>)[name], dialect)
    } catch {
      return null
    }
  }
  const raw = readRawMcpEntry(text, 'toml', key, name)
  return raw === null ? null : decodeTomlEntry(name, raw)
}

/**
 * The whole edit, functionally: the file's text in, the file's text out,
 * with exactly one server added, replaced, or removed (`entry: null`).
 *
 * JSON files are re-serialised — which is what the owning agents themselves
 * do to them — preserving the file's indent and every other key untouched.
 * A JSON file that does not parse is refused with a thrown error rather
 * than clobbered: an unparseable configuration is the person's problem to
 * see, never this function's licence to rewrite it.
 */
export const applyMcpEdit = (
  text: string | null,
  format: 'json' | 'toml',
  key: string,
  name: string,
  spec: McpServerSpec | null,
  dialect: McpDialect,
): string => {
  if (format === 'json') {
    let parsed: Record<string, unknown> = {}
    let indent: string | number = 2
    if (text !== null && text.trim() !== '') {
      parsed = JSON.parse(text) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('The configuration file is not a JSON object.')
      }
      const sniffed = /\n(\s+)"/.exec(text)?.[1]
      if (sniffed !== undefined) indent = sniffed.includes('\t') ? '\t' : sniffed.length
    }
    // A null-prototype carrier so a server named `__proto__` becomes an own
    // key we can write and serialise, rather than invoking the object's
    // prototype setter and silently changing nothing on disk.
    const existing = Object.hasOwn(parsed, key) ? parsed[key] : undefined
    const servers: Record<string, unknown> = Object.assign(
      Object.create(null),
      existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {},
    )
    if (spec === null) delete servers[name]
    else servers[name] = encodeJsonEntry(spec, dialect)
    const next = { ...parsed, [key]: servers }
    return `${JSON.stringify(next, null, indent)}\n`
  }

  const lines = text === null ? [] : text.split('\n')
  const range = tomlBlockRange(lines, key, name)
  const block = spec === null ? [] : encodeTomlBlock(spec, key).split('\n')
  if (range !== null) {
    // Keep one blank line where the removed block met what follows.
    const before = lines.slice(0, range.start)
    const after = lines.slice(range.end)
    const joined = [...before, ...block, ...after]
    return joined.join('\n')
  }
  if (spec === null) return lines.join('\n')
  const body = lines.join('\n').replace(/\n+$/, '')
  return body === '' ? `${block.join('\n')}\n` : `${body}\n\n${block.join('\n')}\n`
}
