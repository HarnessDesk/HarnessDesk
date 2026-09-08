import { describe, expect, it } from 'vitest'

import editor from './editor.css?raw'

/**
 * The syntax tokens have the same failure mode `editorial-tokens.test.ts`
 * guards: a face that forgets one falls through to the face above it, and a
 * dark editor quietly draws a light theme's string colour. Nothing throws.
 *
 * The rule is not "every face defines every token" — the dark and Editorial
 * blocks legitimately inherit values that read correctly in both. It is that
 * the *colour* tokens, the ones a wrong inheritance actually breaks, are
 * re-grounded everywhere, and that the base block is complete.
 */

/** Custom properties defined in the nth `{…}` block. */
const definedIn = (css: string, block: number): Set<string> => {
  const bodies = [...css.matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '')
  return new Set([...(bodies[block] ?? '').matchAll(/(--hd-code-[\w-]+)\s*:/g)].map((m) => m[1] ?? ''))
}

/** What CodeMirror is told to paint with, and so what must never fall through. */
const SYNTAX = [
  '--hd-code-keyword',
  '--hd-code-string',
  '--hd-code-number',
  '--hd-code-comment',
  '--hd-code-function',
  '--hd-code-type',
  '--hd-code-variable',
  '--hd-code-constant',
  '--hd-code-operator',
  '--hd-code-punctuation',
  '--hd-code-invalid',
  '--hd-code-heading',
  '--hd-code-link',
]

const CHROME = [
  '--hd-code-gutter-bg',
  '--hd-code-gutter-fg',
  '--hd-code-active-line',
  '--hd-code-selection',
  '--hd-code-cursor',
  '--hd-code-matching-bracket',
  '--hd-code-search-match',
]

describe('editor.css', () => {
  // 0 Blueprint light, 1 Blueprint dark, 2 Editorial light, 3 Editorial dark.
  const faces = {
    'blueprint light': definedIn(editor, 0),
    'blueprint dark': definedIn(editor, 1),
    'editorial light': definedIn(editor, 2),
    'editorial dark': definedIn(editor, 3),
  }

  it('defines the whole vocabulary in the base face', () => {
    const base = faces['blueprint light']
    const missing = [...SYNTAX, ...CHROME].filter((token) => !base.has(token))
    expect(missing, `the base face is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('re-grounds every syntax colour in every face', () => {
    for (const [name, defined] of Object.entries(faces)) {
      const missing = SYNTAX.filter((token) => !defined.has(token))
      expect(missing, `${name} inherits a colour it should own: ${missing.join(', ')}`).toEqual([])
    }
  })

  it('re-grounds selection and cursor away from the base face', () => {
    // These three are the ones that go invisible rather than merely wrong: a
    // light selection wash over a dark ground hides the selected text.
    for (const face of ['blueprint dark', 'editorial light', 'editorial dark'] as const) {
      for (const token of ['--hd-code-selection', '--hd-code-cursor', '--hd-code-active-line']) {
        expect(faces[face].has(token), `${face} keeps the base ${token}`).toBe(true)
      }
    }
  })

  it('is addressed by the palette and theme attributes the app actually sets', () => {
    expect(editor).toContain("body[data-hd-palette='editorial']")
    expect(editor).toContain('body[data-hd-dark-theme]')
    expect(editor).toContain("body[data-hd-palette='editorial'][data-hd-dark-theme]")
  })
})
