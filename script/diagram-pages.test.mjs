/**
 * The two diagram pages are rendered by Archify and then patched by hand: its
 * Signal Flow preset leaves the toolbar without colours of its own (#93), and a
 * regenerate rewrites the stylesheet the patch lives in. Nothing else would
 * notice — see docs/diagrams/README.md, "Regenerating".
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAGES = ['docs/diagrams/architecture.html', 'docs/diagrams/plugin-tools.html']
const TOOLBAR = ['--toolbar-bg', '--toolbar-border', '--toolbar-text', '--toolbar-hover', '--toolbar-menu-bg']

/** Each `[data-preset="…"][data-theme="…"] { … }` block and the properties it declares. */
const presetBlocks = (html) =>
  [...html.matchAll(/\[data-preset="([\w-]+)"\]\[data-theme="(dark|light)"\]\s*\{([^}]*)\}/g)].map(
    ([, preset, theme, body]) => ({
      preset,
      theme,
      declares: new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name)),
    }),
  )

for (const page of PAGES) {
  test(`every preset gives the toolbar all five colours in both themes: ${page} (#93)`, () => {
    const blocks = presetBlocks(readFileSync(join(root, page), 'utf8'))
    // Three presets, two themes each; the default look is not a preset. Anything
    // else is a pattern that stopped matching, not a pass.
    assert.deepEqual(
      blocks.map(({ preset, theme }) => `${preset} ${theme}`).sort(),
      ['blueprint dark', 'blueprint light', 'editorial dark', 'editorial light', 'signal-flow dark', 'signal-flow light'],
    )
    for (const { preset, theme, declares } of blocks) {
      assert.deepEqual(TOOLBAR.filter((name) => !declares.has(name)), [], `${preset}, ${theme}`)
    }
  })
}
