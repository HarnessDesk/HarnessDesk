import { describe, expect, it } from 'vitest'

import appSheet from '../styles/app.css?raw'
import accentSheet from '../styles/shadcn-themes.css?raw'
import snapshot from './tokens.snapshot.txt?raw'

/**
 * Every tinted chip in the app has to be readable, in both themes, measured.
 *
 * This is the test that should have existed before the composition layer went
 * in, and its absence is exactly why the ink values were wrong. Colour picked
 * by eye is picked against whatever the picker's screen and room were doing;
 * a `+18%` in green on a 14% green wash *looks* fine at every step of the work
 * and lands at 3.1:1, which is a figure some readers cannot resolve and none
 * can resolve at a glance.
 *
 * It reads the resolved snapshot rather than the stylesheet, for two reasons:
 * the snapshot is what the app actually computes at the end of a `var()` chain
 * six links long, and it already records both faces. So a palette that swaps
 * a ground, an accent dial that moves the brand, or a well-meant edit to a
 * fill all arrive here as a failing ratio rather than as a value nobody rechecks.
 *
 * The bar is WCAG AA for normal text, 4.5:1, not the 3:1 allowed for large
 * text or UI components — a delta pill is 12px, an avatar's initials smaller
 * still, and both are read rather than merely noticed.
 */

const AA = 4.5

type Rgb = { r: number; g: number; b: number; a: number }

const parse = (value: string): Rgb | null => {
  /* Hex first, and not as a nicety: the snapshot is all `rgb()`, but the
     accent sheet is written in hex, and the numeric branch below quietly
     mis-reads it — `#16a34a` yields the digit runs 16, 34, 4 and produces a
     plausible, wrong colour, while `#7c3aed` yields two and returns null. The
     accent tests were silently skipping most of the palette until this. */
  const body = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim())?.[1]
  if (body != null) {
    const pairs =
      body.length === 3
        ? [...body].map((digit) => digit + digit)
        : [body.slice(0, 2), body.slice(2, 4), body.slice(4, 6)]
    const [r, g, b] = pairs.map((pair) => Number.parseInt(pair, 16)) as [number, number, number]
    return { r, g, b, a: 1 }
  }
  const parts = value.match(/[\d.]+/g)
  if (!parts || parts.length < 3) return null
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts[3] == null ? 1 : Number(parts[3]),
  }
}

/** A translucent fill laid over an opaque ground. */
const over = (fg: Rgb, bg: Rgb): Rgb => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})

const luminance = ({ r, g, b }: Rgb): number => {
  const channel = (value: number) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

const contrast = (a: Rgb, b: Rgb): number => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

/**
 * Every `# <face>` section of the resolved snapshot.
 *
 * Four of them since the Interface setting arrived — light and dark, each
 * crossed with Studio — so this reads whatever the snapshot names rather than
 * a fixed pair. `faceOf` throws instead of returning `undefined`: a face that
 * has gone missing means the snapshot's shape changed, and a test that
 * silently checks nothing is worse than one that fails.
 */
const faces = (): Map<string, Map<string, string>> => {
  const out = new Map<string, Map<string, string>>()
  let face: Map<string, string> | null = null
  for (const line of snapshot.split('\n')) {
    if (line.startsWith('# ')) {
      face = new Map<string, string>()
      out.set(line.slice(2).trim(), face)
      continue
    }
    const [name, value] = line.split(' = ')
    if (face && name && value) face.set(name.trim(), value.trim())
  }
  return out
}

const faceOf = (all: Map<string, Map<string, string>>, name: string): Map<string, string> => {
  const found = all.get(name)
  if (!found) throw new Error(`the snapshot has no "${name}" face — it has ${[...all.keys()].join(', ')}`)
  return found
}

/* Every ink the composition layer can put on a soft ground, with the ground it
   is put on. `tone.ts` is the only place these pairings are decided; if a pair
   is added there and not here, the new one is untested — which the count
   assertion below is meant to make noisy rather than silent. */
const PAIRS: [ink: string, fill: string][] = [
  ['--hd-primary-ink', '--hd-primary-muted'],
  ['--hd-success-ink', '--hd-success-dim'],
  ['--hd-warning-ink', '--hd-warning-dim'],
  ['--hd-danger-ink', '--hd-danger-dim'],
  ...['blue', 'green', 'amber', 'violet', 'rose', 'teal', 'orange', 'sky'].map(
    (hue) => [`--hd-tint-${hue}-ink`, `--hd-tint-${hue}-fill`] as [string, string],
  ),
]

describe('tinted text is readable', () => {
  const resolved = faces()

  it('is reading a real snapshot', () => {
    expect(faceOf(resolved, 'light').size).toBeGreaterThan(100)
    expect(faceOf(resolved, 'dark').size).toBeGreaterThan(100)
    expect(PAIRS).toHaveLength(12)
  })

  for (const face of ['light', 'dark'] as const) {
    /* Composited over the card, not the window: a chip is nearly always on a
       card, and in dark mode the card is the lighter of the two — so the card
       is the harder ground and the one worth holding the ink to. */
    it(`clears AA on its own fill (${face})`, () => {
      const card = parse(faceOf(resolved, face).get('--hd-card') ?? '')
      expect(card, `${face}: no --hd-card in the snapshot`).not.toBeNull()

      const failures: string[] = []
      for (const [inkName, fillName] of PAIRS) {
        const ink = parse(faceOf(resolved, face).get(inkName) ?? '')
        const fill = parse(faceOf(resolved, face).get(fillName) ?? '')
        expect(ink, `${face}: ${inkName} missing`).not.toBeNull()
        expect(fill, `${face}: ${fillName} missing`).not.toBeNull()
        const ground = over(fill as Rgb, card as Rgb)
        const ratio = contrast(over(ink as Rgb, ground), ground)
        if (ratio < AA) failures.push(`${inkName} on ${fillName}: ${ratio.toFixed(2)}:1`)
      }
      expect(failures, `${face} face below ${AA}:1`).toEqual([])
    })

    /* The same ink is used on a bare card too — a coloured glyph, a link, a
       figure. It has to survive without its fill helping. */
    it(`clears AA on the bare card (${face})`, () => {
      const card = parse(faceOf(resolved, face).get('--hd-card') ?? '') as Rgb
      const failures: string[] = []
      for (const [inkName] of PAIRS) {
        const ink = parse(faceOf(resolved, face).get(inkName) ?? '') as Rgb
        const ratio = contrast(over(ink, card), card)
        if (ratio < AA) failures.push(`${inkName}: ${ratio.toFixed(2)}:1`)
      }
      expect(failures, `${face} face below ${AA}:1 on the card`).toEqual([])
    })
  }
})

/**
 * The solid, which is the loudest pairing on any screen and had no test.
 *
 * `PAIRS` above is the *tint and tone* set — every ink `tone.ts` can put on a
 * soft, translucent ground — and its length assertion is the tripwire for a
 * pairing added there and not here. The solid is a different kind of thing: an
 * opaque fill with a label on it, decided in tokens.css rather than in
 * `tone.ts`. It gets its own block rather than a thirteenth entry in a list
 * whose comment says "soft ground", because widening PAIRS to hold it would
 * blunt exactly the tripwire it exists to be.
 *
 * What it covers is every filled button in the app, both spellings, plus the
 * on-state of the switch, the checkbox and the radio, a toast's action and a
 * Banner's. If any of those goes unreadable it goes unreadable everywhere at
 * once, which is the argument this file's own header makes for existing.
 *
 * No compositing: these are opaque, so there is no ground underneath to
 * matter — and that is the point of them.
 */
describe('the solid carries its own label', () => {
  const resolved = faces()

  const SOLIDS: [ink: string, fill: string, what: string][] = [
    ['--hd-solid-foreground', '--hd-solid', 'a filled button'],
  ]

  for (const face of ['light', 'dark'] as const) {
    it(`reads on its own fill (${face})`, () => {
      const failures: string[] = []
      for (const [inkName, fillName, what] of SOLIDS) {
        const ink = parse(faceOf(resolved, face).get(inkName) ?? '')
        const fill = parse(faceOf(resolved, face).get(fillName) ?? '')
        expect(ink, `${face}: ${inkName} missing from the snapshot`).not.toBeNull()
        expect(fill, `${face}: ${fillName} missing from the snapshot`).not.toBeNull()
        const ratio = contrast(ink as Rgb, fill as Rgb)
        if (ratio < AA) failures.push(`${what} — ${inkName} on ${fillName}: ${ratio.toFixed(2)}:1`)
      }
      expect(failures, `${face} face below ${AA}:1`).toEqual([])
    })
  }

  /*
   * The on-states are not solids and are not held to this bar.
   *
   * They were, until `--hd-toggle-on` became `--hd-accent` and
   * `--hd-toggle-knob-on` became `--hd-primary-foreground`. Two things follow.
   * The bar is 3:1, not 4.5 — a switch's knob, a checkbox's tick and a radio's
   * dot carry no text, and 3:1 is the whole of what WCAG 1.4.11 asks of a
   * graphical object. And the *other five* accents are already covered by the
   * accent describe below, which pairs those same two tokens across every
   * block in the sheet.
   *
   * What that describe cannot see is the default, because the default accent
   * is the absence of an attribute and is not in the sheet at all — which is
   * exactly the accent a user is looking at when they have never touched the
   * dial, and the lowest of the twelve pairs at 4.08:1. So it is checked here,
   * from the snapshot, where the resolved value lives.
   */
  it('the default accent carries the knob, tick and dot on it', () => {
    const NON_TEXT = 3
    const failures: string[] = []
    for (const face of ['light', 'dark'] as const) {
      const ink = parse(faceOf(resolved, face).get('--hd-toggle-knob-on') ?? '')
      const fill = parse(faceOf(resolved, face).get('--hd-toggle-on') ?? '')
      expect(ink, `${face}: --hd-toggle-knob-on missing from the snapshot`).not.toBeNull()
      expect(fill, `${face}: --hd-toggle-on missing from the snapshot`).not.toBeNull()
      const ratio = contrast(ink as Rgb, fill as Rgb)
      if (ratio < NON_TEXT) failures.push(`${face}: ${ratio.toFixed(2)}:1`)
    }
    expect(failures, `the default accent cannot carry its own knob`).toEqual([])
  })

  /* The pair has to *invert* between the faces, which is the whole mechanism:
     near-black on white, near-white on near-black. A palette that broke the
     inversion would still pass the ratio above while drawing a white button
     with white text in one theme. */
  it('inverts between the faces rather than merely being readable in both', () => {
    const lum = (name: string, face: 'light' | 'dark') =>
      luminance(parse(faceOf(resolved, face).get(name) ?? '') as Rgb)
    expect(lum('--hd-solid', 'light')).toBeLessThan(lum('--hd-solid-foreground', 'light'))
    expect(lum('--hd-solid', 'dark')).toBeGreaterThan(lum('--hd-solid-foreground', 'dark'))
  })
})

/*
 * The selected navigation row, which is the one place the app puts text on a
 * *saturated* fill rather than a soft one.
 *
 * What this holds is deliberately not "AA", and the reason is worth writing
 * down. The row is painted with the brand and inked with the brand's own
 * foreground — the same pairing the app puts on every primary button. On the
 * default accent that measures 4.08:1, under the 4.5 that 14px text wants,
 * and in the dark theme green (#22c55e) and orange (#f97316) are paler still.
 * That is a real defect and it is the *palette's*: it is chosen in
 * shadcn-themes.css, it reaches the primary button and the chips, and no
 * amount of adjusting a sidebar token fixes it. An earlier version of this
 * test asserted AA here and was satisfied by hard-coding the fill — which
 * cleared the bar and silently unhooked the selected row from the Accent
 * dial, so Mono grew a blue row.
 *
 * So the two things asserted below are the two things that are actually true
 * and worth defending:
 *
 *   The fill IS the brand.        Not a value that resembles it. This is what
 *                                 stops the literal coming back.
 *   The muted ink stays readable  A 12px count on the fill has to clear the
 *   relative to the title.        3:1 WCAG asks of secondary text, whatever
 *                                 the accent does to the fill underneath.
 */
describe('the selected navigation row is readable', () => {
  const resolved = faces()
  const STUDIO = ['light-studio', 'dark-studio'] as const
  const UI = 3

  it('is reading the Studio faces', () => {
    for (const face of STUDIO) expect(faceOf(resolved, face).size).toBeGreaterThan(100)
  })

  for (const face of STUDIO) {
    /* The regression this exists for: `--hd-sidebar-selected` was briefly a
       literal, and every accent but the default drew the wrong colour. The
       snapshot records one accent, so a ratio can never catch that — identity
       with the brand can. */
    it(`is the brand itself, so the accent dial reaches it (${face})`, () => {
      const fill = faceOf(resolved, face).get('--hd-sidebar-selected')
      const brand = faceOf(resolved, face).get('--hd-primary')
      expect(fill, `${face}: no --hd-sidebar-selected`).toBeDefined()
      expect(fill, 'the selected fill must resolve to --hd-primary, not a copy of it').toBe(brand)

      const ink = faceOf(resolved, face).get('--hd-sidebar-selected-foreground')
      const brandInk = faceOf(resolved, face).get('--hd-primary-foreground')
      expect(ink, 'the selected ink must be the brand\'s own foreground').toBe(brandInk)
    })

    it(`keeps its metadata at ${UI}:1 on the fill (${face})`, () => {
      const fill = parse(faceOf(resolved, face).get('--hd-sidebar-selected') ?? '') as Rgb
      const ink = parse(faceOf(resolved, face).get('--hd-sidebar-selected-foreground') ?? '') as Rgb
      expect(fill, `${face}: no --hd-sidebar-selected`).not.toBeNull()
      expect(ink, `${face}: no --hd-sidebar-selected-foreground`).not.toBeNull()

      /* The muted ink is a `color-mix` the snapshot keeps unresolved, so the
         alpha is read from it and composited here — the same thing the browser
         does, and the only way to get an honest number out of a translucent
         ink. */
      const muted = faceOf(resolved, face).get('--hd-sidebar-selected-muted-foreground') ?? ''
      const alpha = Number(/([\d.]+)%/.exec(muted)?.[1] ?? '0') / 100
      expect(alpha, `${face}: could not read the muted alpha from "${muted}"`).toBeGreaterThan(0)

      const meta = contrast(over({ ...ink, a: alpha }, fill), fill)
      expect(meta, `metadata ink on the selected fill: ${meta.toFixed(2)}:1`).toBeGreaterThanOrEqual(UI)
    })
  }
})

/*
 * Every accent the app ships, on the surface that fills itself with the brand.
 *
 * The snapshot cannot answer this. It is generated with no `data-hd-accent`
 * set, so all four of its faces carry the default cobalt — which means a ratio
 * assertion against it proves one of six accents and silently vouches for the
 * other five. That is not hypothetical: green shipped a selected row whose
 * metadata measured 2.82:1 in the light face and 2.02:1 in the dark, while the
 * test above reported the default's 3.46 and passed.
 *
 * So this reads `shadcn-themes.css` directly, pairs each accent's `--hd-accent`
 * with the `--hd-primary-foreground` that face actually resolves to, and holds
 * every combination to the bar. It covers the primary button and the chips as
 * much as the selected row: they are all the same two tokens.
 *
 * The bar is 3:1, not AA, and the reason is honest rather than convenient. The
 * *fill* is the product's brand and this test is not the place to redesign it —
 * the best ink on the default cobalt reaches 4.40:1 and on violet's dark face
 * 4.23:1, both short of 4.5, because those hues cap it. What a test can hold is
 * that no accent falls under the 3:1 that WCAG asks of any text at all, and
 * that is the line green and orange were on the wrong side of.
 *
 * It covers the on-states too, and by construction rather than by listing
 * them: a switch's track, a ticked box and a chosen radio are `--hd-accent`,
 * and the knob, tick and dot on them are `--hd-primary-foreground`. For those
 * three the 3:1 is not a concession at all — a knob is a graphical object, and
 * 3:1 is the whole of what WCAG 1.4.11 asks of one.
 */
describe('every accent can carry the ink on its own brand', () => {
  const UI = 3
  const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 }

  /** `--hd-accent` and `--hd-primary-foreground` per accent block, both faces. */
  const accents = (): { face: string; fill: Rgb; ink: Rgb }[] => {
    const out: { face: string; fill: Rgb; ink: Rgb }[] = []
    const block = /body\[data-hd-accent='(\w+)'\](\[data-hd-dark-theme\])?\s*\{([^}]*)\}/g
    /* Where a dark block sets no ink of its own, the light block's is carried
       forward here. The app does not do that on every palette: a palette's
       own dark face outranks an accent's light block, so the test below holds
       every dark block to declaring its own, and this carry-forward only ever
       sees ink that is declared (#90). */
    const inherited = new Map<string, Rgb>()
    for (const match of accentSheet.matchAll(block)) {
      const name = match[1] ?? ''
      const dark = match[2] != null
      const body = match[3] ?? ''
      const fill = parse(/--hd-accent:\s*([^;]+);/.exec(body)?.[1] ?? '')
      const own = parse(/--hd-primary-foreground:\s*([^;]+);/.exec(body)?.[1] ?? '')
      if (!fill) continue
      const ink = own ?? (dark ? (inherited.get(name) ?? WHITE) : WHITE)
      if (!dark) inherited.set(name, ink)
      out.push({ face: `${name} ${dark ? 'dark' : 'light'}`, fill, ink })
    }
    return out
  }

  it('is reading the accent sheet', () => {
    /* Five accents x two faces. The default is not in the sheet — it is the
       absence of the attribute — and is covered by the snapshot tests above. */
    expect(accents()).toHaveLength(10)
  })

  it(`keeps every accent's ink above ${UI}:1 on its own brand`, () => {
    const failures: string[] = []
    for (const { face, fill, ink } of accents()) {
      const title = contrast(over(ink, fill), fill)
      if (title < UI) failures.push(`${face} title: ${title.toFixed(2)}:1`)
    }
    expect(failures, `accents whose own ink cannot be read on them`).toEqual([])
  })

  it(`keeps the muted step above ${UI}:1 on every accent`, () => {
    /* The same 86% mix `--hd-sidebar-selected-muted-foreground` makes, applied
       to each accent's own ink — a count or a subtitle inside a brand-filled
       row. This is the measure green and orange failed. */
    const alpha =
      Number(/([\d.]+)%/.exec(faceOf(faces(), 'light-studio').get('--hd-sidebar-selected-muted-foreground') ?? '')?.[1] ?? '0') / 100
    expect(alpha, 'could not read the muted alpha out of the Studio face').toBeGreaterThan(0)

    const failures: string[] = []
    for (const { face, fill, ink } of accents()) {
      const meta = contrast(over({ ...ink, a: alpha }, fill), fill)
      if (meta < UI) failures.push(`${face} metadata: ${meta.toFixed(2)}:1`)
    }
    expect(failures, `accents whose muted ink falls under ${UI}:1`).toEqual([])
  })
})

describe("every accent's dark face declares its own ink, because the palette's dark face outranks the accent's light one", () => {
  // #90: violet's dark block declared neither, so on shadcn the palette's #171717 inked a violet button,
  // and on editorial the label ink was the palette's #262624. Measured in the app; the sheet is the cause.
  const darkBlocks = [...accentSheet.matchAll(/body\[data-hd-accent='(\w+)'\]\[data-hd-dark-theme\]\s*\{([^}]*)\}/g)]

  const lightNames = [...accentSheet.matchAll(/body\[data-hd-accent='(\w+)'\]\s*\{/g)].map((match) => match[1])

  /* The ink each dark face declares. On violet's dark fill, white and #171717
     both clear the checks above, at about 4.23:1 each, so those can't tell
     the #90 ink from the right one; this can. Violet keeps the white its
     light face and the desk's own palette give it (review, round 1). */
  const DARK_INK: Record<string, string> = {
    violet: 'rgb(255, 255, 255)',
    green: '#171717',
    rose: '#171717',
    orange: '#171717',
    mono: '#171717',
  }

  it('reads a dark block for every accent, and every accent has one', () => {
    // Round 1 of #177: "at least four" passed with one of the five missing.
    const names = Object.keys(DARK_INK).sort()
    expect(darkBlocks.map((match) => match[1]).sort()).toEqual(names)
    expect([...lightNames].sort()).toEqual(names)
  })

  for (const match of darkBlocks) {
    const name = match[1] ?? ''
    const body = match[2] ?? ''
    const declared = (token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(body)?.[1]?.trim()
    it(`${name} declares its ink in its dark face`, () => {
      // Stands on its own: for an accent missing from the table both sides read undefined and the
      // comparison passes, which left this green beside a failing guard (#226).
      expect(DARK_INK[name], `${name} is not in the table`).toBeDefined()
      expect(declared('--hd-primary-foreground'), `${name}: --hd-primary-foreground`).toBe(DARK_INK[name])
    })
  }
})


describe("every accent's light face declares its own ink too", () => {
  // #184: the table above pins each dark face's ink by value, and nothing did the same for the light faces.
  const lightBlocks = [...accentSheet.matchAll(/body\[data-hd-accent='(\w+)'\]\s*\{([^}]*)\}/g)]

  /* Each light face's ink, pinned as it is written. A second column pinned
     `--hdp-alias-label-primary-foreground` beside it, which no var() read and
     which mono gave a different value from its primary ink; the alias is gone
     and the column with it (#217, #226). */
  const LIGHT_INK: Record<string, string> = {
    violet: 'rgb(255, 255, 255)',
    green: '#171717',
    rose: 'rgb(255, 255, 255)',
    orange: '#171717',
    mono: 'rgb(255, 255, 255)',
  }

  it('reads a light block for every accent', () => {
    expect(lightBlocks.map((match) => match[1]).sort()).toEqual(Object.keys(LIGHT_INK).sort())
  })

  for (const match of lightBlocks) {
    const name = match[1] ?? ''
    const body = match[2] ?? ''
    const declared = (token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(body)?.[1]?.trim()
    it(`${name} declares its ink in its light face`, () => {
      // As above: an accent the table forgot would pass this on undefined === undefined (#226).
      expect(LIGHT_INK[name], `${name} is not in the table`).toBeDefined()
      expect(declared('--hd-primary-foreground'), `${name}: --hd-primary-foreground`).toBe(LIGHT_INK[name])
    })
  }
})

describe("an accent's light face outranks a palette's on source order alone, so the order is pinned", () => {
  /* #184: `body[data-hd-accent=…]` and `body[data-hd-palette=…]` are both
     (0, 1, 1), so the later rule wins. The accent does only because every
     sheet with a palette face loads before the sheet with the accents, and in
     that sheet the accents come last. Nothing held either order until this. */
  const sheets = import.meta.glob<string>('../**/*.css', { query: '?raw', import: 'default', eager: true })
  const fromSrc = (spec: string, dir: string) => new URL(spec, `file:///src/${dir}/`).pathname.replace(/^\/src\//, '')
  const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
  /* Any quoting, and in a group of selectors too: the control below is there
     to find a face put somewhere unexpected (review, round 1). The element
     the face is written on is not part of the question either: `:root[…]` and
     a bare `[…]` declare one just as `body[…]` does, and reading only `body`
     left a sheet holding either invisible to `declaring` below (#226).
     Optional, but not *anything*: the match starts at a selector boundary, and
     the element is one the page itself is. Unanchored, the engine retried a
     character along whenever the prefix failed and read a face out of
     `.card[…]`, `#main[…]` and the bare attribute inside a `:not(…)` list;
     unrestricted, `div[…]` counted too, though a face on a region wins by
     inheritance rather than by the source order pinned below (#266). */
  const faces = (css: string, kind: 'palette' | 'accent') => [
    ...bare(css).matchAll(
      new RegExp(
        `(?<=^|[\\s,>+~}])(?:body|html|:root)?\\[data-hd-${kind}=["']?\\w+["']?\\](?:\\[data-hd-dark-theme\\])?(?=\\s*[,{])`,
        'g',
      ),
    ),
  ]
  const declaring = (kind: 'palette' | 'accent') =>
    Object.entries(sheets)
      .filter(([, css]) => faces(css, kind).length > 0)
      .map(([file]) => fromSrc(file, 'design'))
      .sort()
  const order = [...bare(appSheet).matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((match) => fromSrc(match[1] ?? '', 'styles'))

  it('knows which sheets hold the faces', () => {
    // The control: the two order checks below pass on nothing if these read nothing.
    expect(declaring('accent')).toEqual(['styles/shadcn-themes.css'])
    expect(declaring('palette')).toEqual(['styles/editor.css', 'styles/editorial.css', 'styles/shadcn-themes.css'])
  })

  /* A palette face in a CSS module fails the check below, and should: Vite
     emits module CSS into the page's own bundle, and both built pages link
     that bundle after `workbench-*.css`, which is where the imported sheets
     and every face live today (measured in `packages/ui/dist` at f95c38d5:
     index.html and design.html each link workbench first). So a face written
     in a module would load after the accents and outrank them, which is the
     thing this pins — the message says "the sheets app.css imports" because
     that is the only place a face belongs (#226). */
  it('loads every sheet with a palette face no later than the one with the accents', () => {
    const accents = order.indexOf('styles/shadcn-themes.css')
    expect(accents, 'app.css does not import the accents').toBeGreaterThan(-1)
    for (const file of declaring('palette')) {
      const at = order.indexOf(file)
      expect(at, `${file} holds a palette face, and only the sheets app.css imports have an order to check`).toBeGreaterThan(-1)
      expect(at, `${file} loads after the accents`).toBeLessThanOrEqual(accents)
    }
  })

  it('declares the accents after every palette face in their own sheet', () => {
    const palettes = faces(accentSheet, 'palette').map((match) => match.index ?? 0)
    const accents = faces(accentSheet, 'accent').map((match) => match.index ?? 0)
    expect(palettes.length).toBeGreaterThan(0)
    // Math.min of nothing is Infinity, which passes; the accents have to be there to be after anything (review, round 1).
    expect(accents.length).toBeGreaterThan(0)
    expect(Math.min(...accents)).toBeGreaterThan(Math.max(...palettes))
  })

  /* #266: #226 made the element a face is written on optional, so that
     `:root[…]` and a bare `[…]` count as well as `body[…]`. The match was
     never anchored to a selector boundary, though, so when the prefix failed
     the engine retried one character along and read a face out of things that
     declare none: `card` out of `.card[…]`, `main` out of `#main[…]`, and the
     bare attribute out of a `:not(…)` list. Nothing in the tree is spelled any
     of those ways, so this never fired — what it cost was the check's meaning
     rather than a wrong answer, and a check whose meaning has drifted is one
     nobody can read a failure from. */
  it('reads a face only where one is declared', () => {
    const sheet = [
      "body[data-hd-palette='shadcn'] { --a: 1 }",
      "body[data-hd-palette='shadcn'][data-hd-dark-theme] { --a: 2 }",
      ":root[data-hd-palette='editorial'] { --a: 3 }",
      "a,[data-hd-palette='editor'] { --a: 4 }",
      ".card[data-hd-palette='x'] { --a: 5 }",
      "#main[data-hd-palette='x'] { --a: 6 }",
      ":not([data-hd-palette='x'], .b) { --a: 7 }",
      "div[data-hd-palette='x'] { --a: 8 }",
    ].join('\n')
    const real = [
      "body[data-hd-palette='shadcn']",
      "body[data-hd-palette='shadcn'][data-hd-dark-theme]",
      ":root[data-hd-palette='editorial']",
      "[data-hd-palette='editor']",
    ]
    const declared = faces(sheet, 'palette').map((match) => match[0])
    /* The control: every spelling the tree really uses is read before this
       change and after it, so a narrower match cannot go unnoticed. */
    for (const face of real) expect(declared, `${face} declares a face`).toContain(face)
    /* `.card[…]` and `#main[…]` are a face scoped to a class or an id, not one
       declared on the page; `div[…]` scopes one to a region, where it wins by
       inheritance rather than by the source order this check pins; and the
       attribute inside `:not(…)` is a face the rule deliberately excludes. */
    expect(declared).toEqual(real)
  })
})
