/**
 * A gateway tool result as MCP tool content.
 *
 * Apart from `main.ts`, which starts talking on stdio as soon as it's
 * imported, so that this can be tested (review of #187, round 2).
 */

export type GatewayResult =
  | { ok: true; content: ({ type: 'text'; text: string } | { type: 'image'; url: string; mimeType?: string })[] }
  | { ok: false; error: string }

/**
 * An image part becomes MCP image content, which carries bytes: the data URL's
 * payload, typed by the data URL's own header before any declared type,
 * because the header is what the bytes are. A linked image has no bytes to
 * carry, so it's named as a link: as image content the URL itself went out as
 * base64, which no model decodes (#51, review of #187, round 2).
 */
export const toMcpContent = (result: GatewayResult): { content: object[]; isError?: boolean } => {
  if (!result.ok) return { content: [{ type: 'text', text: result.error }], isError: true }
  const content = result.content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (!part.url.startsWith('data:')) return { type: 'text', text: `An image at ${part.url}` }
    return {
      type: 'image',
      data: part.url.slice(part.url.indexOf(',') + 1),
      mimeType: /^data:([^;,]+)/i.exec(part.url)?.[1]?.toLowerCase() ?? part.mimeType ?? 'image/png',
    }
  })
  return { content: content.length > 0 ? content : [{ type: 'text', text: '' }] }
}
