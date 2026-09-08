import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

import {
  ValidationError,
  parseClientMessage,
  wireCodeOf,
  wireError,
  type HostMethodName,
  type HostToClient,
  type WireNotification,
  type WireResponse,
} from '@harnessdesk/protocol'
import { WebSocketServer, type WebSocket } from 'ws'

import type { Host } from './host.js'
import type { Logger } from './log.js'

/**
 * The loopback host server.
 *
 * Binds to 127.0.0.1 only and requires a token minted at launch. Both matter:
 * this process can spawn commands and read the filesystem on the user's behalf,
 * and any other local process could otherwise reach it.
 */

export interface ServeOptions {
  readonly host: Host
  readonly logger: Logger
  readonly port?: number
  /** Directory of built UI assets. Omit to run headless. */
  readonly uiRoot?: string | null
  /** Supply to pin the token, e.g. from the desktop shell. */
  readonly token?: string
}

export interface RunningServer {
  readonly url: string
  readonly port: number
  readonly token: string
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Constant-time comparison so a caller cannot recover the token by timing
 * repeated guesses.
 */
const tokenMatches = (expected: string, provided: string | null): boolean => {
  if (!provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export const serve = async (options: ServeOptions): Promise<RunningServer> => {
  const logger = options.logger.child('server')
  const token = options.token ?? randomBytes(32).toString('hex')
  const uiRoot = options.uiRoot ? resolve(options.uiRoot) : null

  const http = createServer((request, response) => {
    void handleHttp(request, response, { uiRoot, token, logger, host: options.host })
  })

  const sockets = new WebSocketServer({ noServer: true })

  http.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws' || !tokenMatches(token, url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      attach(ws, options.host, logger)
    })
  })

  const port = await new Promise<number>((resolvePort, reject) => {
    http.once('error', reject)
    // Loopback only. This is a security boundary, not a convenience default.
    http.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = http.address()
      if (address && typeof address === 'object') resolvePort(address.port)
      else reject(new Error('server did not bind to a port'))
    })
  })

  logger.info('listening', { port, ui: uiRoot ?? '(headless)' })

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    close: async () => {
      for (const client of sockets.clients) client.close(1001, 'host shutting down')
      await new Promise<void>((done) => sockets.close(() => done()))
      await new Promise<void>((done) => http.close(() => done()))
    },
  }
}

const attach = (socket: WebSocket, host: Host, logger: Logger): void => {
  const send = (message: HostToClient): void => {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  const detach = host.addBroadcaster((notification: WireNotification) => send(notification))

  // A client that reconnects mid-turn must be able to render immediately, and
  // must get back any approval that is still blocking the agent.
  send(host.syncPayload())
  // The editor plane is host state too: a plugin's marks were put on a file
  // before this window existed, and a window that only learned about them on
  // the next change would show the file bare until something moved.
  send(host.editorPlaneNotification())
  // The team plane replays the same way: a board was written before this
  // window existed, and a window that only learned on the next change would
  // show the tab empty until something moved.
  for (const replay of host.teamNotifications()) send(replay)
  for (const replay of host.pendingApprovalEvents()) send(replay)

  socket.on('message', (raw) => {
    void handleMessage(raw.toString(), host, send, logger)
  })

  socket.on('close', () => detach())
  socket.on('error', (error) => {
    logger.warn('socket error', { error: String(error) })
    detach()
  })
}

const handleMessage = async (
  raw: string,
  host: Host,
  send: (message: HostToClient) => void,
  logger: Logger,
): Promise<void> => {
  let parsed
  try {
    parsed = parseClientMessage(JSON.parse(raw))
  } catch (error) {
    // Without a valid id there is nobody to answer, so log and drop.
    logger.warn('rejected malformed client message', {
      error: error instanceof ValidationError ? error.message : String(error),
    })
    const id = idOf(raw)
    if (id !== null) {
      send({ id, ok: false, error: wireError('badRequest', describeError(error)) } as WireResponse)
    }
    return
  }

  try {
    const result = await host.call(parsed.method as HostMethodName, parsed.params as never)
    send({ id: parsed.id, ok: true, result })
  } catch (error) {
    const details = detailsOf(error)
    logger.warn('method failed', {
      method: parsed.method,
      error: String(error),
      ...(details ? { details } : {}),
    })
    send({
      id: parsed.id,
      ok: false,
      error: wireError(wireCodeOf(error) ?? 'methodFailed', describeError(error), details),
    } as WireResponse)
  }
}

const idOf = (raw: string): number | null => {
  try {
    const value = (JSON.parse(raw) as { id?: unknown }).id
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The half of a failure that says what happened, when the message only says
 * that something did. `AcpError` carries the agent's `error.data` here; it is
 * read structurally so the server keeps no dependency on the transport.
 */
const detailsOf = (error: unknown): string | null => {
  const details = error instanceof Error ? (error as { details?: unknown })['details'] : null
  return typeof details === 'string' && details.trim() ? details : null
}

const handleHttp = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: { uiRoot: string | null; token: string; logger: Logger; host: Host },
): Promise<void> => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')

  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  // Preview documents. The app's own CSP forbids inline scripts, and a
  // `srcdoc` iframe inherits it — which silently killed every previewed
  // page's <script>. So previews are real documents from this endpoint with
  // their own policy: inline is the point, the network is not — a previewed
  // file can run itself but cannot call out, and the single-use ticket it
  // was fetched with is spent before its scripts ever execute.
  if (url.pathname === '/preview-frame') {
    const ticket = url.searchParams.get('ticket') ?? ''
    const redeemed = await context.host.redeemPreviewTicket(ticket).catch(() => null)
    if (!redeemed) {
      response.writeHead(410, { 'content-type': 'text/plain' })
      response.end('This preview link has expired. Reload the preview pane.')
      return
    }
    response.writeHead(200, {
      'content-type': redeemed.contentType,
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'",
    })
    response.end(Buffer.from(redeemed.bytes))
    return
  }

  if (!context.uiRoot) {
    response.writeHead(404).end('No UI is bundled with this host.')
    return
  }

  // The bootstrap document is gated; the static assets it then requests are not,
  // because the browser does not carry the query parameter forward and the
  // alternatives (a cookie, or rewriting the asset graph) buy nothing. The token
  // guards the WebSocket, which is where every capability actually lives — the
  // assets are the same open-source bundle anyone can read from this repo.
  if (
    (url.pathname === '/' || url.pathname === '/index.html') &&
    !tokenMatches(context.token, url.searchParams.get('token'))
  ) {
    response.writeHead(401).end('Unauthorized')
    return
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname
  // Normalise before joining so `..` cannot escape the UI root.
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  const target = join(context.uiRoot, safe)
  if (!target.startsWith(context.uiRoot + sep) && target !== join(context.uiRoot, 'index.html')) {
    response.writeHead(403).end('Forbidden')
    return
  }

  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('not a file')
    response.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      // The renderer is a single-origin app with no external requests; the CSP
      // makes that a rule rather than a habit.
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    })
    createReadStream(target).pipe(response)
  } catch {
    // Unknown paths fall back to the app shell so client routing works.
    try {
      const shell = join(context.uiRoot, 'index.html')
      await stat(shell)
      response.writeHead(200, { 'content-type': MIME['.html'] as string, 'cache-control': 'no-store' })
      createReadStream(shell).pipe(response)
    } catch {
      response.writeHead(404).end('Not found')
    }
  }
}

export type { Server }
