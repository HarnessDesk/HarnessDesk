import type { HarnessContext, HarnessPlugin, NetworkEntry, PointerTarget } from '@harnessdesk/cordis-host'

/**
 * A browser the agent can drive, as tools every agent can call.
 *
 * The engine is `ctx.browser` — a real Chromium under CDP, in the pane, a
 * window, or handed to the system browser according to the user's setting.
 * This plugin is only the tool surface, the same division the iOS Simulator
 * tools keep.
 *
 * Interaction tools return a fresh screenshot, because after acting the next
 * thing an agent does is look, and a separate "now screenshot it" round trip
 * is a turn spent saying nothing. Coordinates are the screenshot's own pixels,
 * so what a model measures on the image is what it can click.
 *
 * **Two ways to aim, and the second is better.** A screenshot plus pixels is
 * how a model looks at a page a person designed. `browser_read_page` hands
 * back the same page as named parts with `ref_3` handles, and every pointer
 * tool takes one — no measuring, no Retina arithmetic, and a click that
 * fails says *which* element went missing. Pixels remain for the cases refs
 * cannot express: a canvas, a map, a game.
 *
 * **Reading a page as *text*** is `browser_read_page` with `format: "text"`.
 * That is not the same as `web`'s `fetch_url`, which reaches arbitrary hosts
 * behind its own allowlist; this reads the page already open in front of the
 * person. This plugin asks for one permission — `browser` — and no network
 * at all.
 */

/** How a console entry reads in a tool result. */
const consoleLine = (entry: { level: string; text: string; url?: string; line?: number }): string =>
  `[${entry.level}] ${entry.text}${entry.url ? ` (${entry.url}${entry.line ? `:${entry.line}` : ''})` : ''}`

/** How a request reads: verb, outcome, size, url, and the id that fetches its body. */
const networkLine = (entry: {
  requestId: string
  method: string
  url: string
  status?: number
  mimeType?: string
  bytes?: number
  error?: string
}): string => {
  // A request can fail *after* answering — a stylesheet that came back 404
  // and was then abandoned by the page — and the status is the half an agent
  // can act on.
  const outcome = entry.error
    ? `FAILED ${entry.error}${entry.status !== undefined ? ` (after ${entry.status})` : ''}`
    : (entry.status?.toString() ?? 'pending')
  const size = entry.bytes ? ` ${(entry.bytes / 1024).toFixed(1)}kB` : ''
  return `${entry.method} ${outcome} ${entry.mimeType ?? ''}${size} ${entry.url}  #${entry.requestId}`
}

export const browserPlugin: HarnessPlugin = {
  manifest: {
    id: 'browser',
    name: 'Browser',
    description:
      'Open, see, click and type in a real browser — read its page, console and network, and drive it in the DevTools protocol.',
    permissions: { browser: true },
  },
  plugin: {
    name: 'browser',
    inject: ['tools', 'context', 'browser'],
    apply(ctx: HarnessContext) {
      // "Why does it look like this" starts with the page in front of the
      // person; the chip carries it as an image where the agent takes one,
      // and as the title and URL alone where it cannot.
      ctx.context.register({
        label: 'Current page screenshot',
        form: 'resource',
        chip: { description: 'What the browser shows right now, as an image.' },
        resolve: async () => {
          const shot = await ctx.browser.screenshot()
          const page = await ctx.browser.page()
          return {
            text: `The browser is on ${page.title || '(untitled)'} — ${page.url}.`,
            image: { dataUrl: shot, name: page.title || 'Current page' },
          }
        },
      })

      const look = async (note: string) => {
        const shot = await ctx.browser.screenshot()
        const page = await ctx.browser.page()
        return [
          {
            type: 'text' as const,
            text: `${note ? `${note} — ` : ''}${page.title || '(untitled)'} — ${page.url}`,
          },
          { type: 'image' as const, url: shot, mimeType: 'image/png' },
        ]
      }

      /** Every pointer tool takes the same two ways of saying where. */
      const target = (args: { ref?: string; x?: number; y?: number }): PointerTarget => {
        if (args.ref) return { ref: String(args.ref) }
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          return { x: Number(args.x), y: Number(args.y) }
        }
        throw new Error('Say where: either a ref from browser_read_page, or x and y in screenshot pixels.')
      }

      const MODIFIERS = {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Held while acting: Alt, Ctrl, Meta or Shift.',
      }

      ctx.tools.register({
        name: 'browser_open',
        description:
          'Open a URL in the browser and return a screenshot. A screenshot\'s pixels are the coordinates a click takes.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s):// or file:// address to open.' },
          },
          required: ['url'],
        },
        execute: async (args: { url: string }) => {
          const page = await ctx.browser.open(String(args.url))
          // Handed to the default browser: the setting says so, and looking
          // would be refused by that same setting a call later.
          if (page.handedOff) {
            return [
              {
                type: 'text' as const,
                text:
                  `Opened ${page.url} in the default browser. HarnessDesk cannot see into or click a page there — ` +
                  'that is Settings → Browser → Pages open; choose “In HarnessDesk” or “In a separate window” for screenshots and clicks.',
              },
            ]
          }
          return look('Opened')
        },
      })

      ctx.tools.register({
        name: 'browser_screenshot',
        description:
          'Screenshot the browser as it is right now — the viewport, the whole scrollable page, or one element.',
        inputSchema: {
          type: 'object',
          properties: {
            fullPage: { type: 'boolean', description: 'The whole document rather than the viewport.' },
            ref: { type: 'string', description: 'Just this element, from browser_read_page.' },
          },
        },
        execute: async (args: { fullPage?: boolean; ref?: string }) => {
          const shot = await ctx.browser.screenshot({
            ...(args.fullPage ? { fullPage: true } : {}),
            ...(args.ref ? { ref: String(args.ref) } : {}),
          })
          const page = await ctx.browser.page()
          return [
            { type: 'text' as const, text: `${page.title || '(untitled)'} — ${page.url}` },
            { type: 'image' as const, url: shot, mimeType: 'image/png' },
          ]
        },
      })

      ctx.tools.register({
        name: 'browser_read_page',
        description:
          'What is on the page: an accessibility outline whose interactive parts carry ref_N handles the other tools take, or the page as plain text. Prefer this over measuring a screenshot. ' +
          'A password or one-time-code field reads as "secret filled" or "secret empty" rather than carrying its value — that is deliberate and not a gap to work around; you can still fill one with browser_fill.',
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['tree', 'text'],
              description: 'tree (default): named parts with refs. text: what a person reads.',
            },
            query: { type: 'string', description: 'Keep only lines containing this.' },
            filter: {
              type: 'string',
              enum: ['interactive', 'all'],
              description: 'interactive (default) or every named element.',
            },
            maxChars: { type: 'number', description: 'Cap the output (default 20000).' },
          },
        },
        execute: (args: { format?: 'tree' | 'text'; query?: string; filter?: 'interactive' | 'all'; maxChars?: number }) =>
          ctx.browser.readPage({
            ...(args.format ? { format: args.format } : {}),
            ...(args.query ? { query: String(args.query) } : {}),
            ...(args.filter ? { filter: args.filter } : {}),
            ...(args.maxChars ? { maxChars: Number(args.maxChars) } : {}),
          }),
      })

      ctx.tools.register({
        name: 'browser_click',
        description:
          'Click an element by its ref, or at screenshot pixels (origin top-left). Returns a fresh screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'A ref_N from browser_read_page. Preferred.' },
            x: { type: 'number', description: 'Pixels from the left edge of the screenshot.' },
            y: { type: 'number', description: 'Pixels from the top edge of the screenshot.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            count: { type: 'number', description: '2 for a double click, 3 for a triple.' },
            modifiers: MODIFIERS,
          },
        },
        execute: async (args: {
          ref?: string
          x?: number
          y?: number
          button?: 'left' | 'right' | 'middle'
          count?: number
          modifiers?: string[]
        }) => {
          const where = target(args)
          const options = {
            ...(args.button ? { button: args.button } : {}),
            ...(args.count ? { count: Number(args.count) } : {}),
            ...(args.modifiers ? { modifiers: args.modifiers } : {}),
          }
          if ('ref' in where) await ctx.browser.clickRef(where.ref, options)
          else await ctx.browser.click(where.x, where.y, options)
          return look(`Clicked ${'ref' in where ? where.ref : `(${where.x}, ${where.y})`}`)
        },
      })

      ctx.tools.register({
        name: 'browser_pointer',
        description:
          'Pointer gestures beyond a click: hover to open a menu, scroll a list, or drag one place to another.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['hover', 'scroll', 'drag'], description: 'Which gesture.' },
            ref: { type: 'string', description: 'Where to act, from browser_read_page.' },
            x: { type: 'number', description: 'Or screenshot pixels from the left.' },
            y: { type: 'number', description: 'Or screenshot pixels from the top.' },
            toRef: { type: 'string', description: 'drag: where to release.' },
            toX: { type: 'number', description: 'drag: where to release, in screenshot pixels.' },
            toY: { type: 'number', description: 'drag: where to release, in screenshot pixels.' },
            deltaY: { type: 'number', description: 'scroll: pixels down, negative for up. Default 400.' },
            deltaX: { type: 'number', description: 'scroll: pixels right, negative for left.' },
          },
          required: ['action'],
        },
        execute: async (args: {
          action: 'hover' | 'scroll' | 'drag'
          ref?: string
          x?: number
          y?: number
          toRef?: string
          toX?: number
          toY?: number
          deltaX?: number
          deltaY?: number
        }) => {
          switch (args.action) {
            case 'hover':
              await ctx.browser.hover(target(args))
              return look('Hovered')
            case 'scroll': {
              const at = args.ref || typeof args.x === 'number' ? target(args) : undefined
              await ctx.browser.scroll(Number(args.deltaX) || 0, Number(args.deltaY ?? 400), at)
              return look('Scrolled')
            }
            case 'drag': {
              const to = target({
                ...(args.toRef ? { ref: args.toRef } : {}),
                ...(typeof args.toX === 'number' ? { x: args.toX } : {}),
                ...(typeof args.toY === 'number' ? { y: args.toY } : {}),
              })
              await ctx.browser.drag(target(args), to)
              return look('Dragged')
            }
            default:
              throw new Error(`Unknown pointer action ${JSON.stringify(String(args.action))}.`)
          }
        },
      })

      ctx.tools.register({
        name: 'browser_key',
        description:
          'Press a key, optionally several times and with modifiers held — use Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp, PageDown, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, space, or a single character. Returns a fresh screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to press.' },
            count: { type: 'number', description: 'How many times (default 1).' },
            modifiers: MODIFIERS,
          },
          required: ['key'],
        },
        execute: async (args: { key: string; count?: number; modifiers?: string[] }) => {
          const key = String(args.key)
          await ctx.browser.key(key, Number(args.count) || 1, args.modifiers ?? [])
          return look(`Pressed ${(args.modifiers ?? []).concat(key).join('+')}`)
        },
      })

      ctx.tools.register({
        name: 'browser_type',
        description:
          'Type a whole string, optionally into a field named by its ref first, and optionally press Enter after. For a select, a checkbox, or replacing an existing value, use browser_fill.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to type.' },
            ref: { type: 'string', description: 'Focus this field first, from browser_read_page.' },
            submit: { type: 'boolean', description: 'Press Enter afterwards.' },
          },
          required: ['text'],
        },
        execute: async (args: { text: string; ref?: string; submit?: boolean }) => {
          await ctx.browser.type(String(args.text), {
            ...(args.ref ? { ref: String(args.ref) } : {}),
            ...(args.submit ? { submit: true } : {}),
          })
          return look('Typed')
        },
      })

      ctx.tools.register({
        name: 'browser_fill',
        description:
          'Set a form control to a value — text field, textarea, select (by value or label), or checkbox (true/false). Fires the events a framework listens for, so a React form really does hold the value.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The control, from browser_read_page.' },
            value: {
              type: ['string', 'boolean'],
              description: 'The value, or true/false for a checkbox.',
            },
          },
          required: ['ref', 'value'],
        },
        execute: async (args: { ref: string; value: string | boolean }) => {
          const result = await ctx.browser.fill(String(args.ref), args.value)
          return look(`Filled ${args.ref} — ${JSON.stringify(result)}`)
        },
      })

      ctx.tools.register({
        name: 'browser_page',
        description:
          'The page itself: go back or forward, reload, wait for something to appear, emulate a device or colour scheme, print to PDF, or hand files to a file input.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['back', 'forward', 'reload', 'wait', 'emulate', 'pdf', 'upload'],
              description: 'What to do.',
            },
            selector: { type: 'string', description: 'wait: a CSS selector that must appear.' },
            text: { type: 'string', description: 'wait: text that must appear on the page.' },
            gone: { type: 'string', description: 'wait: a CSS selector that must disappear.' },
            timeoutMs: { type: 'number', description: 'wait: how long to allow (default 10000).' },
            width: { type: 'number', description: 'emulate: viewport width.' },
            height: { type: 'number', description: 'emulate: viewport height.' },
            mobile: { type: 'boolean', description: 'emulate: a phone rather than a desktop.' },
            userAgent: { type: 'string', description: 'emulate: override the user agent.' },
            colorScheme: { type: 'string', enum: ['light', 'dark'], description: 'emulate: prefers-color-scheme.' },
            offline: { type: 'boolean', description: 'emulate: pretend the network is gone.' },
            reset: { type: 'boolean', description: 'emulate: drop every override.' },
            ref: { type: 'string', description: 'upload: the file input, from browser_read_page.' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'upload: absolute paths to hand it.',
            },
          },
          required: ['action'],
        },
        execute: async (args: Record<string, unknown>) => {
          const action = String(args['action'])
          switch (action) {
            case 'back':
            case 'forward':
            case 'reload':
              await ctx.browser.history(action)
              return look(action === 'reload' ? 'Reloaded' : `Went ${action}`)
            case 'wait': {
              const reached = await ctx.browser.waitFor({
                ...(args['selector'] ? { selector: String(args['selector']) } : {}),
                ...(args['text'] ? { text: String(args['text']) } : {}),
                ...(args['gone'] ? { gone: String(args['gone']) } : {}),
                ...(args['timeoutMs'] ? { timeoutMs: Number(args['timeoutMs']) } : {}),
              })
              // A timeout is not an error: "it never appeared" is an answer,
              // and the screenshot beside it is the evidence.
              return look(reached ? 'Appeared' : 'Timed out waiting; the page is as shown')
            }
            case 'emulate':
              await ctx.browser.emulate({
                ...(args['width'] ? { width: Number(args['width']) } : {}),
                ...(args['height'] ? { height: Number(args['height']) } : {}),
                ...(args['mobile'] !== undefined ? { mobile: Boolean(args['mobile']) } : {}),
                ...(args['userAgent'] ? { userAgent: String(args['userAgent']) } : {}),
                ...(args['colorScheme'] ? { colorScheme: args['colorScheme'] as 'light' | 'dark' } : {}),
                ...(args['offline'] !== undefined ? { offline: Boolean(args['offline']) } : {}),
                ...(args['reset'] ? { reset: true } : {}),
              })
              return look('Emulating')
            case 'pdf': {
              const pdf = await ctx.browser.pdf()
              const page = await ctx.browser.page()
              return [
                { type: 'text' as const, text: `${page.title || '(untitled)'} as PDF` },
                { type: 'image' as const, url: pdf, mimeType: 'application/pdf' },
              ]
            }
            case 'upload': {
              const files = Array.isArray(args['files']) ? (args['files'] as string[]).map(String) : []
              if (!args['ref'] || files.length === 0) throw new Error('upload needs a ref and at least one file path.')
              await ctx.browser.upload(String(args['ref']), files)
              return look(`Handed ${files.length} file(s) to ${String(args['ref'])}`)
            }
            default:
              throw new Error(`Unknown page action ${JSON.stringify(action)}.`)
          }
        },
      })

      ctx.tools.register({
        name: 'browser_console',
        description:
          'What the page has logged since it was opened — console calls, uncaught exceptions, and the browser\'s own complaints (a blocked load, a CSP refusal).',
        inputSchema: {
          type: 'object',
          properties: {
            onlyErrors: { type: 'boolean', description: 'Errors and warnings only.' },
            pattern: { type: 'string', description: 'Keep only entries containing this.' },
            limit: { type: 'number', description: 'The most recent N (default 100).' },
          },
        },
        execute: async (args: { onlyErrors?: boolean; pattern?: string; limit?: number }) => {
          const entries = await ctx.browser.console({
            ...(args.onlyErrors ? { onlyErrors: true } : {}),
            ...(args.pattern ? { pattern: String(args.pattern) } : {}),
            ...(args.limit ? { limit: Number(args.limit) } : {}),
          })
          if (entries.length === 0) return 'The console is empty.'
          return entries.map(consoleLine).join('\n')
        },
      })

      ctx.tools.register({
        name: 'browser_network',
        description:
          'What the page asked the network for since it was opened, one line per request. Pass a requestId to read that response\'s body in full.',
        inputSchema: {
          type: 'object',
          properties: {
            urlPattern: { type: 'string', description: 'Keep only requests whose URL contains this.' },
            requestId: { type: 'string', description: 'Read this response body (the #id in a listing).' },
            limit: { type: 'number', description: 'The most recent N (default 100).' },
          },
        },
        execute: async (args: { urlPattern?: string; requestId?: string; limit?: number }) => {
          const result = await ctx.browser.network({
            ...(args.urlPattern ? { urlPattern: String(args.urlPattern) } : {}),
            ...(args.requestId ? { requestId: String(args.requestId) } : {}),
            ...(args.limit ? { limit: Number(args.limit) } : {}),
          })
          if (!Array.isArray(result)) {
            const single = result as { body: string; base64: boolean }
            return single.base64 ? '(a binary body, not shown)' : single.body
          }
          const rows = result as readonly NetworkEntry[]
          if (rows.length === 0) return 'The page has made no requests since it was opened.'
          return rows.map(networkLine).join('\n')
        },
      })

      ctx.tools.register({
        name: 'browser_evaluate',
        description:
          'Evaluate a JavaScript expression in the page and return its JSON value — for state a screenshot cannot show, like a score variable. ' +
          'Its result is returned unredacted, so an expression that reads a password or card field puts that value in the transcript: this tool does what you ask it, and what you ask for is on you.',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'The expression to evaluate.' },
          },
          required: ['expression'],
        },
        execute: async (args: { expression: string }) =>
          JSON.stringify(await ctx.browser.evaluate(String(args.expression))),
      })

      ctx.tools.register({
        name: 'browser_cdp',
        description:
          'Send any Chrome DevTools Protocol command to the page and return its result — Accessibility, DOM, Storage, Performance, Debugger, anything the other tools do not model. With events: true, read the raw event stream instead. ' +
          'Results come back as the protocol gives them, with none of the redaction browser_read_page applies — Accessibility.getFullAXTree and DOM.getOuterHTML both carry secret field values.',
        inputSchema: {
          type: 'object',
          properties: {
            method: { type: 'string', description: 'A CDP method, e.g. Accessibility.getFullAXTree.' },
            params: { type: 'object', description: 'Its parameters.' },
            events: { type: 'boolean', description: 'Read buffered events rather than sending a command.' },
            eventMethod: { type: 'string', description: 'events: a domain (Network) or one method name.' },
            limit: { type: 'number', description: 'events: the most recent N (default 200).' },
          },
        },
        execute: async (args: {
          method?: string
          params?: Record<string, unknown>
          events?: boolean
          eventMethod?: string
          limit?: number
        }) => {
          if (args.events) {
            const events = await ctx.browser.events({
              ...(args.eventMethod ? { method: String(args.eventMethod) } : {}),
              ...(args.limit ? { limit: Number(args.limit) } : {}),
            })
            if (events.length === 0) return 'No events have been delivered since the last read.'
            return events.map((event) => `${event.method} ${JSON.stringify(event.params)}`).join('\n')
          }
          if (!args.method) throw new Error('Name a CDP method, or pass events: true.')
          return JSON.stringify(await ctx.browser.cdp(String(args.method), args.params ?? {}), null, 2)
        },
      })

      ctx.tools.register({
        name: 'browser_close',
        description: 'Close the browser and end its profile session.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          await ctx.browser.close()
          return 'Closed.'
        },
      })
    },
  },
}
