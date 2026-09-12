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
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ExtensionKernel, MANIFEST_FILENAME, hostAllowed, loadInstalled } from '@harnessdesk/cordis-host'

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

/** The directory `docs/extending.md` sends an author to, and the one every test here loads. */
const example = () => join(checkout(), 'examples/browser-plugin')

test('the example plugin loads in the real kernel', async (t) => {
  const dir = example()
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

test("the example's browse_page decodes a page's entities in one pass (#169)", async (t) => {
  /* The example keeps its own `htmlToText`, and it decoded `&amp;` first and
     then the `&lt;` that uncovered, so a page showing the markup `&lt;div&gt;`
     read as a tag. The kernel's copy was fixed in #164; this is the copy an
     author starts from. `&lt;b&gt;` and `&quot;` read the same either way.
     Through the kernel and a real fetch, as a plugin's tool runs: a context
     built by hand would have stayed green whatever `ctx.http.fetch` became
     (review of #207, round 1). What lets the fetch through is asserted
     below, beside the port it depends on. */
  const { createServer } = await import('node:http')
  const page = '<title>Escapes</title><p>&amp;lt;div&amp;gt; &lt;b&gt; &amp;amp; &quot;q&quot;&nbsp;end it&apos;s &#x27;x&#38;y&#39;</p>'
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(page)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const { port } = server.address() as { port: number }
  /* Why a fetch to this test's own server reaches the plugin at all, said
     where it is relied on rather than left to be discovered.

     An installed plugin's manifest *is* its grant — nothing widens one
     afterwards — and this server answers on a port the machine chose, so only
     a pattern naming every host lets it through. Tighten the example and this
     line names the manifest and the two ways out. Without it the fetch below
     fails with `127.0.0.1:51014 is not in this plugin's allowed hosts`: true,
     three frames from the cause, and nothing a reader can act on. Asked
     through `hostAllowed`, so it is the kernel's own matcher answering and not
     a second opinion about what a host pattern means. */
  const manifest = JSON.parse(await readFile(join(example(), MANIFEST_FILENAME), 'utf8'))
  assert.ok(
    hostAllowed(manifest.permissions?.network?.hosts ?? [], `127.0.0.1:${port}`),
    `this test serves its page from 127.0.0.1:${port}, which the example's manifest does not allow (hosts: ${JSON.stringify(manifest.permissions?.network?.hosts)}). Point the fixture at a host the manifest allows, or keep the wildcard the manifest test pins.`,
  )
  const kernel = new ExtensionKernel()
  t.after(() => kernel.dispose())
  await kernel.load(await loadInstalled(example()))
  await settle()
  const tool = kernel.list('tool').find((entry) => entry.name === 'browse_page')
  assert.ok(tool, 'the example registers browse_page')
  const result = await kernel.invokeTool(tool.id, { url: `http://127.0.0.1:${port}/` }, {})
  if (!result.ok) throw new Error(result.error)
  const read = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  // Review of #221, round 1: the example reads `&apos;` and any character by its number, as the kernel does.
  assert.equal(read.split('\n').at(-1), 'Escapes &lt;div&gt; <b> &amp; "q" end it\'s \'x&y\'')
})

test('the example manifest is the shape a plugin author would copy', async () => {
  const dir = example()
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILENAME), 'utf8'))

  assert.equal(typeof manifest.id, 'string')
  assert.equal(typeof manifest.name, 'string')
  assert.equal(manifest.main, './index.js')
  assert.ok(existsSync(join(dir, manifest.main)), `manifest main "${manifest.main}" does not exist`)

  /* The example asks for the network, and the guide's whole point about
     permissions is that a plugin declares what it needs. An example that
     quietly stopped declaring would teach the opposite.

     It asks for *every* host, and the wildcard is pinned rather than waved
     through, for two reasons. It is this plugin's honest declaration and not
     a lazy one: `browse_page` reads whatever URL the agent names, so there is
     no host to name in advance — where a plugin that talks to one API names
     it, as `docs/extending.md` shows and the built-in `web` plugin insists by
     shipping an empty list. And the kernel test above depends on it, so
     tightening the example has to fail here, saying which test and why,
     rather than there, as a denied fetch to a random port. */
  assert.deepEqual(
    manifest.permissions?.network?.hosts,
    ['*'],
    "the example changed the hosts it declares; the kernel test above fetches this repository's own loopback server, which only a wildcard reaches",
  )

  /* The panel, held here because the kernel test above deliberately cannot:
     the example registers one only once it has reading history, so a cold
     load has no `ui` contribution to assert. That comment has claimed this
     line existed since the test was written; it did not. */
  assert.equal(
    manifest.permissions?.ui?.contribute,
    true,
    'the example stopped declaring that it contributes UI, which is the only thing holding its panel honest',
  )
})
