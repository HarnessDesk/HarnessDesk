import { expect, it } from 'vitest'

import composerCss from './Composer.module.css?raw'
import conversationCss from './Conversation.module.css?raw'
import itemsCss from './Items.module.css?raw'
import roomCss from './TeamRoomPane.module.css?raw'

/**
 * One measure, in both places a person reads a conversation.
 *
 * The app has two surfaces that are a stream of messages with a box to type
 * in underneath: an agent's own transcript, and a room's chat. They are one
 * keystroke apart in the same window, and they were set in two different
 * measures — the transcript in `--hd-column`, the room in whatever the pane
 * happened to be. At a 1030px pane that is 736px against 1015px, for the words
 * *and* for the composer under them, which is the first thing anyone noticed
 * about the pair.
 *
 * It drifted because nothing said they were the same thing. The composer's
 * paint is pinned across its two implementations by `composer.parity.test.ts`
 * — corner, shadow, hairline, the send coin — and every one of those checks
 * passed while the two boxes were 280px apart in width. Paint was watched;
 * measure was not.
 *
 * So this watches the measure. It reads the sheets rather than the screen
 * because jsdom does no layout, which is the same trade `composer.parity`
 * makes, and for the same reason: a string match that fails loudly is worth
 * more than a rendered width nobody can assert on.
 *
 * `--hd-column` is the value itself; it lives in `tokens.css` and is asserted
 * by the token snapshot. What is asserted here is only that these four
 * surfaces read it.
 */

/** The declarations of one rule, as written in the sheet. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} is not in the sheet`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

/** The four surfaces, and where each one is drawn. */
const COLUMN: readonly { readonly what: string; readonly css: string; readonly selector: string }[] =
  [
    { what: "the transcript's turns", css: itemsCss, selector: '.item' },
    { what: "the transcript's composer", css: composerCss, selector: '.shell' },
    { what: "the room's messages", css: roomCss, selector: '.streamColumn' },
    { what: "the room's composer", css: roomCss, selector: '.composerShell' },
  ]

it.each(COLUMN)('$what are set in the app’s reading column', ({ css, selector }) => {
  expect(rule(css, selector)).toContain('max-width: var(--hd-column)')
})

/**
 * And centred in whatever box holds them.
 *
 * The measure is half the claim; the other half is that the two land on one
 * centre line, which is the part a reader actually sees. Every assertion above
 * would pass with the centring deleted — the room's chat would hug the left
 * edge of its scroller and the suite would stay green. That is the same shape
 * of hole this file was written about: `composer.parity.test.ts` pinned the
 * paint and missed the measure; pinning the measure and missing the placement
 * is how it would happen again.
 */
it.each(COLUMN)('$what are centred on the pane', ({ css, selector }) => {
  expect(rule(css, selector)).toMatch(/margin(?:-inline)?:\s*(?:0\s+)?auto/)
})

/**
 * The room's alert line is a docked item, and is measured like one.
 *
 * It is rendered in `.body`, outside both the stream and the composer, so a
 * plain `max-width: var(--hd-column)` on it is the column's number without the
 * column's inset: at a 666px body it came out 666px against the messages'
 * 602px, 32px proud on each side, and the room only clears that above a
 * ~1032px pane because the 232px rail comes off the pane first. `.turnError`
 * in the conversation gets away with the plain form because it is rendered
 * *inside* the scroller; this one is not.
 */
it('the room’s alert line is measured as the dock, not as the stream', () => {
  const trouble = rule(roomCss, '.trouble')
  expect(trouble).toContain('var(--room-dock)')
  expect(trouble).toContain('max-width: calc(var(--hd-column) + 2 * var(--room-dock))')
})

/**
 * Both streams reserve their scrollbar on both edges.
 *
 * A scrolling box gives up its gutter on one side, which moves the centre of
 * anything centred inside it by half a bar — 4px, with this app's 8px
 * scrollbar. The composer below is not a scrolling box and does not move with
 * it, so a column that agrees on width still sat 4px off the box the reader
 * types in. `both-edges` makes the gutter symmetric, and reserves it whether
 * or not there is enough to scroll, so the centre never moves at all.
 */
it.each([
  { what: 'the transcript', css: conversationCss, selector: '.scroll' },
  { what: 'the room’s chat', css: roomCss, selector: '.stream' },
])('$what keeps its column on the pane’s centre line', ({ css, selector }) => {
  expect(rule(css, selector)).toContain('scrollbar-gutter: stable both-edges')
})

/**
 * And what sits under a stream is inset the way the stream is.
 *
 * The reservation above costs the scroller 8px of inset on each edge that a
 * docked composer does not pay, so a column that now agreed on its centre was
 * still 16px narrower than the box under it once the pane fell below the
 * `--hd-column` cap — the same defect, arrived at from the other end. Each
 * dock adds the gutter back, reading the width off the token the scrollbar
 * rule itself lays out.
 */
it.each([
  { what: 'the transcript’s bars', css: conversationCss, selector: '.bars' },
  { what: 'the transcript’s composer', css: composerCss, selector: '.composer' },
  { what: 'the room’s composer', css: roomCss, selector: '.composer' },
  { what: 'the room’s alert line', css: roomCss, selector: '.trouble' },
])('$what is inset by the gutter its stream reserves', ({ css, selector }) => {
  // The room's two docked rules read `--room-dock`, which is that sum
  // named once; the conversation's spell it out. Either is the gutter.
  expect(rule(css, selector)).toMatch(/var\(--hdp-scrollbar-width|var\(--room-dock\)/)
})

/**
 * A bare read of the gutter token is a padding that can silently become zero.
 *
 * `var(--hdp-scrollbar-width)` with the token absent substitutes to
 * `calc(24px + )`, which is invalid at computed-value time — so the whole
 * `padding` falls back to its initial value, `0`, taking the bottom padding
 * with it. Every entry imports `app.css` today, so it is not reachable; the
 * fallback costs nothing and this pins it, because the sheet that declares the
 * token had already gone missing once, from `TOKEN_SOURCES`.
 */
it('every read of the scrollbar gutter carries its own fallback', () => {
  for (const [what, css] of [
    ['Composer.module.css', composerCss],
    ['Conversation.module.css', conversationCss],
    ['TeamRoomPane.module.css', roomCss],
  ] as const) {
    const bare = css.match(/var\(--hdp-scrollbar-width\)/g) ?? []
    expect(bare, `${what} reads --hdp-scrollbar-width with no fallback`).toEqual([])
  }
})
