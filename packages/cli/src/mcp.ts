/**
 * `harnessdesk mcp`: the command line as a stdio MCP server.
 *
 * An agent that speaks MCP adds this as a server and gets one tool per
 * command (`mcp-tools.ts`). A tool call runs exactly the command a person
 * would type, with `--json`, through its own `CommandIo`: the output is
 * captured for the call, nothing asks on a terminal, and the desk is told the
 * call came from an MCP client, which is what it gates starting work on.
 *
 * The server holds no desk between calls. Each call finds the desk, connects,
 * runs and closes, as one command line does, so a desk that restarts between
 * two calls is simply found again.
 *
 * The framing mirrors `packages/mcp-tools` rather than sharing its code: that
 * binary reads stdin as soon as it is loaded, and the command line may import
 * only the protocol and the client. It is newline-delimited JSON-RPC over the
 * process's own streams, with no Node import.
 */
import { COMMANDS, errorText, runCommand, type CommandIo } from './cli.js'
import { MCP_RUN_WAIT_DEFAULT, ToolInputError, toolsOf, type McpTool } from './mcp-tools.js'

/** How often a long `run_wait` reports progress when the client asked for it. */
export const MCP_PROGRESS_EVERY_MS = 15_000
/** What a peer that does not say who it is is called. */
const UNNAMED = { name: 'mcp-client', version: '0' } as const
/**
 * The MCP versions this server speaks, latest first. A client asking for one
 * of them gets it; a client asking for any other gets the latest, and decides
 * for itself whether it can go on (the protocol's own negotiation).
 */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
type McpVersion = typeof MCP_VERSIONS[number]
/** The negotiated versions whose tool results carry `structuredContent` beside the text. */
const STRUCTURED: ReadonlySet<McpVersion> = new Set(['2025-11-25', '2025-06-18'])
/** The version agreed for a client's request: its own when this server speaks it, otherwise the latest. */
export const negotiate = (requested: unknown): McpVersion =>
  MCP_VERSIONS.find(one => one === requested) ?? MCP_VERSIONS[0]
/** How `run wait` ended, by its exit code. These are answers, not failures. */
const WAIT_ENDINGS: Readonly<Record<number, string>> = { 0: 'settled', 5: 'needsPerson', 7: 'stoppedOrStalled', 8: 'timeout' }

interface Message { readonly id?: string | number | null; readonly method?: string; readonly params?: Record<string, unknown> }
type Content = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: true }

/** A name the peer stated, kept to what `client/hello` accepts: one printable line of at most 64 characters. */
function stated(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64).trim()
  return clean || fallback
}

const MCP_USAGE = 'Usage: harnessdesk mcp [--home DIR]\nServes the desk to an MCP client over standard input and output.\n'

function homeOf(argv: readonly string[]): { home?: string } | string {
  if (argv.length === 0) return {}
  if (argv.length === 2 && argv[0] === '--home' && argv[1] && !argv[1].startsWith('--')) return { home: argv[1] }
  return MCP_USAGE
}

/** Runs the server until standard input ends, and returns the exit code. */
export async function serveMcp(argv: readonly string[]): Promise<number> {
  const options = homeOf(argv)
  if (typeof options === 'string') { process.stderr.write(options); return 2 }
  const tools = new Map<string, McpTool>(toolsOf(COMMANDS).map(tool => [tool.name, tool]))
  const inFlight = new Map<string, { controller: AbortController; done: Promise<void> }>()
  const trace = process.env['HARNESSDESK_MCP_TRACE'] === '1'
  let peer: { name: string; version: string } = { ...UNNAMED }
  // Until a client says otherwise, the oldest: the plainest results.
  let version: McpVersion = MCP_VERSIONS[MCP_VERSIONS.length - 1]!
  let closing = false

  const send = (message: object) => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  const respond = (id: Message['id'], result: object) => send({ id, result })
  const fail = (id: Message['id'], code: number, message: string) => send({ id, error: { code, message } })

  const call = async (id: Message['id'], params: Record<string, unknown>, signal: AbortSignal): Promise<Content | null> => {
    const name = typeof params['name'] === 'string' ? params['name'] : ''
    const tool = tools.get(name)
    if (!tool) return null
    const input = params['arguments'] && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments'])
      ? params['arguments'] as Record<string, unknown> : {}
    let argv: string[]
    try { argv = tool.toArgv(input) } catch (error) {
      if (error instanceof ToolInputError) return { content: [{ type: 'text', text: `exit 2: Usage: ${error.message}` }], isError: true }
      throw error
    }
    const waits = tool.command === 'run wait'
    // `toArgv` has held a given timeout to a whole number from 1 to MCP_RUN_WAIT_MAX; a wait with none still ends.
    if (waits && !argv.includes('--timeout')) argv.push('--timeout', String(MCP_RUN_WAIT_DEFAULT))
    if (!argv.includes('--text')) argv.push('--json')
    if (options.home !== undefined) argv.push('--home', options.home)
    if (trace) argv.push('--trace-wire')

    const meta = params['_meta'] && typeof params['_meta'] === 'object' ? params['_meta'] as Record<string, unknown> : {}
    const token = meta['progressToken']
    const progressing = waits && (typeof token === 'string' || typeof token === 'number')
    const total = Number(argv[argv.indexOf('--timeout') + 1])
    let state: string | null = null, last = 0
    const begun = Date.now()
    const progress = (elapsedMs: number) => {
      if (signal.aborted) return
      const at = Math.max(elapsedMs / 1000, last + 0.001)
      last = at
      const run = String(input['run'] ?? '')
      send({ method: 'notifications/progress', params: { progressToken: token, progress: at, total, message: state ? `Run ${run} is ${state}` : `Waiting for run ${run}` } })
    }
    const ticker = progressing ? setInterval(() => progress(Date.now() - begun), MCP_PROGRESS_EVERY_MS) : undefined
    let out = ''
    // Kept as written: a failing command's own refusal is its last write, after any preview or warning.
    const err: string[] = []
    const io: CommandIo = {
      out: text => { out += text },
      err: text => { if (trace) process.stderr.write(text); else err.push(text) },
      interactive: false,
      signal,
      surface: 'mcp',
      peer,
      ...(progressing ? { onProgress: (seen: string, elapsedMs: number) => { if (seen !== state) { state = seen; progress(elapsedMs) } } } : {}),
    }
    let exit: number
    try { exit = await runCommand(argv, io) } finally { if (ticker) clearInterval(ticker) }
    if (signal.aborted || exit === 130 || exit === 143) return { content: [] }
    const parsed = parse(out)
    if (waits && Object.hasOwn(WAIT_ENDINGS, exit)) {
      const value = { ...(parsed ?? {}), exit, ended: WAIT_ENDINGS[exit]! }
      return structured(JSON.stringify(value), value)
    }
    if (exit !== 0) {
      // The refusal leads, so its code is the first thing read; what the command said before it follows.
      const said = err.at(-1)?.trim() || out.trim()
      const before = err.slice(0, -1).join('').trim()
      return { content: [{ type: 'text', text: `exit ${exit}: ${said}${before ? `\n\n${before}` : ''}` }], isError: true }
    }
    return parsed ? structured(out.trimEnd(), parsed) : { content: [{ type: 'text', text: out }] }
  }

  const structured = (text: string, value: Record<string, unknown>): Content =>
    STRUCTURED.has(version) ? { content: [{ type: 'text', text }], structuredContent: value } : { content: [{ type: 'text', text }] }

  const handle = async (message: Message): Promise<void> => {
    const { id, method } = message
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    switch (method) {
      case 'initialize': {
        version = negotiate(params['protocolVersion'])
        const info = params['clientInfo'] && typeof params['clientInfo'] === 'object' ? params['clientInfo'] as Record<string, unknown> : {}
        peer = { name: stated(info['name'], UNNAMED.name), version: stated(info['version'], UNNAMED.version) }
        respond(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'harnessdesk', version: '0.1.0' } })
        return
      }
      case 'notifications/initialized':
        return
      case 'notifications/cancelled': {
        const target = params['requestId']
        if (typeof target === 'string' || typeof target === 'number') inFlight.get(JSON.stringify(target))?.controller.abort()
        return
      }
      case 'ping':
        respond(id, {})
        return
      case 'tools/list':
        respond(id, { tools: [...tools.values()].map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })) })
        return
      case 'tools/call': {
        const key = JSON.stringify(id ?? null)
        const controller = new AbortController()
        let settle!: () => void
        const done = new Promise<void>(resolve => { settle = resolve })
        inFlight.set(key, { controller, done })
        try {
          const result = await call(id, params, controller.signal)
          if (controller.signal.aborted) return
          if (result === null) fail(id, -32602, `Unknown tool ${typeof params['name'] === 'string' ? params['name'] : ''}`.trimEnd())
          else respond(id, result)
        } finally { inFlight.delete(key); settle() }
        return
      }
      default:
        if (id !== undefined) fail(id, -32601, `Method not supported: ${method}`)
    }
  }

  const dispatch = (line: string) => {
    let message: Message
    try { message = JSON.parse(line) as Message } catch { return }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') return
    void handle(message).catch(error => { if (message.id !== undefined) fail(message.id, -32603, errorText(error)) })
  }

  await new Promise<void>(resolve => {
    let buffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      if (closing) return
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) dispatch(line)
      }
    })
    process.stdin.once('end', () => resolve())
    process.stdin.once('close', () => resolve())
  })
  closing = true
  // Standard input ended: the client is gone. Cancel what is running, and give it two seconds to close its connections.
  const running = [...inFlight.values()]
  for (const one of running) one.controller.abort()
  await Promise.race([Promise.all(running.map(one => one.done)), new Promise(resolve => setTimeout(resolve, 2_000).unref())])
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()))
  return 0
}

function parse(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const value = JSON.parse(trimmed) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}
