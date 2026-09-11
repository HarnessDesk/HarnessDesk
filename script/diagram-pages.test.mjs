/**
 * The diagram pages are rendered by Archify and then patched by hand: its
 * Signal Flow preset leaves the toolbar without colours of its own (#93), and a
 * regenerate rewrites the stylesheet the patch lives in. Nothing else would
 * notice — see docs/diagrams/README.md, "Regenerating".
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DIAGRAMS = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'docs/diagrams')
/* Found rather than listed: a hand-kept list once left a package out of the
   test glob (script/verify.mjs). The sources say which pages there are. */
const PAGES = readdirSync(DIAGRAMS).filter((name) => name.endsWith('.html')).sort()
const SOURCES = readdirSync(DIAGRAMS).filter((name) => name.endsWith('.architecture.json')).sort()
const TOOLBAR = ['--toolbar-bg', '--toolbar-border', '--toolbar-text', '--toolbar-hover', '--toolbar-menu-bg']

/**
 * Each look's block for each theme, with the values it declares: a preset's
 * `[data-preset="…"][data-theme="…"] { … }`, and the default look's own
 * `[data-theme="…"] { … }`, which no other selector comes right before.
 *
 * Only a block that gives the toolbar a colour is a look's: the page also has
 * a rule shared by both themes that sets nothing for it. A look that loses
 * all five drops out of the list, which fails below as surely as a missing
 * name does.
 */
const looks = (html) =>
  [...html.matchAll(/(?:\[data-preset="([\w-]+)"\]|(?<!\]))\[data-theme="(dark|light)"\]\s*\{([^}]*)\}/g)]
    .map(([, preset, theme, body]) => ({
      look: preset ?? 'default',
      theme,
      values: new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.replace(/\s+/g, '')])),
    }))
    .filter(({ values }) => TOOLBAR.some((name) => values.has(name)))

test('every diagram source has its page, and every page its source', () => {
  assert.ok(PAGES.length > 0, 'no pages found, so the tests below would check nothing')
  assert.deepEqual(PAGES, SOURCES.map((name) => name.replace(/\.architecture\.json$/, '.html')))
})

for (const page of PAGES) {
  test(`every look gives the toolbar all five colours in both themes, and Signal Flow's are its own: ${page} (#93)`, () => {
    const found = looks(readFileSync(join(DIAGRAMS, page), 'utf8'))
    // The default look and three presets, two themes each. Anything else is a
    // pattern that stopped matching, not a pass.
    assert.deepEqual(found.map(({ look, theme }) => `${look} ${theme}`).sort(), [
      'blueprint dark',
      'blueprint light',
      'default dark',
      'default light',
      'editorial dark',
      'editorial light',
      'signal-flow dark',
      'signal-flow light',
    ])
    for (const { look, theme, values } of found) {
      assert.deepEqual(TOOLBAR.filter((name) => !values.has(name)), [], `${look}, ${theme}`)
    }
    /* Declared is not enough. Signal Flow given the default look's five colours
       is the slate toolbar #93 was about, with every name present (review of
       #189, round 2). */
    for (const theme of ['dark', 'light']) {
      const toolbarOf = (look) =>
        TOOLBAR.map((name) => found.find((block) => block.look === look && block.theme === theme)?.values.get(name)).join(' ')
      assert.notEqual(toolbarOf('signal-flow'), toolbarOf('default'), `signal-flow, ${theme}: the default look's toolbar`)
    }
  })
}
