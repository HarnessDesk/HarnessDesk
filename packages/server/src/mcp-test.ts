import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'

import { canonicalMcp, digestOf, findMcpDeclaration, type McpDialect, type McpServerSpec } from '@harnessdesk/agent-inventory'
import type { McpTestFailure, McpTestResult, McpTestTarget } from '@harnessdesk/protocol'

import { checkEnvironment } from './evidence/run.js'

/**
 * Test connection: the one place HarnessDesk starts an MCP server itself.
 *
 * Everywhere else the agent owns its servers and the desk renders what the
 * agent reports. Agents behind ACP report no per-server status, though, so a
 * person cannot tell whether a server works until a turn fails on it. This
 * starts the declared server (or reaches its URL), asks `initialize` and
 * `tools/list`, and stops it — on a click, once, bounded. The rules it keeps
 * are `docs/decisions.md` › *Test connection starts a server, once, on a click*.
 *
 * Deliberately not the attachments gateway's transport: that one serves a
 * standing tool call and has other bounds. This one is a probe, and every
 * bound here is about the probe — one deadline, one process group, a stderr
 * tail, no secret in anything it answers.
 */

/** The whole test, every phase included. */
export const MCP_TEST_TIMEOUT_MS = 15_000
/** How much of stderr is kept to explain a failure: the tail. */
const STDERR_LIMIT = 4 * 1024
/** One stdout line or one HTTP body larger than this is not a reply this test reads. */
const MESSAGE_LIMIT = 4 * 1024 * 1024
/** A `tools/list` that keeps naming another page past this is a protocol failure, not a loop. */
const MAX_PAGES = 100
/** How long a server has after SIGTERM before its whole group is killed outright. */
const KILL_GRACE_MS = 500
/** Most tests one desk runs at once, across every server. */
export const MCP_TEST_MAX_IN_FLIGHT = 4
/** Recent and widely spoken; a server answers with the version it speaks instead. */
const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'harnessdesk-test', version: '1' }

class TestFailure extends Error {
  constructor(readonly reason: McpTestFailure, detail: string) {
    super(detail)
  }
}

/** Colour, cursor and terminal-string codes, and every control but line feeds and tabs. */
const plain = (text: string): string =>
  stripVTControlCharacters(text.replace(/\x1b(?:P|X|\^|_|\])[\s\S]*?(?:\x07|\x1b\\|$)/g, '')).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    '',
  )

/** A URL's user name and password, wherever it sits in a value: `http://jane:pw@host` → `http://host`. */
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)?[^/?#\s]*@/i

/** The value with any user name and password before its host taken out, the scheme kept. */
export const withoutUserinfo = (value: string, replacement = ''): string => value.replace(USERINFO, `$1${replacement}`)

/**
 * Every configured value that could be a secret, and the masking that keeps
 * them in the host. A server that prints its own token on a crash, or an
 * HTTP error page that reflects a header, says it here as `•••`.
 *
 * Variable and header values, and a URL's user name and password, are
 * masked from four characters up. Arguments, the URL itself and its query
 * values only from eight: a short argument such as `.` or `-y` is everywhere
 * in ordinary output, and masking it would leave nothing readable.
 */
export const mcpSecretMask = (spec: McpServerSpec): ((text: string) => string) => {
  const values = new Set<string>()
  const add = (value: string, whole: number): void => {
    if (value.length >= whole) values.add(value)
    // `Bearer abc…` is masked whole and by its token, which is what a server echoes.
    for (const part of value.split(/\s+/)) if (part.length >= 8) values.add(part)
  }
  for (const value of [...Object.values(spec.env ?? {}), ...Object.values(spec.headers ?? {})]) add(value, 4)
  for (const arg of spec.args ?? []) {
    add(arg, 8)
    // `--token=…`: the value alone is what a server repeats.
    const assigned = /^[^=]+=(.+)$/.exec(arg)?.[1]
    if (assigned !== undefined) add(assigned, 8)
  }
  if (spec.url) {
    add(spec.url, 8)
    try {
      const url = new URL(spec.url)
      for (const part of [url.username, url.password]) {
        if (part === '') continue
        add(part, 4)
        try {
          add(decodeURIComponent(part), 4)
        } catch {
          // Not percent-encoded text; the raw form is masked already.
        }
      }
      for (const value of url.searchParams.values()) add(value, 8)
    } catch {
      // Not a URL: masked whole above, and the test will say it cannot use it.
    }
  }
  const ordered = [...values].sort((a, b) => b.length - a.length)
  return (text) => ordered.reduce((out, value) => out.split(value).join('•••'), text)
}

/**
 * Variables that decide which program a command line starts, or what that
 * program loads before its own code: the search path, a shell's or a
 * runtime's startup file, options and preloads, and where a package runner
 * fetches from. A confirmation shows these with their values.
 */
const LAUNCH_VARIABLE =
  /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|ZDOTDIR|IFS|LD_\w*|DYLD_\w*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NPM_CONFIG_\w*|COREPACK_\w*|BUN_\w*|DENO_\w*|PYTHON\w*|PIP_\w*|UV_\w*|VIRTUAL_ENV|CONDA_\w*|RUBYOPT|RUBYLIB|GEM_\w*|BUNDLE_\w*|PERL5OPT|PERL5LIB|PERLLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JAVA_HOME|CLASSPATH|GOFLAGS|GOPROXY|GIT_\w*)$/i

export const isLaunchVariable = (name: string): boolean => LAUNCH_VARIABLE.test(name)

/**
 * The target as a person is shown it: the exact command or URL; the
 * variables that change what starts, with their values; every other variable
 * and every header by name only.
 */
export const mcpTestTarget = (spec: McpServerSpec, scope: 'user' | 'project', cwd: string): McpTestTarget => {
  if (spec.transport !== 'stdio') {
    return { transport: spec.transport, scope, url: spec.url ?? '', headerNames: Object.keys(spec.headers ?? {}).sort() }
  }
  const names = Object.keys(spec.env ?? {}).sort()
  return {
    transport: 'stdio',
    scope,
    command: spec.command ?? '',
    args: [...(spec.args ?? [])],
    cwd,
    launchEnv: names.filter(isLaunchVariable).map((name) => ({ name, value: withoutUserinfo(spec.env?.[name] ?? '', '•••@') })),
    envNames: names.filter((name) => !isLaunchVariable(name)),
  }
}

/** What a confirmation vouches for: the whole declaration and where it runs, values included, digested. */
const targetDigest = (spec: McpServerSpec, cwd: string): string => digestOf(`${canonicalMcp(spec)}\n${cwd}`)

/**
 * The location table identifies the reader; JSON alone does not identify a dialect.
 * Claude: https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json
 * Cursor: https://cursor.com/docs/mcp#config-interpolation (env:NAME, not bare NAME).
 * Gemini: packages/cli/src/utils/envVarResolver.ts in google-gemini/gemini-cli,
 * applied recursively by its settings loader: bare $NAME and braced defaults too.
 * Codex strings are literal; env_vars explicitly forwards names from its environment:
 * https://developers.openai.com/codex/mcp#stdio-servers
 *
 * No shell, recursive substitution, or evaluation of nested braces. Missing names
 * refuse the probe even where an agent would warn and keep the placeholder.
 */
export const expandMcpTestSpec = (
  declaration: McpServerSpec,
  dialect: McpDialect,
  from: NodeJS.ProcessEnv = process.env,
): { spec: McpServerSpec; names: readonly string[]; secrets: readonly string[] } => {
  const names = new Set<string>()
  const secrets = new Set<string>()
  const read = (name: string, fallback?: string): string => {
    names.add(name)
    const value = Object.hasOwn(from, name) ? from[name] : undefined
    if (value === undefined && fallback === undefined) throw new TestFailure('notFound', `Environment variable ${name} is not set. Set it before testing this server.`)
    const resolved = value ?? fallback ?? ''
    if (resolved !== '') secrets.add(resolved)
    return resolved
  }
  const expand = (text: string): string => {
    if (dialect === 'codex') return text
    // Consume whole balanced expressions so an inner ${NAME} in nested braces
    // cannot be expanded accidentally. A value is substituted exactly once.
    let out = ''
    for (let i = 0; i < text.length;) {
      if (text.startsWith('${', i)) {
        let depth = 1
        let end = i + 2
        let nested = false
        for (; end < text.length && depth > 0; end++) {
          if (text[end] === '{') { depth++; nested = true }
          else if (text[end] === '}') depth--
        }
        const whole = text.slice(i, end)
        const body = text.slice(i + 2, end - 1)
        const match = !nested && depth === 0
          ? dialect === 'cursor' ? /^env:([^{}]+)$/.exec(body) : /^([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?$/.exec(body)
          : null
        out += match?.[1] ? read(match[1], match[2]) : whole
        i = end
      } else if (dialect === 'gemini' && text[i] === '$') {
        const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i))
        if (match?.[1]) { out += read(match[1]); i += match[0].length }
        else { out += text[i]; i++ }
      } else if (dialect === 'gemini' && process.platform === 'win32' && text[i] === '%') {
        const match = /^%([A-Za-z_][A-Za-z0-9_]*)%/.exec(text.slice(i))
        if (match?.[1]) { out += read(match[1]); i += match[0].length }
        else { out += text[i]; i++ }
      } else { out += text[i]; i++ }
    }
    return out
  }
  const record = (values: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(values).map(([name, value]) => [name, expand(value)]))
  const forwarded = Object.fromEntries((declaration.envVars ?? []).map(name => [name, read(name)]))
  return {
    spec: {
      ...declaration,
      ...(declaration.command !== undefined ? { command: expand(declaration.command) } : {}),
      ...(declaration.args !== undefined ? { args: declaration.args.map(expand) } : {}),
      ...(declaration.url !== undefined ? { url: expand(declaration.url) } : {}),
      ...(declaration.headers !== undefined ? { headers: record(declaration.headers) } : {}),
      ...(declaration.env !== undefined || declaration.envVars?.length ? { env: { ...forwarded, ...record(declaration.env ?? {}) } } : {}),
    },
    names: [...names].sort(),
    secrets: [...secrets],
  }
}

const PROXY_VARIABLE = /^(?:http|https|all)_proxy$/i

/**
 * The child's environment: the small set of names a check gets from the desk
 * (`checkEnvironment` — where tools are, whose account, locale, proxy), then
 * the server's own configured variables on top. Nothing else of the desk's —
 * no `HARNESSDESK_*`, no `HD_*`, no token — reaches it. A proxy the desk
 * passes on goes without the user name and password in its URL; a proxy the
 * declaration sets itself is its own and is passed as written.
 */
export const mcpTestEnvironment = (spec: McpServerSpec, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const inherited = checkEnvironment(from)
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && PROXY_VARIABLE.test(name)) inherited[name] = withoutUserinfo(value)
  }
  return { ...inherited, ...(spec.env ?? {}) }
}

interface Handshake {
  readonly serverName?: string
  readonly serverVersion?: string
  readonly protocolVersion: string
}

type Request = (method: string, params: unknown) => Promise<unknown>
type Notify = (method: string, params: unknown) => Promise<void>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `initialize`, `notifications/initialized`, then every page of `tools/list`. */
const converse = async (request: Request, notify: Notify, phase: { current: string }, mask: (text: string) => string): Promise<Handshake & { tools: number }> => {
  phase.current = 'initialize'
  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  })
  if (!isRecord(init) || typeof init['protocolVersion'] !== 'string') {
    throw new TestFailure('protocol', 'It answered initialize without a protocol version.')
  }
  const info = isRecord(init['serverInfo']) ? init['serverInfo'] : {}
  const handshake: Handshake = {
    protocolVersion: init['protocolVersion'],
    ...(typeof info['name'] === 'string' ? { serverName: mask(info['name']).slice(0, 200) } : {}),
    ...(typeof info['version'] === 'string' ? { serverVersion: mask(info['version']).slice(0, 100) } : {}),
  }
  phase.current = 'notifications/initialized'
  await notify('notifications/initialized', {})
  phase.current = 'tools/list'
  let tools = 0
  let cursor: string | undefined
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new TestFailure('protocol', `It kept naming another page of tools after ${MAX_PAGES}.`)
    const listed = await request('tools/list', cursor === undefined ? {} : { cursor })
    if (!isRecord(listed) || !Array.isArray(listed['tools'])) {
      throw new TestFailure('protocol', 'It answered tools/list without a list of tools.')
    }
    tools += listed['tools'].length
    const next = listed['nextCursor']
    if (typeof next !== 'string' || next === '') break
    cursor = next
  }
  return { ...handshake, tools }
}

/** A JSON-RPC reply to one of our requests, or the failure it carries. */
const settleReply = (method: string, message: Record<string, unknown>, mask: (text: string) => string): unknown => {
  if (isRecord(message['error'])) {
    const said = typeof message['error']['message'] === 'string' ? message['error']['message'] : 'an error'
    throw new TestFailure('protocol', `It answered ${method} with an error: ${mask(said).slice(0, 300)}`)
  }
  return message['result']
}

// -- stdio ------------------------------------------------------------------

const groupKill = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (child.pid === undefined) return
  try {
    // A negative pid is the group: the server and everything it started that stayed in it.
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // Already gone.
  }
}

const exited = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()))

const runStdio = async (
  spec: McpServerSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  deadline: AbortSignal,
  stderr: { text: string },
  track: ((child: ChildProcess) => () => void) | undefined,
  mask: (text: string) => string,
  stderrLimit: number,
): Promise<Handshake & { tools: number }> => {
  const command = spec.command
  if (!command) throw new TestFailure('notFound', 'This declaration names no command.')
  let isDir = false
  try {
    isDir = existsSync(cwd) && statSync(cwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new TestFailure('spawnFailed', 'The folder it would run in does not exist.')

  const child = spawn(command, [...(spec.args ?? [])], {
    cwd,
    env,
    // Its own process group, so the end of the test can stop all of it.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const untrack = track?.(child)
  const pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 1
  let failure: TestFailure | null = null
  const fail = (error: TestFailure): void => {
    failure ??= error
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
  }

  const phase = { current: 'initialize' }
  child.on('error', (error: NodeJS.ErrnoException) =>
    fail(new TestFailure('spawnFailed', error.code === 'ENOENT' ? `Could not start ${command}: no such command.` : `Could not start ${command}: ${error.code ?? error.message}.`)),
  )
  child.on('exit', (code, signal) => {
    fail(new TestFailure('spawnFailed', `It exited (${signal ?? `code ${code ?? 'unknown'}`}) before it answered ${phase.current}.`))
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => {
    stderr.text = (stderr.text + chunk.toString('utf8')).slice(-stderrLimit)
  })
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > MESSAGE_LIMIT) {
      fail(new TestFailure('protocol', 'It wrote a line on stdout too long to be a reply.'))
      return
    }
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line === '') continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        fail(new TestFailure('protocol', `It wrote something on stdout that is not JSON-RPC: ${plain(mask(line)).slice(0, 120)}`))
        return
      }
      if (!isRecord(message)) {
        fail(new TestFailure('protocol', 'It wrote a JSON value on stdout that is not a JSON-RPC message.'))
        return
      }
      // A request of the server's own: `ping` is answered, anything else is declined.
      if (typeof message['method'] === 'string') {
        if (message['id'] !== undefined) {
          const answer =
            message['method'] === 'ping'
              ? { jsonrpc: '2.0', id: message['id'], result: {} }
              : { jsonrpc: '2.0', id: message['id'], error: { code: -32601, message: 'Not supported by a connection test' } }
          child.stdin.write(`${JSON.stringify(answer)}\n`)
        }
        continue
      }
      if (typeof message['id'] !== 'number') continue
      const waiter = pending.get(message['id'])
      if (!waiter) continue
      pending.delete(message['id'])
      try {
        waiter.resolve(settleReply(waiter.method, message, mask))
      } catch (error) {
        waiter.reject(error as Error)
      }
    }
  })
  const onDeadline = (): void => fail(new TestFailure('timeout', `It did not answer ${phase.current} within ${Math.round(MCP_TEST_TIMEOUT_MS / 1000)} s.`))
  deadline.addEventListener('abort', onDeadline, { once: true })
  if (deadline.aborted) onDeadline()

  const write = (frame: unknown): void => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  const request: Request = (method, params) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const id = nextId++
      pending.set(id, { method, resolve, reject })
      write({ jsonrpc: '2.0', id, method, params })
    })
  const notify: Notify = async (method, params) => {
    if (failure) throw failure
    write({ jsonrpc: '2.0', method, params })
  }

  try {
    return await converse(request, notify, phase, mask)
  } finally {
    deadline.removeEventListener('abort', onDeadline)
    // Late replies and a late exit change nothing now.
    failure ??= new TestFailure('protocol', 'The test is over.')
    child.stdout.removeAllListeners('data')
    child.stdin.destroy()
    // No pid: it never started, and there is nothing to stop.
    if (child.pid !== undefined) {
      groupKill(child, 'SIGTERM')
      await Promise.race([exited(child), new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS))])
      // Always, not only when the leader lingers: a grandchild that shrugged
      // off SIGTERM is still in the group after its parent has gone.
      groupKill(child, 'SIGKILL')
      await Promise.race([exited(child), new Promise((resolve) => setTimeout(resolve, 1_000))])
    }
    untrack?.()
  }
}

// -- HTTP -------------------------------------------------------------------

/** A response body as text, never more than the limit. */
const readCapped = async (response: Response): Promise<string> => {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.length > MESSAGE_LIMIT) {
      await reader.cancel().catch(() => {})
      throw new TestFailure('protocol', 'It sent a reply too large for a connection test.')
    }
  }
  return text + decoder.decode()
}

/** Server-sent events off a body, as they arrive. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ readonly event: string; readonly data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n')
      if (buffer.length > MESSAGE_LIMIT) throw new TestFailure('protocol', 'It sent an event too large for a connection test.')
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end === -1) break
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
        if (data.length > 0) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new TestFailure('protocol', `It answered ${what} with something that is not JSON.`)
  }
}

/** The failure a non-2xx status means, before any body is read. */
const statusFailure = (response: Response, mask: (text: string) => string): TestFailure | null => {
  if (response.status === 401) {
    return new TestFailure('needsSignIn', 'It asks for sign-in. A test never signs in; sign in through the agent first.')
  }
  if (response.status >= 300 && response.status < 400) {
    return new TestFailure('httpError', `It answered HTTP ${response.status}, a redirect; a test does not follow one.`)
  }
  if (!response.ok) {
    return new TestFailure('httpError', mask(`It answered HTTP ${response.status}${response.statusText ? ` ${plain(response.statusText).slice(0, 80)}` : ''}.`))
  }
  return null
}

const assertWebUrl = (raw: string | undefined): URL => {
  let url: URL
  try {
    url = new URL(raw ?? '')
  } catch {
    throw new TestFailure('notFound', 'This declaration names no usable URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TestFailure('notFound', 'This declaration names a URL that is not http or https.')
  }
  return url
}

/** Streamable HTTP: one POST per message, a JSON or event-stream reply, the session id carried. */
const runHttp = async (
  spec: McpServerSpec,
  deadline: AbortSignal,
  mask: (text: string) => string,
  fetcher: typeof fetch,
): Promise<Handshake & { tools: number }> => {
  const url = assertWebUrl(spec.url)
  let session: string | null = null
  let version: string | null = null
  let nextId = 1
  const post = async (body: unknown): Promise<Response> => {
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'manual',
      signal: deadline,
      headers: {
        ...(spec.headers ?? {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session !== null ? { 'mcp-session-id': session } : {}),
        ...(version !== null ? { 'mcp-protocol-version': version } : {}),
      },
      body: JSON.stringify(body),
    })
    const failed = statusFailure(response, mask)
    if (failed) {
      await response.body?.cancel().catch(() => {})
      throw failed
    }
    return response
  }
  const request: Request = async (method, params) => {
    const id = nextId++
    const response = await post({ jsonrpc: '2.0', id, method, params })
    const sid = response.headers.get('mcp-session-id')
    if (sid !== null && session === null) session = sid
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream') && response.body) {
      for await (const event of sseEvents(response.body)) {
        const message = parseJson(event.data, method)
        const replies = Array.isArray(message) ? message : [message]
        for (const one of replies) {
          if (isRecord(one) && one['id'] === id && one['method'] === undefined) return settleReply(method, one, mask)
        }
      }
      throw new TestFailure('protocol', `Its event stream ended before it answered ${method}.`)
    }
    const message = parseJson(await readCapped(response), method)
    const replies = Array.isArray(message) ? message : [message]
    const reply = replies.find((one) => isRecord(one) && one['id'] === id)
    if (!isRecord(reply)) throw new TestFailure('protocol', `It did not answer ${method}.`)
    return settleReply(method, reply, mask)
  }
  const notify: Notify = async (method, params) => {
    const response = await post({ jsonrpc: '2.0', method, params })
    await response.body?.cancel().catch(() => {})
  }
  const phase = { current: 'initialize' }
  try {
    const result = await converse(
      async (method, params) => {
        const answer = await request(method, params)
        if (method === 'initialize' && isRecord(answer) && typeof answer['protocolVersion'] === 'string') version = answer['protocolVersion']
        return answer
      },
      notify,
      phase,
      mask,
    )
    return result
  } catch (error) {
    if (deadline.aborted) throw new TestFailure('timeout', `It did not answer ${phase.current} within ${Math.round(MCP_TEST_TIMEOUT_MS / 1000)} s.`)
    throw error
  } finally {
    if (session !== null) {
      // Ends the session the test opened; best effort, and never long.
      const ended = new AbortController()
      const timer = setTimeout(() => ended.abort(), 1_000)
      await fetcher(url, {
        method: 'DELETE',
        redirect: 'manual',
        signal: ended.signal,
        headers: { ...(spec.headers ?? {}), 'mcp-session-id': session, ...(version !== null ? { 'mcp-protocol-version': version } : {}) },
      })
        .then((response) => response.body?.cancel())
        .catch(() => {})
      clearTimeout(timer)
    }
  }
}

/** The older SSE transport: a GET stream that names a POST endpoint, replies arriving on the stream. */
const runSse = async (
  spec: McpServerSpec,
  deadline: AbortSignal,
  mask: (text: string) => string,
  fetcher: typeof fetch,
): Promise<Handshake & { tools: number }> => {
  const url = assertWebUrl(spec.url)
  const stream = new AbortController()
  const stop = (): void => stream.abort()
  deadline.addEventListener('abort', stop, { once: true })
  const phase = { current: 'initialize' }
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'manual',
      signal: stream.signal,
      headers: { ...(spec.headers ?? {}), accept: 'text/event-stream' },
    })
    const failed = statusFailure(response, mask)
    if (failed) throw failed
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream') || !response.body) {
      throw new TestFailure('protocol', 'It did not answer with an event stream.')
    }
    const events = sseEvents(response.body)
    let endpoint: URL | null = null
    const waiting = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    let ended: Error | null = null
    const endpointReady = new Promise<URL>((resolve, reject) => {
      void (async () => {
        try {
          for await (const event of events) {
            if (event.event === 'endpoint' && endpoint === null) {
              const named = new URL(event.data, url)
              if (named.origin !== url.origin) throw new TestFailure('protocol', 'It named a message endpoint on another host.')
              endpoint = named
              resolve(named)
              continue
            }
            if (event.event !== 'message') continue
            const message = parseJson(event.data, phase.current)
            if (!isRecord(message) || typeof message['id'] !== 'number' || message['method'] !== undefined) continue
            const waiter = waiting.get(message['id'])
            if (!waiter) continue
            waiting.delete(message['id'])
            try {
              waiter.resolve(settleReply(waiter.method, message, mask))
            } catch (error) {
              waiter.reject(error as Error)
            }
          }
          throw new TestFailure('protocol', `Its event stream ended before it answered ${phase.current}.`)
        } catch (error) {
          ended = error instanceof TestFailure ? error : new TestFailure('protocol', `Its event stream broke before it answered ${phase.current}.`)
          reject(ended)
          for (const waiter of waiting.values()) waiter.reject(ended)
          waiting.clear()
        }
      })()
    })
    endpointReady.catch(() => {})
    const target = await endpointReady
    let nextId = 1
    const send = async (body: unknown): Promise<void> => {
      const posted = await fetcher(target, {
        method: 'POST',
        redirect: 'manual',
        signal: deadline,
        headers: { ...(spec.headers ?? {}), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const refused = statusFailure(posted, mask)
      await posted.body?.cancel().catch(() => {})
      if (refused) throw refused
    }
    const request: Request = (method, params) =>
      new Promise((resolve, reject) => {
        if (ended) {
          reject(ended)
          return
        }
        const id = nextId++
        waiting.set(id, { method, resolve, reject })
        send({ jsonrpc: '2.0', id, method, params }).catch((error: Error) => {
          waiting.delete(id)
          reject(error)
        })
      })
    return await converse(request, (method, params) => send({ jsonrpc: '2.0', method, params }), phase, mask)
  } catch (error) {
    if (deadline.aborted) throw new TestFailure('timeout', `It did not answer ${phase.current} within ${Math.round(MCP_TEST_TIMEOUT_MS / 1000)} s.`)
    throw error
  } finally {
    deadline.removeEventListener('abort', stop)
    stream.abort()
  }
}

// -- the test ---------------------------------------------------------------

export interface McpTestRunOptions {
  /** The folder a command runs in. */
  readonly cwd: string
  readonly timeoutMs?: number
  /** Where the minimal environment's names are read from; the desk's own by default. */
  readonly baseEnv?: NodeJS.ProcessEnv
  /** Resolved reference values are masked even when shorter than ordinary configured secrets. */
  readonly secrets?: readonly string[]
  readonly fetch?: typeof fetch
  /** Ends the test early, as its deadline would. */
  readonly signal?: AbortSignal
  /** Told of the server process once it is started; what it returns is called once the process is stopped. */
  readonly track?: (child: ChildProcess) => () => void
}

/** Run one test against one declaration. Never throws; every failure is an answer. */
export const runMcpTest = async (spec: McpServerSpec, options: McpTestRunOptions): Promise<McpTestResult> => {
  const started = Date.now()
  const configuredMask = mcpSecretMask(spec)
  const secrets = [...(options.secrets ?? [])].filter(value => value !== '').sort((a, b) => b.length - a.length)
  const mask = (text: string): string => configuredMask(secrets.reduce((out, value) => out.split(value).join('•••'), text))
  // Keep one whole reference value before the visible tail, so truncating
  // stderr cannot cut a long value before it has had a chance to be masked.
  const stderrLimit = STDERR_LIMIT + secrets.reduce((longest, value) => Math.max(longest, value.length), 0)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? MCP_TEST_TIMEOUT_MS)
  const deadline = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const stderr = { text: '' }
  const fetcher = options.fetch ?? fetch
  try {
    const result =
      spec.transport === 'stdio'
        ? await runStdio(spec, options.cwd, mcpTestEnvironment(spec, options.baseEnv), deadline, stderr, options.track, mask, stderrLimit)
        : spec.transport === 'http'
          ? await runHttp(spec, deadline, mask, fetcher)
          : await runSse(spec, deadline, mask, fetcher)
    return {
      ok: true,
      tools: result.tools,
      ...(result.serverName !== undefined ? { serverName: mask(plain(result.serverName)) } : {}),
      ...(result.serverVersion !== undefined ? { serverVersion: mask(plain(result.serverVersion)) } : {}),
      ms: Date.now() - started,
    }
  } catch (error) {
    const failure =
      error instanceof TestFailure
        ? error
        : deadline.aborted
          ? new TestFailure('timeout', `It did not answer within ${Math.round((options.timeoutMs ?? MCP_TEST_TIMEOUT_MS) / 1000)} s.`)
          : new TestFailure(spec.transport === 'stdio' ? 'spawnFailed' : 'httpError', `Could not reach it: ${describeNetwork(error)}`)
    const tail = mask(plain(mask(stderr.text))).trim().slice(-STDERR_LIMIT)
    return {
      ok: false,
      reason: failure.reason,
      detail: mask(plain(failure.message)),
      ms: Date.now() - started,
      ...(tail !== '' ? { stderr: tail } : {}),
    }
  }
}

/** A fetch failure's cause, by its code: never the URL, which may carry a key. */
const describeNetwork = (error: unknown): string => {
  const cause = isRecord(error) && isRecord(error['cause']) ? error['cause'] : null
  const code = cause && typeof cause['code'] === 'string' ? cause['code'] : null
  if (code === 'ECONNREFUSED') return 'nothing is listening there.'
  if (code === 'ENOTFOUND') return 'that host name does not resolve.'
  if (code !== null) return `${code}.`
  return 'the request failed.'
}

/**
 * The host's side: one declaration, looked up by identity; confirmation for
 * a project's own servers; never two tests of the same declaration at once,
 * never more than `MCP_TEST_MAX_IN_FLIGHT` in all; and every server it
 * started stopped when the desk stops.
 */
export class McpConnectionTests {
  readonly #running = new Set<string>()
  /** The server processes of tests in flight, each in its own group. */
  readonly #children = new Set<ChildProcess>()
  readonly #stop = new AbortController()
  #disposed = false
  readonly #home: string
  readonly #timeoutMs: number | undefined
  readonly #baseEnv: NodeJS.ProcessEnv | undefined

  constructor(options: { readonly home?: string; readonly timeoutMs?: number; readonly baseEnv?: NodeJS.ProcessEnv } = {}) {
    this.#home = options.home ?? homedir()
    this.#timeoutMs = options.timeoutMs
    this.#baseEnv = options.baseEnv
  }

  async test(params: { readonly name: string; readonly path: string; readonly cwd?: string; readonly confirmed?: string }): Promise<McpTestResult> {
    const found = findMcpDeclaration(params.name, params.path, { home: this.#home, ...(params.cwd !== undefined ? { cwd: params.cwd } : {}) })
    if (!found.found) return { ok: false, reason: 'notFound', detail: found.detail, ms: 0 }
    // A project's server runs in the project; a person's own runs where they are working, or at home.
    const cwd = params.cwd ?? this.#home
    let resolved: ReturnType<typeof expandMcpTestSpec>
    try {
      resolved = expandMcpTestSpec(found.spec, found.dialect, this.#baseEnv)
    } catch (error) {
      return { ok: false, reason: 'notFound', detail: error instanceof TestFailure ? error.message : 'The environment references could not be read.', ms: 0 }
    }
    const digest = targetDigest(resolved.spec, cwd)
    if (found.scope === 'project' && params.confirmed !== digest) {
      return {
        ok: false,
        reason: 'confirm',
        detail: 'This server is declared in the project’s own file. Check what it runs before testing it.',
        ms: 0,
        // Show the declaration's references, never their resolved values. The
        // digest above still binds exactly what runs, including environment changes.
        target: mcpTestTarget({ ...found.spec, env: {
          ...Object.fromEntries((found.spec.envVars ?? []).map(name => [name, `\${${name}}`])),
          ...found.spec.env,
        } }, found.scope, cwd),
        digest,
      }
    }
    if (this.#disposed) return { ok: false, reason: 'busy', detail: 'The desk is stopping.', ms: 0 }
    const key = `${found.file}\0${params.name}`
    if (this.#running.has(key)) {
      return { ok: false, reason: 'busy', detail: 'A test of this server is already running.', ms: 0 }
    }
    if (this.#running.size >= MCP_TEST_MAX_IN_FLIGHT) {
      return {
        ok: false,
        reason: 'busy',
        detail: `${MCP_TEST_MAX_IN_FLIGHT} tests are already running. Try again when one finishes.`,
        ms: 0,
      }
    }
    this.#running.add(key)
    try {
      return await runMcpTest(resolved.spec, {
        cwd,
        secrets: resolved.secrets,
        signal: this.#stop.signal,
        track: (child) => {
          this.#children.add(child)
          return () => this.#children.delete(child)
        },
        ...(this.#timeoutMs !== undefined ? { timeoutMs: this.#timeoutMs } : {}),
        ...(this.#baseEnv !== undefined ? { baseEnv: this.#baseEnv } : {}),
      })
    } finally {
      this.#running.delete(key)
    }
  }

  /**
   * The desk is stopping: every server a test started is killed with its
   * whole group now, not after its grace period, and no test starts again.
   * Requests in flight end as the deadline would end them.
   */
  dispose(): void {
    this.#disposed = true
    for (const child of this.#children) groupKill(child, 'SIGKILL')
    this.#children.clear()
    this.#stop.abort()
  }
}
