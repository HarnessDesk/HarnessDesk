import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Fetching pages from the web.
 *
 * The network permission is the one users are most right to be careful about, so
 * this plugin ships with an **empty** host allowlist. It does nothing until
 * somebody adds hosts in settings — a deliberate friction, because a plugin that
 * can reach any host is a plugin that can exfiltrate a repository.
 */

interface Config {
  readonly maxCharacters?: number
}

const DEFAULT_MAX = 40_000

/** The entities markup escapes text with, and the space. Decoded in one pass: `&amp;` first uncovered a `&lt;` that was then decoded too (#59). */
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' }

/**
 * HTML to readable text.
 *
 * Not a parser: script and style contents are removed first, then tags are
 * stripped and entities decoded. Handing a model raw markup wastes most of the
 * context window on attributes nobody reads.
 */
export const htmlToText = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // `&apos;` and `&#x27;` are the same quote as `&#39;`, spelled as HTML5 and in hex (#174).
    .replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/gi, (entity: string, name: string) => ENTITIES[name.toLowerCase()] ?? entity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const webPlugin: HarnessPlugin = {
  manifest: {
    id: 'web',
    name: 'Web',
    description: 'Fetch pages from hosts you allow. No hosts are allowed by default.',
    // Deliberately empty: this plugin is inert until the user grants a host.
    permissions: { network: { hosts: [] } },
    configSchema: {
      type: 'object',
      properties: {
        maxCharacters: { type: 'number', title: 'Maximum characters returned' },
      },
    },
  },
  plugin: {
    name: 'web',
    inject: ['tools', 'http'],
    apply(ctx: HarnessContext, config: Config) {
      const limit = Math.max(config?.maxCharacters ?? DEFAULT_MAX, 1_000)

      ctx.tools.register({
        name: 'fetch_url',
        description:
          'Fetch a URL and return its readable text. Only hosts allowed in this plugin’s permissions can be reached.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Absolute http(s) URL.' },
            raw: { type: 'boolean', description: 'Return the body unprocessed.' },
          },
          required: ['url'],
        },
        execute: async (args: { url: string; raw?: boolean }) => {
          const response = await ctx.http.fetch(args.url, { timeoutMs: 20_000 })
          if (response.status >= 400) {
            return `The server returned ${response.status}.`
          }
          const type = response.headers['content-type'] ?? ''
          const body =
            args.raw || !type.includes('html') ? response.body : htmlToText(response.body)
          return body.length > limit
            ? `${body.slice(0, limit)}\n\n[truncated at ${limit} characters]`
            : body
        },
      })
    },
  },
}
