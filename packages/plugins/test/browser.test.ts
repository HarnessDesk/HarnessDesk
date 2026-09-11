import assert from 'node:assert/strict'
import { test } from 'node:test'

import { KEY_NAMES, namedKey } from '@harnessdesk/cordis-host'

import { browserPlugin } from '../src/browser.js'

/**
 * The tool surface over a browser service that is faked here, so what is
 * pinned is the plugin's own behaviour: which calls it makes and what it
 * says back, not what a browser does.
 */
const withBrowser = (browser: Record<string, unknown>) => {
  const tools = new Map<string, { execute: (args: unknown) => Promise<unknown>; description?: string }>()
  const ctx = {
    tools: {
      register: (tool: { name: string; description?: string; execute: (args: unknown) => Promise<unknown> }) =>
        tools.set(tool.name, tool),
    },
    context: { register: () => {} },
    browser,
  }
  browserPlugin.plugin.apply(ctx as never)
  return tools
}

test('a page handed to the default browser is reported as such, and never screenshotted', async () => {
  let looked = 0
  const tools = withBrowser({
    open: async (url: string) => ({ url, title: '', handedOff: true as const }),
    screenshot: async () => {
      looked += 1
      throw new Error('the setting refuses this')
    },
    page: async () => ({ url: 'x', title: 'x' }),
  })
  const parts = (await tools.get('browser_open')!.execute({ url: 'http://a.test/' })) as { type: string; text?: string }[]
  assert.equal(looked, 0, 'a page nobody can look at is not looked at')
  assert.equal(parts.length, 1)
  assert.match(parts[0]!.text ?? '', /default browser/)
  assert.match(parts[0]!.text ?? '', /Settings → Browser → Pages open/)
})

test('a page opened where it can be seen comes back with a screenshot', async () => {
  const tools = withBrowser({
    open: async (url: string) => ({ url, title: 'A page' }),
    screenshot: async () => 'data:image/png;base64,AAAA',
    page: async () => ({ url: 'http://a.test/', title: 'A page' }),
  })
  const parts = (await tools.get('browser_open')!.execute({ url: 'http://a.test/' })) as { type: string; text?: string }[]
  assert.deepEqual(parts.map((part) => part.type), ['text', 'image'])
  assert.match(parts[0]!.text ?? '', /Opened — A page/)
})

test('the tool surface redacts where a page is read for you, and not where you asked for a value', async () => {
  // Codex 5.3's review of #71 asked for this at the tool level: the page
  // helpers are tested in cordis-host, but nothing pinned what an *agent*
  // gets back, which is the thing that lands in a transcript.
  const calls: string[] = []
  const tools = withBrowser({
    readPage: async () => '- textbox "Password" [ref_1] secret filled',
    fill: async (ref: string, value: string) => {
      calls.push(`fill:${ref}:${value}`)
      return { role: 'textbox', name: 'Password', secret: true, filled: true }
    },
    type: async (text: string) => {
      calls.push(`type:${text}`)
    },
    evaluate: async (expression: string) => {
      calls.push(`evaluate:${expression}`)
      return 'hunter2'
    },
    screenshot: async () => 'data:image/png;base64,AAAA',
    page: async () => ({ url: 'http://a.test/', title: 'Sign in' }),
  })

  const read = await tools.get('browser_read_page')!.execute({})
  assert.equal(read, '- textbox "Password" [ref_1] secret filled')

  // The write still happens in full — signing in is the point — and the
  // report back carries the bit, not the password.
  const filled = (await tools.get('browser_fill')!.execute({ ref: 'ref_1', value: 'hunter2' })) as { text?: string }[]
  assert.ok(calls.includes('fill:ref_1:hunter2'), 'the value reached the page')
  assert.match(filled[0]!.text ?? '', /"secret":true/)
  assert.doesNotMatch(filled[0]!.text ?? '', /hunter2/, 'browser_fill echoes its return value verbatim')

  await tools.get('browser_type')!.execute({ text: 'hunter2', ref: 'ref_1' })
  const typed = (await tools.get('browser_type')!.execute({ text: 'hunter2' })) as { text?: string }[]
  assert.doesNotMatch(typed[0]!.text ?? '', /hunter2/, 'typing reports that it typed, not what')

  // And the escape hatch is deliberately *not* guarded: an expression the
  // agent wrote returns what it asked for. Pinned so that stays a decision
  // rather than drifting into a half-guard nobody can rely on.
  const evaluated = await tools.get('browser_evaluate')!.execute({
    expression: 'document.querySelector("input[type=password]").value',
  })
  assert.equal(evaluated, '"hunter2"')
  assert.match(
    tools.get('browser_evaluate')!.description ?? '',
    /unredacted/,
    'and the description says so, so it is a choice the caller makes knowingly',
  )
})

test('browser_key offers the agent exactly the keys the browser will take', () => {
  // A description is what an agent reads before the first press and an error
  // message is what it reads after the first failure, so the two are one
  // promise made twice. Both used to name `space` and neither could press
  // it, which left the retry — read the message, use the name it gives —
  // looping on the same word. The description is still written by hand —
  // this is what holds it to the keys `ctx.browser` has.
  const description = withBrowser({}).get('browser_key')!.description ?? ''
  const offered = /use (.+), or a single character\./.exec(description)?.[1]?.split(', ') ?? []
  assert.ok(
    offered.length >= 10 && offered.includes('Enter'),
    `no key list parsed out of ${JSON.stringify(description)}`,
  )
  for (const name of offered) {
    assert.ok(namedKey(name), `browser_key offers ${JSON.stringify(name)} and ctx.browser has no such key`)
  }
  assert.deepEqual([...offered].sort(), [...KEY_NAMES].sort(), 'a key the tool never mentions is a key nobody presses')
})

test('a page saved as a PDF comes back as a sentence naming the file, not as an image', async () => {
  // #51: the PDF was an image part, which no model reads, and the transcript drew it as a broken image (#79).
  const tools = withBrowser({
    page: async () => ({ url: 'http://a.test/', title: 'Quarterly report' }),
    savePdf: async (options: { name?: string }) => ({ path: `/tmp/hd-pdf-x/${options.name}.pdf`, bytes: 12_345 }),
    pdf: async () => {
      throw new Error('a data URL is not how a page is saved')
    },
  })
  const parts = (await tools.get('browser_page')!.execute({ action: 'pdf' })) as { type: string; text?: string }[]
  assert.deepEqual(parts.map((part) => part.type), ['text'])
  assert.equal(
    parts[0]!.text,
    'Saved Quarterly report as a PDF (12.1kB) at "/tmp/hd-pdf-x/Quarterly report.pdf". It\'s removed when HarnessDesk quits, so copy it somewhere to keep it.',
  )
})
