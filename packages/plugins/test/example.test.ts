/**
 * The worked example has to still work.
 *
 * `examples/browser-plugin` is what `docs/extending.md` tells a plugin author
 * to read side by side with the guide, and it is the one file in this
 * repository that a stranger is invited to copy. It is also invisible to every
 * gate: it is not in `pnpm-workspace.yaml`, not in the root `tsconfig.json`,
 * and until this file nothing imported it. So a rename on `HarnessContext`
 * would have broken the example silently and been found by whoever tried the
 * getting-started path — which is the worst possible discoverer.
 *
 * Loading it into the real kernel is the whole check. It registers three
 * tools, two commands and a panel through `ctx.tools`, `ctx.commands` and
 * `ctx.ui`, so anything renamed underneath it throws here instead.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

import { ExtensionKernel, loadInstalled } from '@harnessdesk/cordis-host'

/** This file runs from `dist/test`, so find the checkout rather than count `..`. */
const checkout = () => {
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const up = dirname(root)
    assert.notEqual(up, root, 'ran outside the checkout')
    root = up
  }
  return root
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('the example plugin loads in the real kernel', async (t) => {
  const dir = join(checkout(), 'examples/browser-plugin')
  /* `loadInstalled`, not `kernel.load` directly: the example is in the shape a
     third-party plugin ships in — an entry file beside a
     `harnessdesk.plugin.json` — and that is the path `docs/extending.md` tells
     an author to use when it says "install it by path". A built-in carries its
     manifest inline instead, so loading the example the built-in way fails on a
     manifest that was never there. */
  const plugin = await loadInstalled(dir)

  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(plugin)
  await settle()

  const loaded = kernel.plugins().find((one) => one.identity.id === 'browser-example')
  assert.ok(loaded, 'the example did not register itself')

  const kinds = new Set<string>(loaded.contributions.map((one) => one.kind))
  // What the guide says it demonstrates. If the example stops contributing one
  // of these, the guide is teaching from a file that no longer shows it.
  for (const kind of ['tool', 'command'] as const) {
    assert.ok(kinds.has(kind), `the example no longer contributes a ${kind}`)
  }

  /* Its panel is deliberately not in that list. The example registers one only
     once it has reading history — `if (history.length === 0) return` — because
     an empty panel is noise, so a cold load has no `ui` contribution and
     asserting one here would fail against a correct example. What holds the
     panel honest is the manifest test below: it still has to declare that it
     contributes UI at all. */
  assert.equal(loaded.state.type, 'active', 'the example loaded but did not become active')
})

test("the example's browse_page decodes a page's entities in one pass (#169)", async () => {
  /* The example keeps its own `htmlToText`, and it decoded `&amp;` first and
     then the `&lt;` that uncovered, so a page showing the markup `&lt;div&gt;`
     read as a tag. The kernel's copy was fixed in #164; this is the copy an
     author starts from. `&lt;b&gt;` and `&quot;` read the same either way. */
  const entry = pathToFileURL(join(checkout(), 'examples/browser-plugin/index.js')).href
  const { plugin } = (await import(entry)) as { plugin: { apply: (ctx: unknown, config: unknown) => void } }
  type Tool = { name: string; execute: (args: Record<string, unknown>) => unknown }
  const tools = new Map<string, Tool>()
  const page = '<title>Escapes</title><p>&amp;lt;div&amp;gt; &lt;b&gt; &amp;amp; &quot;q&quot;&nbsp;end</p>'
  plugin.apply(
    {
      tools: { register: (tool: Tool) => void tools.set(tool.name, tool) },
      http: { fetch: async () => ({ status: 200, body: page }) },
      commands: { register: () => () => {} },
      ui: { register: () => () => {} },
      harness: {},
    },
    {},
  )
  const read = String(await tools.get('browse_page')?.execute({ url: 'https://example.test/escapes' }))
  assert.equal(read.split('\n').at(-1), 'Escapes &lt;div&gt; <b> &amp; "q" end')
})

test('the example manifest is the shape a plugin author would copy', async () => {
  const dir = join(checkout(), 'examples/browser-plugin')
  const manifest = JSON.parse(await readFile(join(dir, 'harnessdesk.plugin.json'), 'utf8'))

  assert.equal(typeof manifest.id, 'string')
  assert.equal(typeof manifest.name, 'string')
  assert.equal(manifest.main, './index.js')
  assert.ok(existsSync(join(dir, manifest.main)), `manifest main "${manifest.main}" does not exist`)

  // The example asks for the network, and the guide's whole point about
  // permissions is that a plugin declares what it needs. An example that
  // quietly stopped declaring would teach the opposite.
  assert.ok(manifest.permissions?.network, 'the example stopped declaring its network permission')
})
