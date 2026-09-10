import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ExtensionKernel,
  setBrowserEngine,
  setBrowserSettings,
  type BrowserEngine,
  type HarnessPlugin,
} from '../src/index.js'
import { KEY_NAMES, characterKey, namedKey, unknownKeyMessage } from '../src/browser.js'

/**
 * The browser service against an engine that is not Chrome. What the
 * service says over the DevTools protocol is the contract every engine —
 * Chrome, the desktop pane — answers; this pins it without a browser.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60))

const recordingEngine = () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const engine: BrowserEngine = {
    async ensure() {
      return {
        async send(method, params) {
          calls.push({ method, ...(params ? { params } : {}) })
          if (method === 'Runtime.evaluate') {
            const expression = String(params?.['expression'] ?? '')
            // A Retina page: the screenshot is twice the size of the
            // coordinate space a click is dispatched in.
            if (expression === 'window.devicePixelRatio') return { result: { value: 2 } }
            return expression.startsWith('JSON.stringify')
              ? { result: { value: JSON.stringify({ url: 'http://x/', title: 'X' }) } }
              : expression === 'boom'
                ? { exceptionDetails: { text: 'it threw' } }
                : { result: { value: 42 } }
          }
          if (method === 'Page.captureScreenshot') return { data: 'AAAA' }
          return {}
        },
      }
    },
    async close() {
      calls.push({ method: '<close>' })
    },
  }
  return { engine, calls }
}

const driver: HarnessPlugin = {
  manifest: { id: 'driver', name: 'Driver', permissions: { browser: true } },
  plugin: {
    name: 'driver',
    inject: ['tools', 'browser'],
    apply(ctx: any) {
      ctx.tools.register({
        name: 'drive',
        description: 'Runs the whole surface once.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const page = await ctx.browser.open('http://x/')
          await ctx.browser.click(3, 4)
          await ctx.browser.key('Enter')
          await ctx.browser.key('a')
          const shot = await ctx.browser.screenshot()
          const value = await ctx.browser.evaluate('6 * 7')
          let threw = ''
          try {
            await ctx.browser.evaluate('boom')
          } catch (error) {
            threw = error instanceof Error ? error.message : String(error)
          }
          await ctx.browser.close()
          return JSON.stringify({ page, shot, value, threw })
        },
      })
    },
  },
}

test('the browser service speaks DevTools Protocol to whatever engine is installed', async (t) => {
  const { engine, calls } = recordingEngine()
  setBrowserEngine(engine)
  t.after(() => setBrowserEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(driver)
  await settle()

  const tool = kernel.list('tool').find((entry) => entry.name === 'drive')!
  const result = await kernel.invokeTool(tool.id, {}, {})
  assert.equal(result.ok, true, JSON.stringify(result))
  const text = result.ok ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('') : ''
  const parsed = JSON.parse(text) as { page: unknown; shot: string; value: number; threw: string }
  assert.deepEqual(parsed.page, { url: 'http://x/', title: 'X' })
  assert.equal(parsed.shot, 'data:image/png;base64,AAAA')
  assert.equal(parsed.value, 42)
  assert.equal(parsed.threw, 'it threw')

  const methods = calls.map((call) => call.method)
  assert.deepEqual(methods.slice(0, 6), [
    'Page.navigate',
    'Runtime.evaluate',
    // The second read is the page's device pixel ratio, asked before every
    // click so the pixels a model measured become the pixels CDP wants.
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
  ])
  assert.deepEqual(calls[0]?.params, { url: 'http://x/' })

  // Clicked at (3, 4) of a screenshot from a 2× page: half that in CSS px.
  const pressed = calls.find(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mousePressed',
  )
  assert.equal(pressed?.params?.['x'], 1.5)
  assert.equal(pressed?.params?.['y'], 2)
  assert.ok(methods.includes('Input.dispatchKeyEvent'), 'Enter is a key event')
  assert.ok(methods.includes('Input.insertText'), 'a character is inserted as text')
  assert.equal(methods[methods.length - 1], '<close>')
})

test('without the browser permission the service refuses before reaching any engine', async (t) => {
  const { engine, calls } = recordingEngine()
  setBrowserEngine(engine)
  t.after(() => setBrowserEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({
    ...driver,
    manifest: { id: 'nope', name: 'No permission', permissions: {} },
    plugin: { ...driver.plugin, name: 'nope' },
  })
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'drive')!
  const result = await kernel.invokeTool(tool.id, {}, {})
  assert.equal(result.ok, false)
  assert.deepEqual(calls, [])
})

/**
 * Where pages open is the user's answer, and the service has to honour it
 * even though the engine that can drive a pane is installed either way.
 * The desktop shell always hands over its pane; choosing "a separate
 * window" or "my default browser" in settings must then take the pane out
 * of the path, or the setting is decoration.
 *
 * Neither of the other two placements may be *exercised* here — one starts
 * a real Chrome and the other opens the machine's default browser, and a
 * test suite that puts windows on someone's screen is a test suite people
 * stop running. So each is pointed at something that fails immediately, and
 * what is asserted is that it failed over *there*, having never touched the
 * pane.
 */

/** The one tool each placement test drives, so the surface is identical. */
const looker: HarnessPlugin = {
  manifest: { id: 'looker', name: 'Looker', permissions: { browser: true } },
  plugin: {
    name: 'looker',
    inject: ['tools', 'browser'],
    apply(ctx: any) {
      ctx.tools.register({
        name: 'look',
        description: 'Screenshots the page.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => ctx.browser.screenshot(),
      })
    },
  },
}

const lookWith = async (
  t: { after: (fn: () => unknown) => void },
  placement: 'pane' | 'window' | 'system',
) => {
  const { engine, calls } = recordingEngine()
  setBrowserEngine(engine)
  // A path that is not a browser, so "a separate window" fails at the
  // launch rather than putting one on the screen.
  setBrowserSettings({ placement, binary: '/nonexistent/Not A Browser' })
  t.after(() => {
    setBrowserEngine(null)
    setBrowserSettings({ placement: 'pane', binary: undefined })
  })
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(looker)
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'look')!
  const result = await kernel.invokeTool(tool.id, {}, {})
  return { result, calls, said: result.ok ? '' : result.error }
}

/**
 * Headed Chromium has no `Page.printToPDF`. The desktop pane answers it
 * itself; a separate window cannot, and what reaches the agent has to name
 * the setting rather than quote Chromium's "wasn't found".
 */
test('a PDF a browser cannot print is refused in words that name the setting', async (t) => {
  const engine: BrowserEngine = {
    async ensure() {
      return {
        async send(method) {
          if (method === 'Page.printToPDF') throw new Error("'Page.printToPDF' wasn't found")
          return {}
        },
      }
    },
    async close() {},
  }
  setBrowserEngine(engine)
  t.after(() => setBrowserEngine(null))
  const printer: HarnessPlugin = {
    manifest: { id: 'printer', name: 'Printer', permissions: { browser: true } },
    plugin: {
      name: 'printer',
      inject: ['tools', 'browser'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'print',
          description: 'Prints the page.',
          inputSchema: { type: 'object', properties: {} },
          execute: () => ctx.browser.pdf(),
        })
      },
    },
  }
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(printer)
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'print')!
  const result = await kernel.invokeTool(tool.id, {}, {})
  assert.equal(result.ok, false)
  const said = result.ok ? '' : result.error
  assert.match(said, /cannot print to PDF/)
  assert.match(said, /Settings → Browser → Pages open/, 'names the row as the settings page draws it')
  assert.doesNotMatch(said, /wasn't found/)
})

test('the pane is driven when the setting says pages open in HarnessDesk', async (t) => {
  const { result, calls } = await lookWith(t, 'pane')
  assert.equal(result.ok, true)
  assert.equal(calls[0]?.method, 'Page.captureScreenshot')
})

test('a separate window takes the pane out of the path, even though it is installed', async (t) => {
  const { result, calls, said } = await lookWith(t, 'window')
  assert.equal(result.ok, false)
  assert.deepEqual(calls, [], 'the pane must not be driven when the setting says a window')
  // The message names the path the user typed and where they typed it.
  assert.match(said, /Not A Browser/)
  assert.match(said, /Settings/)
})

test('the default browser cannot be looked at, and the refusal says which setting to change', async (t) => {
  const { result, calls, said } = await lookWith(t, 'system')
  assert.equal(result.ok, false)
  assert.deepEqual(calls, [], 'the pane must not be driven when the setting says the default browser')
  assert.match(said, /default browser/i, 'names the setting, not a stack trace')
  assert.match(said, /Settings/, 'and says where to change it')
})

// ---------------------------------------------------------------- the wider surface

/**
 * An engine that can also *subscribe*, which is what separates a remote
 * control from a debugger. Events are queued by the test and drained by the
 * service exactly as a real one drains its socket.
 */
const eventingEngine = () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  let queued: { method: string; params: Record<string, unknown> }[] = []
  const engine: BrowserEngine = {
    async ensure() {
      return {
        async send(method, params) {
          calls.push({ method, ...(params ? { params } : {}) })
          if (method === 'Runtime.evaluate') {
            const expression = String(params?.['expression'] ?? '')
            if (expression === 'window.devicePixelRatio') return { result: { value: 2 } }
            if (expression.includes('__hd.rect(')) {
              // The page answers in CSS pixels, already scrolled into view.
              return { result: { value: JSON.stringify({ x: 100, y: 50, width: 30, height: 12 }) } }
            }
            if (expression.includes('__hd.tree(')) {
              return { result: { value: JSON.stringify('- document "X"\n  - button "Save" [ref_1]') } }
            }
            if (expression.includes('__hd.fill(')) {
              return { result: { value: JSON.stringify({ role: 'textbox', name: 'Email', value: 'a@b.c' }) } }
            }
            if (expression.includes('__hd.settled(')) return { result: { value: JSON.stringify(true) } }
            if (expression.startsWith('JSON.stringify')) {
              return { result: { value: JSON.stringify({ url: 'http://x/', title: 'X' }) } }
            }
            return { result: { value: 1 } }
          }
          if (method === 'Page.captureScreenshot') return { data: 'AAAA' }
          if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false }
          return {}
        },
        async drain() {
          const out = queued
          queued = []
          return out
        },
      }
    },
    async close() {
      calls.push({ method: '<close>' })
    },
  }
  return {
    engine,
    calls,
    emit: (method: string, params: Record<string, unknown>) => queued.push({ method, params }),
  }
}

/** Runs one expression against `ctx.browser` and hands back what it returned. */
const probe = (body: (browser: any) => Promise<unknown>): HarnessPlugin => ({
  manifest: { id: 'probe', name: 'Probe', permissions: { browser: true } },
  plugin: {
    name: 'probe',
    inject: ['tools', 'browser'],
    apply(ctx: any) {
      ctx.tools.register({
        name: 'probe',
        description: 'One call.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => JSON.stringify((await body(ctx.browser)) ?? null),
      })
    },
  },
})

const runProbe = async (
  t: { after: (fn: () => unknown) => void },
  engine: BrowserEngine,
  body: (browser: any) => Promise<unknown>,
) => {
  setBrowserEngine(engine)
  setBrowserSettings({ placement: 'pane' })
  t.after(() => setBrowserEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(probe(body))
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'probe')!
  const result = await kernel.invokeTool(tool.id, {}, {})
  const text = result.ok ? result.content.map((part: any) => (part.type === 'text' ? part.text : '')).join('') : ''
  return { result, value: result.ok ? (JSON.parse(text) as unknown) : undefined, said: result.ok ? '' : result.error }
}

test('a reference is already in CSS pixels and must not be scaled a second time', async (t) => {
  const { engine, calls } = eventingEngine()
  const { result } = await runProbe(t, engine, (browser) => browser.clickRef('ref_1'))
  assert.equal(result.ok, true)
  const pressed = calls.find(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mousePressed',
  )
  // The page said (100, 50) and the display is 2×. Dividing here — the right
  // thing for a screenshot coordinate — would click at (50, 25), which is the
  // bug this asserts against.
  assert.equal(pressed?.params?.['x'], 100)
  assert.equal(pressed?.params?.['y'], 50)
})

test('a double click is two rising press/release pairs, not one event that says two', async (t) => {
  const { engine, calls } = eventingEngine()
  await runProbe(t, engine, (browser) => browser.clickRef('ref_1', { count: 2 }))
  const presses = calls.filter(
    (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mousePressed',
  )
  assert.deepEqual(
    presses.map((call) => call.params?.['clickCount']),
    [1, 2],
  )
})

test('modifiers become CDP’s bitmask, and a modified letter is a shortcut rather than typing', async (t) => {
  const { engine, calls } = eventingEngine()
  await runProbe(t, engine, (browser) => browser.key('a', 1, ['Meta']))
  assert.equal(calls.some((call) => call.method === 'Input.insertText'), false, '⌘A must not insert the letter a')
  const down = calls.find((call) => call.method === 'Input.dispatchKeyEvent')
  assert.equal(down?.params?.['modifiers'], 4, 'Meta is 4')
})

test('the console view is derived from the events the engine delivered', async (t) => {
  const { engine, emit } = eventingEngine()
  emit('Runtime.consoleAPICalled', {
    type: 'error',
    args: [{ type: 'string', value: 'boom' }],
    stackTrace: { callFrames: [{ url: 'http://x/app.js', lineNumber: 41 }] },
  })
  emit('Log.entryAdded', { entry: { level: 'error', text: 'Refused to load a stylesheet', url: 'http://x/a.css' } })
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }] })
  const { value } = await runProbe(t, engine, async (browser) => ({
    all: await browser.console(),
    // Draining the engine must not consume the ring: a second question about
    // the same page has to see the same page.
    errorsOnly: await browser.console({ onlyErrors: true }),
  }))
  const out = value as { all: { level: string; text: string; line?: number }[]; errorsOnly: unknown[] }
  assert.equal(out.all.length, 3)
  assert.equal(out.all[0]?.text, 'boom')
  assert.equal(out.all[0]?.line, 42, 'CDP counts lines from zero; people do not')
  // The browser's own complaint is in here too — it never reaches console.log,
  // and it is usually the one that explains the blank page.
  assert.ok(out.all.some((entry) => entry.text.includes('Refused to load')))
  assert.equal(out.errorsOnly.length, 2)
})

test('a request is one row folded from its four events, and its body is fetched by id', async (t) => {
  const { engine, emit } = eventingEngine()
  emit('Network.requestWillBeSent', {
    requestId: '7',
    type: 'XHR',
    request: { method: 'POST', url: 'http://x/api/save' },
  })
  emit('Network.responseReceived', { requestId: '7', response: { status: 500, mimeType: 'application/json' } })
  emit('Network.loadingFinished', { requestId: '7', encodedDataLength: 2048 })
  emit('Network.requestWillBeSent', { requestId: '8', request: { method: 'GET', url: 'http://x/img.png' } })
  emit('Network.loadingFailed', { requestId: '8', errorText: 'net::ERR_FAILED' })

  const { value } = await runProbe(t, engine, async (browser) => ({
    rows: await browser.network(),
    body: await browser.network({ requestId: '7' }),
  }))
  const out = value as {
    rows: { requestId: string; method: string; status?: number; bytes?: number; error?: string }[]
    body: { body: string; base64: boolean }
  }
  assert.equal(out.rows.length, 2)
  assert.deepEqual(
    { method: out.rows[0]?.method, status: out.rows[0]?.status, bytes: out.rows[0]?.bytes },
    { method: 'POST', status: 500, bytes: 2048 },
  )
  assert.equal(out.rows[1]?.error, 'net::ERR_FAILED')
  assert.deepEqual(out.body, { body: '{"ok":true}', base64: false })
})

test('an engine that cannot subscribe says so, rather than reporting an empty console', async (t) => {
  const { engine } = recordingEngine() // no drain: commands only
  const { result, said } = await runProbe(t, engine, (browser) => browser.console())
  assert.equal(result.ok, false)
  assert.match(said, /console messages/)
  assert.match(said, /does not deliver events/)
})

test('opening a page drops the previous page’s console, because it was a different page', async (t) => {
  const { engine, emit } = eventingEngine()
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'from the old page' }] })
  const { value } = await runProbe(t, engine, async (browser) => {
    await browser.open('http://x/next')
    return browser.console()
  })
  assert.deepEqual(value, [])
})

test('the passthrough carries any method at all, which is the point of it', async (t) => {
  const { engine, calls } = eventingEngine()
  const { result } = await runProbe(t, engine, (browser) =>
    browser.cdp('Accessibility.getFullAXTree', { depth: -1 }),
  )
  assert.equal(result.ok, true)
  const sent = calls.find((call) => call.method === 'Accessibility.getFullAXTree')
  assert.deepEqual(sent?.params, { depth: -1 })
})

test('reading the page asks the page, and a wait that is already satisfied returns at once', async (t) => {
  const { engine } = eventingEngine()
  const { value } = await runProbe(t, engine, async (browser) => ({
    tree: await browser.readPage(),
    waited: await browser.waitFor({ selector: '#done' }),
    filled: await browser.fill('ref_1', 'a@b.c'),
  }))
  const out = value as { tree: string; waited: boolean; filled: { value: string } }
  assert.match(out.tree, /\[ref_1\]/)
  assert.equal(out.waited, true)
  assert.equal(out.filled.value, 'a@b.c')
})

test('the shell’s own console warning is not reported as something the page said', async (t) => {
  const { engine, emit } = eventingEngine()
  emit('Runtime.consoleAPICalled', {
    type: 'warning',
    args: [{ type: 'string', value: 'Electron Security Warning (Insecure Content-Security-Policy)' }],
    stackTrace: { callFrames: [{ url: 'node:electron/js2c/sandbox_bundle', lineNumber: 1 }] },
  })
  emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'the page’s own line' }] })
  const { value } = await runProbe(t, engine, (browser) => browser.console())
  const entries = value as { text: string }[]
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ['the page’s own line'],
  )
})

test('a credential in a query string is not carried into the network view', async (t) => {
  const { engine, emit } = eventingEngine()
  emit('Network.requestWillBeSent', {
    requestId: '1',
    request: { method: 'GET', url: 'https://x/cb?code=4/0AY-secret&state=abc123&scope=email' },
  })
  emit('Network.requestWillBeSent', {
    requestId: '2',
    request: { method: 'GET', url: 'https://x/api?api_key=AIzaLeaked&q=weather&csrf_token=t0k' },
  })
  emit('Network.requestWillBeSent', { requestId: '3', request: { method: 'GET', url: 'https://x/plain?page=2' } })

  const { value } = await runProbe(t, engine, async (browser) => browser.network())
  const rows = value as { url: string }[]
  // The names stay — an agent debugging a request needs to know what was sent.
  assert.match(rows[0]!.url, /code=%28hidden%29/)
  assert.match(rows[0]!.url, /state=abc123/, 'an OAuth state is a CSRF nonce, not a credential')
  assert.match(rows[0]!.url, /scope=email/)
  assert.match(rows[1]!.url, /api_key=%28hidden%29/)
  assert.match(rows[1]!.url, /csrf_token=%28hidden%29/, 'the *_token suffix rule')
  assert.match(rows[1]!.url, /q=weather/)
  for (const leak of ['4/0AY-secret', 'AIzaLeaked', 't0k']) {
    assert.ok(!rows.some((row) => row.url.includes(leak)), `${leak} reached the network view`)
  }
  // A URL with nothing to redact comes back byte-for-byte, so an agent can
  // still match it against its own logs.
  assert.equal(rows[2]!.url, 'https://x/plain?page=2')
})

/**
 * The offer and the table.
 *
 * `browser_key` used to advertise a key it did not have. The message a bad
 * name got told the caller to press `space`; the only space in the table
 * was the literal `' '`. An agent that read the message and retried with
 * the word it had just been handed got the same message back, and had no
 * third thing to try — which is what makes this worse than a key that is
 * merely missing. The message is written from the table now, and these hold
 * the two together in both directions.
 */
test('every key the message offers is a key the browser takes, and every key it takes is offered', () => {
  const message = unknownKeyMessage('Spacebar')
  const offered = /use (.+), or a single character\.$/.exec(message)?.[1]?.split(', ') ?? []
  // The parse is the part that could rot into a check that cannot fail: a
  // message this pattern misses leaves nothing to loop over, and a test that
  // loops over nothing reports that everything is fine.
  assert.ok(offered.length >= 10 && offered.includes('Enter'), `no key list parsed out of ${JSON.stringify(message)}`)
  for (const name of offered) {
    assert.ok(namedKey(name), `the message offers ${JSON.stringify(name)} and the table has no such key`)
  }
  assert.deepEqual([...offered].sort(), [...KEY_NAMES].sort(), 'a key nobody is told about is a key nobody presses')
  // Two names differing only in case are one entry once folded, and the one
  // the map happened to keep would answer for both. Everything above passes
  // while an entry is quietly dead, so the fold is counted here.
  assert.equal(new Set(KEY_NAMES.map((name) => name.toLowerCase())).size, KEY_NAMES.length, 'two names fold to one')
})

test('a key pressed by name reaches the page as the key itself, not as its name', async (t) => {
  const { engine, calls } = eventingEngine()
  const { result } = await runProbe(t, engine, async (browser) => {
    for (const name of ['space', 'Space', ' ']) await browser.key(name)
    await browser.key('pagedown')
    return null
  })
  assert.equal(result.ok, true)
  const keys = calls.filter((call) => call.method === 'Input.dispatchKeyEvent')

  // Three spellings of one key. A game listening for `event.key === ' '`
  // starts on all three, or the word was never really accepted.
  for (const [name, events] of [
    ['space', keys.slice(0, 3)],
    ['Space', keys.slice(3, 6)],
    [' ', keys.slice(6, 9)],
  ] as const) {
    assert.deepEqual(events.map((call) => call.params?.['type']), ['rawKeyDown', 'char', 'keyUp'], name)
    for (const event of events) {
      assert.equal(event.params?.['key'], ' ', `${name} has to arrive as a space`)
      assert.equal(event.params?.['code'], 'Space')
      assert.equal(event.params?.['windowsVirtualKeyCode'], 32)
    }
    assert.equal(events[1]?.params?.['text'], ' ', 'the char event is what a text field fills from')
  }

  // Case is a spelling, not a different key — as it already is for modifiers.
  assert.equal(keys[9]?.params?.['key'], 'PageDown')
  assert.equal(keys[9]?.params?.['windowsVirtualKeyCode'], 34)
})

test('a name the browser really has not got is refused with the names it has', async (t) => {
  const { engine } = eventingEngine()
  // The legacy spelling, and a plausible thing to reach for. It is not a key
  // here — and what comes back is a list every entry of which is.
  const { result, said } = await runProbe(t, engine, (browser) => browser.key('Spacebar'))
  assert.equal(result.ok, false)
  assert.match(said, /Unknown key "Spacebar"/)
  assert.match(said, /, space, or a single character\.$/)
})

test('a modifier turns a named key into a shortcut, and folding its case does not', async (t) => {
  const { engine, calls } = eventingEngine()
  const { result } = await runProbe(t, engine, async (browser) => {
    await browser.key('enter')
    await browser.key('space', 1, ['Shift'])
    return null
  })
  assert.equal(result.ok, true)
  const keys = calls.filter((call) => call.method === 'Input.dispatchKeyEvent')

  // Case folding must not cost the `char` event, which is the half of Enter
  // that a form submits on. The guard reads the key the table holds now
  // rather than the word the caller typed, and `enter` is that word.
  assert.deepEqual(keys.slice(0, 3).map((call) => call.params?.['type']), ['rawKeyDown', 'char', 'keyUp'])
  assert.equal(keys[0]?.params?.['key'], 'Enter')
  assert.equal(keys[1]?.params?.['text'], '\r')

  // Held with a modifier the same key is a shortcut, and a shortcut inserts
  // nothing: ⇧Space scrolls a page, it does not type into it.
  assert.deepEqual(keys.slice(3).map((call) => call.params?.['type']), ['rawKeyDown', 'keyUp'])
  assert.equal(keys[3]?.params?.['key'], ' ')
  assert.equal(keys[3]?.params?.['modifiers'], 8)
})

test('the key under a character: its letter, its digit, or its place on a US layout', () => {
  // #44: `Key${upper}` was right for letters alone.
  assert.deepEqual(characterKey('a'), { code: 'KeyA', keyCode: 65 })
  assert.deepEqual(characterKey('Z'), { code: 'KeyZ', keyCode: 90 })
  assert.deepEqual(characterKey('7'), { code: 'Digit7', keyCode: 55 })
  assert.deepEqual(characterKey(','), { code: 'Comma', keyCode: 188 })
  assert.deepEqual(characterKey('?'), { code: 'Slash', keyCode: 191 }, 'a shifted character names the key it is typed on')
  assert.deepEqual(characterKey('\\'), { code: 'Backslash', keyCode: 220 })
  assert.equal(characterKey('é'), null)
})

test('a shortcut on a digit or a punctuation key goes out as that key', async (t) => {
  // #44: ⌘1 went out as `Key1` and ⌘, as `Key,`, and a page reading `event.code` saw neither.
  const { engine, calls } = recordingEngine()
  setBrowserEngine(engine)
  t.after(() => setBrowserEngine(null))
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load({
    manifest: { id: 'shortcuts', name: 'Shortcuts', permissions: { browser: true } },
    plugin: {
      name: 'shortcuts',
      inject: ['tools', 'browser'],
      apply(ctx: any) {
        ctx.tools.register({
          name: 'press',
          description: 'Presses each key with ⌘.',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => {
            await ctx.browser.open('http://x/')
            for (const key of ['1', ',', '?', 'a', 'é']) await ctx.browser.key(key, 1, ['meta'])
            return 'pressed'
          },
        })
      },
    },
  })
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'press')!
  const result = await kernel.invokeTool(tool.id, {}, {})
  assert.equal(result.ok, true, JSON.stringify(result))
  const downs = calls
    .filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params?.['type'] === 'rawKeyDown')
    .map((call) => [call.params?.['key'], call.params?.['code'], call.params?.['windowsVirtualKeyCode']])
  assert.deepEqual(downs, [
    ['1', 'Digit1', 49],
    [',', 'Comma', 188],
    ['?', 'Slash', 191],
    ['a', 'KeyA', 65],
    // Off the layout: the key alone, which a page reading `event.key` still sees.
    ['é', undefined, undefined],
  ])
})

test('the shifted digits and the rest of the punctuation keys', () => {
  // Round 1 of #160: the map's other entries, unasserted.
  const cases: [string, string, number][] = [
    ['!', 'Digit1', 49],
    [')', 'Digit0', 48],
    ['+', 'Equal', 187],
    ['[', 'BracketLeft', 219],
    [';', 'Semicolon', 186],
    ["'", 'Quote', 222],
    ['`', 'Backquote', 192],
    ['~', 'Backquote', 192],
  ]
  for (const [character, code, keyCode] of cases) assert.deepEqual(characterKey(character), { code, keyCode }, character)
})
