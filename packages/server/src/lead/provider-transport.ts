import { request as httpsRequest } from 'node:https'
import type { MessagesTransport } from '@harnessdesk/lead'

/** Host-only fixed Messages destination. Redirects are returned, never followed. */
export const leadProviderTransport: MessagesTransport = {
  send: request => new Promise((resolve, reject) => {
    const failed = () => new Error('lead-provider-failed')
    const outgoing = httpsRequest({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: request.headers,
      signal: request.signal, timeout: 30_000 }, response => {
      const chunks: Uint8Array[] = []; let bytes = 0
      response.on('data', (chunk: Uint8Array) => {
        bytes += chunk.length
        if (bytes > request.maxResponseBytes) { outgoing.destroy(failed()); return }
        chunks.push(chunk)
      })
      response.once('error', () => reject(failed()))
      response.once('end', () => {
        const status = response.statusCode ?? 0, retryAfter = response.headers['retry-after']
        resolve({ status, body: Buffer.concat(chunks).toString('utf8'), ...(typeof retryAfter === 'string' ? { retryAfter } : {}),
          ...(status === 429 || status === 529 ? { processing: 'not-started' as const } : {}) })
      })
    })
    outgoing.once('timeout', () => outgoing.destroy(failed()))
    outgoing.once('error', () => reject(failed()))
    outgoing.end(request.body)
  }),
}
