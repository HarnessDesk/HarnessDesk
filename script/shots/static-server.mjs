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
import { lstat, readFile } from 'node:fs/promises'
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
 * Whether any component from `root` down to `path`, `path` itself included, is
 * a symlink.
 *
 * The prefix check below refuses a request that would *lexically* resolve
 * outside `root`, but a symlink inside `root` sidesteps that check entirely —
 * `root/link` starts with `root` no matter where `link` points, so a folder or
 * a file swapped for one would still be served, following it wherever it
 * leads (#928). Checked component by component rather than with a single
 * `realpath`, so the refusal names the one link actually in the way rather
 * than only noticing the destination differs.
 */
const hasSymlinkComponent = async (root, path) => {
  const relative = path.slice(root.length).split(sep).filter(Boolean)
  let at = root
  for (const segment of relative) {
    at = join(at, segment)
    let info
    try {
      info = await lstat(at)
    } catch {
      return false // a missing component is a 404, not a link to refuse
    }
    if (info.isSymbolicLink()) return true
  }
  return false
}

/**
 * Serves only files inside `root`. `request.url` is resolved against `root`
 * and refused the moment it would resolve outside it — a `..` segment or an
 * absolute-looking path included — so the one folder this rig hands out is
 * the only one a page loaded from it can ever ask for. A symlink anywhere
 * between `root` and the requested file is refused the same way, so nothing
 * this server hands a guest page ever came from outside the folder it was
 * given (#928).
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
          if (await hasSymlinkComponent(root, path)) {
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
