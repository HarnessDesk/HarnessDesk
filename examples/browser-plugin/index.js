/**
 * A reader for the agent — and a test of HarnessDesk's plugin developer
 * experience, written against docs/extending.md as a third-party author would.
 *
 * Three tools (fetch a page as text, list its links, search inside it), two
 * slash commands, and a reading-history panel. All network goes through
 * ctx.http, which enforces the manifest's host list; the panel is data in the
 * hd.panel vocabulary, so no code from this file ever runs in the window.
 *
 * Driving a real browser — open, screenshot, click, type — is a built-in
 * plugin (`packages/plugins/src/browser.ts`) and deliberately not here: an
 * example that ships a second copy of a shipped feature teaches the wrong
 * thing, and gives an agent two tools with one name.
 */

/** Minimal HTML → readable text. Deliberately dumb; readability is the agent's job. */
const htmlToText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()

const titleOf = (html, url) => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return match ? htmlToText(match[1]).slice(0, 120) : url
}

const linksOf = (html, base) => {
  const links = []
  const seen = new Set()
  const pattern = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = pattern.exec(html)) !== null && links.length < 50) {
    let href = match[1]
    try {
      href = new URL(href, base).toString()
    } catch {
      continue
    }
    if (!href.startsWith('http') || seen.has(href)) continue
    seen.add(href)
    const label = htmlToText(match[2]).slice(0, 80) || href
    links.push({ href, label })
  }
  return links
}

export const plugin = {
  name: 'browser-example',
  inject: ['tools', 'http', 'commands', 'ui', 'harness'],
  apply(ctx, config) {
    const snippetLength = Math.max(500, Number(config?.snippetLength) || 4000)

    /** The pages read this session, newest first. */
    let history = []
    let lastPage = null

    let disposePanel = null
    const showPanel = () => {
      disposePanel?.()
      disposePanel = null
      if (history.length === 0) return
      disposePanel = ctx.ui.register({
        slot: 'sidebar.panel',
        label: 'Reading history',
        component: 'hd.panel',
        data: {
          title: `Web history · ${history.length} page${history.length === 1 ? '' : 's'}`,
          blocks: [
            {
              type: 'list',
              items: history.slice(0, 8).map((entry) => ({
                label: entry.title,
                hint: new URL(entry.url).host,
              })),
            },
            { type: 'actions', actions: [{ label: 'Clear history', command: 'browser-clear' }] },
          ],
        },
      })
    }

    const visit = async (url) => {
      const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
      const response = await ctx.http.fetch(target, { timeoutMs: 20_000 })
      const html = response.body
      const page = {
        url: target,
        status: response.status,
        title: titleOf(html, target),
        text: htmlToText(html),
        links: linksOf(html, target),
      }
      lastPage = page
      history = [{ url: page.url, title: page.title, at: Date.now() }, ...history].slice(0, 50)
      showPanel()
      return page
    }

    ctx.tools.register({
      name: 'browse_page',
      description:
        'Fetch a web page and return it as readable text, with its title. Follow-up calls to page_links and find_in_page refer to the page most recently browsed.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The address to read.' } },
        required: ['url'],
      },
      execute: async (args) => {
        const page = await visit(String(args.url))
        const clipped = page.text.length > snippetLength
        return [
          `# ${page.title}`,
          `${page.url} — HTTP ${page.status}${clipped ? ` — showing ${snippetLength} of ${page.text.length} characters` : ''}`,
          '',
          page.text.slice(0, snippetLength),
        ].join('\n')
      },
    })

    ctx.tools.register({
      name: 'page_links',
      description: 'List the links on the page most recently browsed with browse_page.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        if (!lastPage) return 'No page has been browsed yet. Call browse_page first.'
        if (lastPage.links.length === 0) return `${lastPage.title} has no links.`
        return lastPage.links.map((link) => `- ${link.label}\n  ${link.href}`).join('\n')
      },
    })

    ctx.tools.register({
      name: 'find_in_page',
      description: 'Search the most recently browsed page for a phrase; returns surrounding text.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: (args) => {
        if (!lastPage) return 'No page has been browsed yet. Call browse_page first.'
        const query = String(args.query)
        const haystack = lastPage.text.toLowerCase()
        const index = haystack.indexOf(query.toLowerCase())
        if (index === -1) return `“${query}” does not appear in ${lastPage.title}.`
        const start = Math.max(0, index - 200)
        return `…${lastPage.text.slice(start, index + query.length + 200)}…`
      },
    })

    ctx.commands.register({
      name: 'browse',
      description: 'Open a page in the browser plugin and add it to the reading history',
      argumentHint: '<url>',
      run: async (argument) => {
        const url = String(argument ?? '').trim()
        if (!url) return
        await visit(url)
      },
    })

    ctx.commands.register({
      name: 'browser-clear',
      description: 'Clear the browser reading history',
      run: () => {
        history = []
        lastPage = null
        showPanel()
      },
    })
  },
}
