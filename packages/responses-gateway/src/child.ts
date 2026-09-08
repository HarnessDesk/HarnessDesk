import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createInterface } from 'node:readline'
import { URL } from 'node:url'

/**
 * The gateway process.
 *
 * One job: accept a backend's model traffic on loopback, swap the gateway
 * token for the provider's real key, forward, and stream the answer back.
 * It runs as its own process so the provider key exists in exactly one
 * address space — not the host's, not the backend's, not any plugin's.
 *
 * Configuration arrives as a single JSON line on stdin — never argv (visible
 * in `ps`), never the environment (inherited by children). The chosen port is
 * announced as a single JSON line on stdout.
 *
 * The token check is constant-shape: a request without the exact token gets a
 * 401 with no detail, because a loopback port is reachable by every local
 * process and this token is the only thing standing between them and spending
 * the user's provider budget.
 */

interface GatewayConfig {
  /** Upstream base, e.g. `https://api.example.com/v1`. */
  readonly upstream: string
  readonly apiKey: string
  /** The bearer this gateway requires from its caller. */
  readonly token: string
  /** When set, the `model` field of JSON request bodies is rewritten to this. */
  readonly model?: string
}

const readConfig = (): Promise<GatewayConfig> =>
  new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin })
    rl.once('line', (line) => {
      try {
        resolve(JSON.parse(line) as GatewayConfig)
      } catch (error) {
        reject(new Error(`unparseable gateway config: ${String(error)}`))
      }
    })
    rl.once('close', () => reject(new Error('stdin closed before configuration arrived')))
  })

const config = await readConfig()
const upstream = new URL(config.upstream)

const forward = (incoming: IncomingMessage, outgoing: ServerResponse, body: Buffer): void => {
  const target = new URL(
    // The backend calls `<base>/responses` etc.; splice its path onto the
    // upstream's, preserving whatever prefix the provider uses.
    `${upstream.pathname.replace(/\/$/, '')}${incoming.url ?? '/'}`,
    upstream,
  )
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value !== 'string') continue
    if (name === 'host' || name === 'authorization' || name === 'content-length') continue
    headers[name] = value
  }
  headers['authorization'] = `Bearer ${config.apiKey}`
  headers['host'] = upstream.host

  let payload = body
  if (config.model && (incoming.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>
      if (typeof parsed['model'] === 'string') {
        parsed['model'] = config.model
        payload = Buffer.from(JSON.stringify(parsed), 'utf8')
      }
    } catch {
      // Not JSON after all; forward untouched.
    }
  }
  headers['content-length'] = String(payload.byteLength)

  const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
  const proxied = requester(
    target,
    { method: incoming.method ?? 'POST', headers },
    (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(outgoing)
    },
  )
  proxied.on('error', (error) => {
    // The failure is the answer: the backend sees a clean upstream error and
    // fails its turn, rather than waiting on a socket that will never speak.
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({ error: { message: `gateway: ${error.message}` } }))
  })
  proxied.end(payload)
}

/**
 * The token is accepted two ways: `Authorization: Bearer <token>`, or a
 * `/t/<token>` URL prefix. The prefix exists because some backends configure
 * a keyless provider — auth then rides the base URL, which never appears in
 * `ps` output or any environment. Either way, no token, no upstream.
 */
const server = createServer((incoming, outgoing) => {
  const auth = incoming.headers.authorization ?? ''
  const prefix = `/t/${config.token}`
  const viaPath = (incoming.url ?? '').startsWith(`${prefix}/`)
  if (auth !== `Bearer ${config.token}` && !viaPath) {
    outgoing.writeHead(401, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({ error: { message: 'unauthorised' } }))
    return
  }
  if (viaPath) incoming.url = (incoming.url ?? '').slice(prefix.length)
  const chunks: Buffer[] = []
  incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
  incoming.on('end', () => forward(incoming, outgoing, Buffer.concat(chunks)))
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  process.stdout.write(`${JSON.stringify({ port })}\n`)
})

// The parent closing stdin is the shutdown signal.
process.stdin.on('close', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
})
process.stdin.resume()
