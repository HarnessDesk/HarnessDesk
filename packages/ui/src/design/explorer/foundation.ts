import { useEffect, useState } from 'react'

import tokensCss from '../tokens.css?raw'

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
    id: 'sentence-labels',
    title: 'Sentence labels',
    // The other half of the same question. Uppercase tracked labels are what
    // separates a group from its rows without a rule; they are also louder,
    // and a column with six of them can read as shouted.
    about: 'Group headings back to 13px sentence case, without the tracking.',
    overrides: {
      '--hd-label-size': 'var(--hd-text-sm)',
      '--hd-label-transform': 'none',
      '--hd-label-tracking': '0',
      '--hd-label-weight': 'var(--hd-weight-normal)',
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

/** The names the token file declares, in source order. */
const declaredNames = (): string[] => {
  const names: string[] = []
  const seen = new Set<string>()
  const clean = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of clean.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) {
    const name = match[1]
    if (name && !seen.has(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/**
 * What each token resolves to *right now*, asked of the browser.
 *
 * Not parsed, not cached, not written down anywhere: `getComputedStyle` is
 * the same machinery that paints the app, so what this shows and what the app
 * does cannot disagree.
 */
export const useResolvedTokens = (): { name: string; value: string }[] => {
  const [tokens, setTokens] = useState<{ name: string; value: string }[]>([])
  useEffect(() => {
    const read = () => {
      const computed = getComputedStyle(document.body)
      setTokens(
        declaredNames().map((name) => ({
          name,
          value: computed.getPropertyValue(name).trim(),
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
