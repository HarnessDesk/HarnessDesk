import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import tokens from '../foundation/tokens.css?raw'
import css from './Settings.module.css?raw'
import { CodeText } from './Settings'

/**
 * Code in a sentence follows the sentence (review of #908).
 *
 * `CodeText` was a fixed 12.5px — no step of the scale, and the same size in
 * a 14px paragraph as in a 13px row — while raw `font-mono` at the
 * paragraph's own size read a step larger than the words around it. Its size
 * is now relative to the sentence (a token, so a foundation can move it),
 * with the scale's smallest step as its floor.
 */
it('sizes code relative to its sentence, through a token, never below the smallest step', () => {
  const rule = (/(?:^|\n)\.mono \{([^}]*)\}/.exec(css)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  expect(rule).toMatch(/font-size:\s*var\(--hd-code-inline\)/)
  expect(rule).not.toMatch(/\d+(?:\.\d+)?px/)
  const token = /--hd-code-inline:\s*([^;]+);/.exec(tokens)?.[1] ?? ''
  expect(token).toMatch(/^max\(var\(--hd-text-xs\), 0\.\d+em\)$/)
  // The guard on the guard: the rule is the one the part wears.
  expect(renderToStaticMarkup(<CodeText>main</CodeText>)).toMatch(/data-slot="code-text"/)
})

it('spaces a code read aloud through a token, and only when asked', () => {
  const rule = (/(?:^|\n)\.mono\[data-spaced\],\n\.mono\[data-spaced\] \* \{([^}]*)\}/.exec(css)?.[1] ?? '')
  expect(rule).toMatch(/letter-spacing:\s*var\(--hd-code-tracking-spaced\)/)
  expect(/--hd-code-tracking-spaced:\s*([^;]+);/.exec(tokens)?.[1]).toBe('0.18em')
  expect(renderToStaticMarkup(<CodeText spaced>WDJB-MJHT</CodeText>)).toContain('data-spaced=""')
  expect(renderToStaticMarkup(<CodeText>main</CodeText>)).not.toContain('data-spaced')
})
