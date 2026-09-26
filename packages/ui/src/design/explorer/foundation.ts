import { useEffect, useState } from 'react'

import tokensCss from '../foundation/tokens.css?raw'

/**
 * A foundation is a set of token overrides — and so is a theme.
 *
 * That is the whole answer to "how do we redesign without a rewrite" and to
 * "how do users get a custom theme": both are the same object, a map of token
 * name to value, applied on `body` where the cascade puts it last. Nothing
 * downstream knows the difference between the built-in look, a candidate
 * redesign, and something a person typed into a settings pane.
 *
 * The candidates below are deliberately small. A real proposal would be a
 * whole `tokens.<name>.css`; these exist so the switch has something to prove
 * with, and so the mechanism is exercised by the page that documents it.
 */
export type Foundation = {
  id: string
  title: string
  about: string
  overrides: Record<string, string>
}

export const FOUNDATIONS: Foundation[] = [
  {
    id: 'current',
    title: 'Current',
    about: 'The app as it ships today.',
    overrides: {},
  },
  {
    id: 'flat',
    title: 'Flat cards',
    // The card is now tinted and borderless by default, which is the
    // reference's answer and the one the settings pages are drawn for. This
    // is the way back: white cards with a hairline, the way the app read
    // before. Kept switchable because "does a settings page want blocks of
    // colour or blocks of outline" is a taste question, and the token layer
    // is where a taste question should be answerable in four lines.
    about: 'Cards as white sheets with a hairline, instead of a wash of the brand.',
    overrides: {
      '--hd-card-fill': 'var(--hd-card)',
      '--hd-card-border': 'var(--hd-border-strong)',
      '--hd-card-radius': 'var(--hd-radius)',
    },
  },
  {
    id: 'dense-pages',
    title: 'Dense pages',
    // Settings and Usage stand their controls at 36px — the reference's
    // `h-9`. This puts them back on the app's working 26px, which is the
    // right answer if the pages start feeling like a website.
    about: "Settings and Usage at the app's own 26px control height.",
    overrides: {
      '--hd-control-h-lg': 'var(--hd-control-h)',
    },
  },
  {
    id: 'squared',
    title: 'Squared',
    about: 'A flatter, tighter shape — the direction a shadcn-style dashboard pulls.',
    overrides: {
      '--hd-radius-sm': '4px',
      '--hd-radius': '6px',
      '--hd-radius-lg': '8px',
      '--hd-control-h': '32px',
      '--hd-control-h-sm': '26px',
    },
  },
  {
    id: 'roomy',
    title: 'Roomy',
    about: 'One step up the space scale everywhere, for a less dense reading.',
    overrides: {
      '--hd-space-1-5': '8px',
      '--hd-space-2': '10px',
      '--hd-space-2-5': '12px',
      '--hd-space-3': '16px',
      '--hd-space-4': '20px',
      '--hd-row-h': '34px',
    },
  },
  {
    id: 'pill',
    title: 'Pill buttons',
    // Not a hypothetical. The notification banner's action button is already
    // drawn exactly this way, and it is the only control in the app that is:
    // 34px tall, fully rounded, no border. Whether that is the app's button or
    // an outlier is a real question, and this is what answering it "yes" looks
    // like everywhere at once.
    //
    // It used to carry three colour overrides as well, because the banner was
    // on the platform's own primary fill and every other button was the brand
    // blue. That half of the disagreement is settled: `--hd-solid` is the app's
    // one ink and the banner reads it like everything else, so what is left
    // here is the shape — which is the part still worth asking about.
    about: "The banner's action button's shape, applied to every button in the app.",
    overrides: {
      '--hd-btn-h': '34px',
      '--hd-btn-radius': 'var(--hd-radius-full)',
      '--hd-btn-padding': '0 16px',
      '--hd-btn-border': 'transparent',
      '--hd-chip-radius': 'var(--hd-radius-full)',
    },
  },
]

/**
 * Which tokens to show together, and how to draw them.
 *
 * The names are matched rather than listed, so a token added to the CSS shows
 * up here without anyone editing this file. A list would be a second source of
 * truth and would be wrong within a week.
 */
export const TOKEN_GROUPS: {
  title: string
  kind: 'color' | 'space' | 'plain'
  match: (name: string) => boolean
}[] = [
  { title: 'Space', kind: 'space', match: (n) => n.startsWith('--hd-space-') },
  // Surfaces exclude their own text colour; that belongs under Text, and a
  // token listed twice reads as two tokens.
  {
    title: 'Surface',
    kind: 'color',
    match: (n) => /^--hd-(background|card|popover|muted|input)/.test(n) && !n.endsWith('-foreground'),
  },
  { title: 'Text', kind: 'color', match: (n) => n.endsWith('foreground') },
  {
    title: 'Action',
    kind: 'color',
    match: (n) => /^--hd-(primary|destructive|success|warning|accent|ring)/.test(n),
  },
  { title: 'Line', kind: 'color', match: (n) => /^--hd-border/.test(n) && !n.includes('width') },
  { title: 'Interactive', kind: 'color', match: (n) => /^--hd-(hover|active|selected)$/.test(n) },
  { title: 'Shape', kind: 'plain', match: (n) => /^--hd-(radius|border-width)/.test(n) },
  { title: 'Type', kind: 'plain', match: (n) => /^--hd-(text|heading|line|weight|font)/.test(n) },
  { title: 'Measure', kind: 'plain', match: (n) => /^--hd-(control-h|row-h|column)/.test(n) },
  { title: 'Motion', kind: 'plain', match: (n) => /^--hd-(ease|duration)/.test(n) },
  { title: 'Elevation', kind: 'plain', match: (n) => /^--hd-shadow/.test(n) },
  { title: 'Layer', kind: 'plain', match: (n) => /^--hd-z-/.test(n) },
  // The component layer, listed last because it is the one a redesign edits
  // first: every name here is a value a primitive would otherwise hard-code.
  {
    title: 'Button',
    kind: 'plain',
    match: (n) => /^--hd-btn-/.test(n) && !/(fill|border|foreground)$/.test(n),
  },
  { title: 'Button colour', kind: 'color', match: (n) => /^--hd-btn-.*(fill|border|foreground)$/.test(n) },
  { title: 'Chip', kind: 'plain', match: (n) => n === '--hd-chip-radius' },
  { title: 'Chip colour', kind: 'color', match: (n) => n === '--hd-chip-fill' },
  // Named for the layer, not the thing: this is the component tier, and the
  // foundation tier above already spends the bare word `Surface`. Two groups
  // under one title also collided as a React key, so one of them rendered.
  {
    title: 'Surface shape',
    kind: 'plain',
    match: (n) => /^--hd-(surface-radius|surface-shadow|hairline)/.test(n),
  },
  {
    title: 'Surface colour',
    kind: 'color',
    match: (n) => n === '--hd-surface-fill' || n === '--hd-scrim',
  },
]

/**
 * How to draw one token, decided from its own name and value rather than
 * trusted to its group.
 *
 * A group's `kind` says what most of its tokens are, and it used to be taken
 * as gospel for every name the group's regex happened to match — which is how
 * `--hd-card-padding` and `--hd-card-radius` ended up in "Surface" (matched on
 * the `card` prefix) and drawn as colour swatches, one of them a 16px padding
 * value with a coloured square that meant nothing. `shadow` and `radius` are
 * pulled out by name first because both live inside colour-shaped groups
 * (`Button colour`, `Surface`) the same way; `color` is trusted only once the
 * value itself reads as one, so a stray non-colour caught by a group's regex
 * falls through to a plain value instead of a lying swatch.
 */
export type TokenVisual = 'color' | 'space' | 'radius' | 'shadow' | 'size'

const COLOR_VALUE = /^(#|rgb|hsl|color-mix)/i

export const tokenVisual = (
  name: string,
  groupKind: 'color' | 'space' | 'plain',
  value: string,
): TokenVisual => {
  if (/shadow/.test(name)) return 'shadow'
  if (/radius/.test(name)) return 'radius'
  if (groupKind === 'space') return 'space'
  if (groupKind === 'color' && (COLOR_VALUE.test(value) || value === 'transparent')) return 'color'
  return 'size'
}

const CLEAN_TOKENS_CSS = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** The names the token file declares, in source order. */
const declaredNames = (): string[] => {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of CLEAN_TOKENS_CSS.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) {
    const name = match[1]
    if (name && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/**
 * Each token's first declared value, verbatim, in source order.
 *
 * A handful of tokens — `--hd-card-fill`, `--hd-card-border`,
 * `--hd-card-divider`, `--hd-card-radius` — are declared only inside the
 * Studio interface's block, so under Desk `getComputedStyle` has never heard
 * of them: nothing sets them on `body` at all, live or otherwise. This is
 * the fallback for exactly that case — the same declaration a reader would
 * find by opening `tokens.css`, not a second source of truth for a token the
 * document actually has an answer for.
 */
const declaredRawValues = (): Map<string, string> => {
  const values = new Map<string, string>()
  for (const match of CLEAN_TOKENS_CSS.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match
    if (name && value && !values.has(name)) values.set(name, value.trim())
  }
  return values
}

/** A value that is nothing but a reference to one other token — `var(--x)`,
 *  optionally with a fallback. Anything else (a `color-mix()`, a literal, a
 *  `calc()`) is returned as itself: it already reads at a glance, and it is
 *  a real CSS value a `background`/`border-radius`/`box-shadow` can use
 *  directly, `var()`s and all — only the *display* value needs unwrapping. */
const BARE_VAR_REF = /^var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/

/**
 * One token's value, resolved the way the app itself would resolve it: ask
 * the live document first, and only when nothing there has ever heard of the
 * token — the Desk/Studio case above — follow its declared text, one
 * `var()` hop at a time, until something answers or the chain runs out.
 * `seen` guards the one thing a hand-written cascade can do that a browser's
 * own would refuse: name itself in its own fallback.
 */
const resolveTokenValue = (
  name: string,
  computed: CSSStyleDeclaration,
  raw: Map<string, string>,
  seen: Set<string> = new Set(),
): string => {
  const live = computed.getPropertyValue(name).trim()
  if (live !== '') return live
  if (seen.has(name)) return ''
  seen.add(name)
  const declared = raw.get(name)
  if (declared == null) return ''
  const ref = BARE_VAR_REF.exec(declared)
  if (ref?.[1] != null) {
    const inner = resolveTokenValue(ref[1], computed, raw, seen)
    if (inner !== '') return inner
    if (ref[2] != null) return ref[2].trim()
  }
  return declared
}

/**
 * What each token resolves to *right now*, asked of the browser.
 *
 * Mostly `getComputedStyle` — the same machinery that paints the app, so
 * what this shows and what the app does cannot disagree — with the
 * declared-text fallback above for the tokens the current interface has not
 * set on `body` at all. Every token gets a value one way or the other: this
 * board's one rule is that a row never shows nothing.
 */
export const useResolvedTokens = (): { name: string; value: string }[] => {
  const [tokens, setTokens] = useState<{ name: string; value: string }[]>([])
  useEffect(() => {
    const read = () => {
      const computed = getComputedStyle(document.body)
      const raw = declaredRawValues()
      setTokens(
        declaredNames().map((name) => ({
          name,
          value: resolveTokenValue(name, computed, raw),
        })),
      )
    }
    read()
    // The theme and foundation switches change these, and both land as
    // attribute or inline-style writes on body.
    const observer = new MutationObserver(read)
    observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-hd-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return tokens
}
