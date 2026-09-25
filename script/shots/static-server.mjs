/**
 * A static file server for exactly one purpose: giving the `browser` scene a
 * page to open that reads like a real local dev server, not a filesystem
 * path.
 *
 * A `file://` URL always carries this machine's directory layout — the real
 * home before this rig kept its own, an OS temp path after — and the address
 * bar is a React-controlled input that writes its "real" value back mid-take
 * (`audit.mjs`'s own doc comment), so hiding a `file://` path with a DOM
 * substitution (`TILDIFY`) cannot be trusted to stick through a screenshot.
 * `http://127.0.0.1:<port>/…` never carries a filesystem path at all, so
 * there is nothing left for that race to leak.
 *
 * `127.0.0.1` and an ephemeral port (`listen(0, …)`), the same pair
 * `packages/server/test/accounts.test.ts` uses for a throwaway upstream:
 * loopback only, and a port nothing else on the machine is holding.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves only files inside `root`. `request.url` is resolved against `root`
 * and refused the moment it would resolve outside it — a `..` segment or an
 * absolute-looking path included — so the one folder this rig hands out is
 * the only one a page loaded from it can ever ask for.
 */
export const startStaticServer = (root) =>
  new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
          const path = join(root, relative)
          if (path !== root && !path.startsWith(root + sep)) {
            response.writeHead(403).end()
            return
          }
          const body = await readFile(path)
          response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
          response.end(body)
        } catch {
          response.writeHead(404).end('not found')
        }
      })()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
