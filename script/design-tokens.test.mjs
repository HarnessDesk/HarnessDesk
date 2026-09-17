import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nativeFoundation, NATIVE_TOKENS } from './design-tokens.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('the native About foundation is generated from the renderer token cascade', () => {
  const generated = nativeFoundation(root)
  const checkedIn = readFileSync(
    join(root, 'packages/desktop/electron/assets/about-foundation.css'),
    'utf8',
  )

  assert.equal(checkedIn, generated)
  assert.match(generated, /@media \(prefers-color-scheme: dark\)/)
  assert.match(generated, /:root\[data-hd-palette='editorial'\]/)
  assert.match(generated, /:root\[data-hd-palette='shadcn'\]/)
  assert.match(generated, /:root\[data-hd-corners='round'\]/)
  for (const token of NATIVE_TOKENS) {
    assert.ok(generated.split(`${token}:`).length >= 3, `${token} is present in both faces`)
  }
})

test('the About asset consumes the generated contract instead of owning a palette', () => {
  const html = readFileSync(join(root, 'packages/desktop/electron/assets/about.html'), 'utf8')
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''

  assert.match(html, /href="about-foundation\.css"/)
  assert.match(html, /style-src 'self' 'unsafe-inline'/)
  assert.match(style, /var\(--hd-background\)/)
  assert.match(style, /var\(--hd-foreground\)/)
  assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b|rgba?\(/i)
  assert.match(html, /\['palette', 'hdPalette'\]/)
  assert.match(html, /\['corners', 'hdCorners'\]/)
  assert.match(html, /dataset\[data\]/)
})
