import { cva, type VariantProps } from 'class-variance-authority'

/**
 * Two colour vocabularies, and the rule for choosing between them.
 *
 * The survey that produced this layer found one mistake made over and over in
 * admin templates: a single `color` prop doing two unrelated jobs. A green
 * pill meant "passing" on one card and "the Marketplace channel" on the next,
 * and the reader had no way to know which — so the one badge that reported a
 * real failure looked like decoration.
 *
 * The token layer already refused that conflation (see the tints block in
 * tokens.css: "a green avatar must not read as passing"). This file gives the
 * refusal a name in TypeScript, so a component can only be wrong on purpose.
 *
 *   TONE   judges.     Did it work? Is it urgent? Six values, and every one
 *                      of them is a claim about the thing's condition.
 *   TINT   identifies. Which agent, which column, which account. Eight hues
 *                      that mean nothing except "not that other one".
 *
 * A component takes one or the other, never both. `Delta` and `Stat` judge;
 * `IconTile` and `BoardColumn` identify. Where a component genuinely needs
 * both — a board column keyed by hue, holding cards keyed by priority — the
 * two live on different elements and are named differently in the props.
 *
 * Both resolve to `--hd-` tokens and nothing else, so a foundation swap or a
 * palette change carries them. Neither writes a literal colour.
 */

/** What a tone claims about the thing wearing it. */
export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

/** Which thing this is, said in colour. Carries no judgement. */
export type Tint = 'blue' | 'green' | 'amber' | 'violet' | 'rose' | 'teal' | 'orange' | 'sky'

export const TONES: Tone[] = ['neutral', 'brand', 'success', 'warning', 'danger', 'info']
export const TINTS: Tint[] = ['blue', 'green', 'amber', 'violet', 'rose', 'teal', 'orange', 'sky']

/**
 * A tone as a soft ground with readable ink on it — the pill, the tile, the
 * summary block. The fills are the `-dim` tokens, which are already the
 * translucent step the app uses for exactly this; ink is the full-strength
 * colour, except amber, whose own value fails on a light ground and keeps a
 * darker step for text (`--hd-warning-ink`).
 *
 * Written as a cva so the class strings are static text Tailwind's scanner
 * can find. A template literal built from a prop would compile to nothing.
 */
export const softTone = cva('', {
  variants: {
    tone: {
      neutral: 'bg-(--hd-muted) text-(--hd-secondary-foreground)',
      brand: 'bg-(--hd-primary-muted) text-(--hd-primary-ink)',
      success: 'bg-(--hd-success-dim) text-(--hd-success-ink)',
      warning: 'bg-(--hd-warning-dim) text-(--hd-warning-ink)',
      danger: 'bg-(--hd-danger-dim) text-(--hd-danger-ink)',
      info: 'bg-(--hd-tint-sky-fill) text-(--hd-tint-sky-ink)',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

/** The same tone as ink alone, for a glyph or a number on the card's own ground. */
export const inkTone = cva('', {
  variants: {
    tone: {
      neutral: 'text-(--hd-secondary-foreground)',
      brand: 'text-(--hd-primary-ink)',
      success: 'text-(--hd-success-ink)',
      warning: 'text-(--hd-warning-ink)',
      danger: 'text-(--hd-danger-ink)',
      info: 'text-(--hd-tint-sky-ink)',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

/** A tone as a solid dot — a status light, a column marker. */
export const dotTone = cva('', {
  variants: {
    tone: {
      neutral: 'bg-(--hd-muted-foreground)',
      brand: 'bg-(--hd-primary)',
      success: 'bg-(--hd-success)',
      warning: 'bg-(--hd-warning)',
      danger: 'bg-(--hd-danger)',
      info: 'bg-(--hd-tint-sky-ink)',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

/**
 * A tint as a soft ground with readable ink. Identity, not judgement — the
 * triples in tokens.css were designed for this and need no adjustment here.
 */
export const softTint = cva('', {
  variants: {
    tint: {
      blue: 'bg-(--hd-tint-blue-fill) text-(--hd-tint-blue-ink)',
      green: 'bg-(--hd-tint-green-fill) text-(--hd-tint-green-ink)',
      amber: 'bg-(--hd-tint-amber-fill) text-(--hd-tint-amber-ink)',
      violet: 'bg-(--hd-tint-violet-fill) text-(--hd-tint-violet-ink)',
      rose: 'bg-(--hd-tint-rose-fill) text-(--hd-tint-rose-ink)',
      teal: 'bg-(--hd-tint-teal-fill) text-(--hd-tint-teal-ink)',
      orange: 'bg-(--hd-tint-orange-fill) text-(--hd-tint-orange-ink)',
      sky: 'bg-(--hd-tint-sky-fill) text-(--hd-tint-sky-ink)',
    },
  },
  defaultVariants: { tint: 'blue' },
})

/** A tint as a solid dot — the marker on a board column's name. */
export const dotTint = cva('', {
  variants: {
    tint: {
      blue: 'bg-(--hd-tint-blue-ink)',
      green: 'bg-(--hd-tint-green-ink)',
      amber: 'bg-(--hd-tint-amber-ink)',
      violet: 'bg-(--hd-tint-violet-ink)',
      rose: 'bg-(--hd-tint-rose-ink)',
      teal: 'bg-(--hd-tint-teal-ink)',
      orange: 'bg-(--hd-tint-orange-ink)',
      sky: 'bg-(--hd-tint-sky-ink)',
    },
  },
  defaultVariants: { tint: 'blue' },
})

/**
 * The same thing gets the same colour, wherever it is drawn.
 *
 * Small and deterministic on purpose: the same agent must not change colour
 * between the board, the row beneath it, the wedge of a doughnut and its
 * column in a stacked chart. Assigning tints by position instead would make
 * every one of those lie the moment one of them sorted differently — an agent
 * slipping from second place to third would change colour, which reads as a
 * different agent.
 *
 * It lives here rather than beside the first surface that needed it, because
 * "which hue is this thing" is a question the tint vocabulary owns. It was an
 * avatar stack's private helper for a while, which was fine until a chart
 * needed the same answer and nearly wrote a second one.
 *
 * Collisions are fine: two names sharing a hue is a legend's problem, and
 * every surface that uses more than a couple of these draws a legend.
 */
export const tintFor = (name: string): Tint => {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }
  return TINTS[hash % TINTS.length] as Tint
}

/**
 * Tints for a set that has to be told apart.
 *
 * `tintFor` is right where the things are drawn separately — an avatar here, a
 * row there — and wrong where they are drawn *together*: eight hues and three
 * names is a one-in-five chance that two of them collide, and a doughnut with
 * two wedges the same colour beside a legend with two dots the same colour is
 * not a near miss, it is a chart that cannot be read. The first three agents
 * this was tried on drew two shades of orange.
 *
 * So a set gets each member's own hue where it is free and the next free one
 * where it is not. **Two properties, and the difference between them matters:**
 *
 *   Within a set   every member has its own hue, and which hue a member gets
 *                  does not depend on where it sits in the array. The set is
 *                  resolved in name order and mapped back, so a caller that
 *                  re-sorts — by spend, by cost, by anything — gets the same
 *                  answer. Without that, changing the range control re-sorted
 *                  two agents and they swapped colours in the legend.
 *   Between sets   nothing is promised. A member of a smaller set may take a
 *                  hue that a collision pushed it off in a larger one, so a
 *                  caller that wants one thing to keep one colour across
 *                  several surfaces must resolve the set ONCE, over a stable
 *                  universe — every known agent, not the handful currently on
 *                  screen — and look up from that. `Usage.tsx` does exactly
 *                  this, and the reason is written there.
 *
 * Past eight members the palette repeats; a chart with nine series has a
 * bigger problem than colour.
 */
export const tintsFor = (keys: readonly string[]): Tint[] => {
  const taken = new Set<Tint>()
  const claimed = new Map<string, Tint>()
  // Name order, not the caller's order: the assignment is a property of the
  // set's membership, and a list that re-sorts is the same set.
  for (const key of [...new Set(keys)].sort()) {
    const first = TINTS.indexOf(tintFor(key))
    for (let step = 0; step < TINTS.length; step += 1) {
      const candidate = TINTS[(first + step) % TINTS.length] as Tint
      if (!taken.has(candidate)) {
        taken.add(candidate)
        claimed.set(key, candidate)
        break
      }
    }
    if (!claimed.has(key)) claimed.set(key, tintFor(key))
  }
  return keys.map((key) => claimed.get(key) as Tint)
}

export type ToneProps = VariantProps<typeof softTone>
export type TintProps = VariantProps<typeof softTint>
