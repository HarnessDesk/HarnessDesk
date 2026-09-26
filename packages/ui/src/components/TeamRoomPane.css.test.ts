import { describe, expect, it } from 'vitest'

import css from './TeamRoomPane.module.css?raw'
import source from './TeamRoomPane.tsx?raw'
import appCss from '../styles/app.css?raw'

/**
 * Two things about the room's stylesheet that no rendered test in this suite
 * can see, and both of which shipped wrong.
 *
 * Vitest stubs CSS modules to the empty string, and jsdom implements neither
 * container queries nor flexbox sizing — so a component test asserting on
 * either of these would pass while saying nothing at all. They are read as
 * text, for the reason `lights.test.ts` and `chrome.test.ts` give: what is
 * being asserted is that the stylesheet *says* something.
 *
 * Both were found by review rather than by anything here, which is why they
 * are here now.
 */

/** Where a rule's body starts, by selector, or -1. */
const at = (selector: string, from = 0): number => css.indexOf(`${selector} {`, from)

/**
 * A rule's declarations from a given offset, with its comments taken out.
 *
 * These rules explain themselves at length, and every one of those comments
 * quotes the declaration it replaced — so a test matching raw text finds
 * `flex: none` inside the very comment saying why `flex: none` was wrong.
 */
const declarations = (from: number): string =>
  css.slice(from, css.indexOf('}', from)).replace(/\/\*[\s\S]*?\*\//g, '')

/** The same, by selector. */
const body = (selector: string): string => declarations(at(selector))

describe('the column head a narrow room hands back', () => {
  /*
   * `@container` adds no specificity, so between two identical selectors the
   * later one wins — and the exception lived fifty lines *earlier* than the
   * rule it was written to override. Measured in a real engine at a 560px
   * room: the rail was `display: none` and the head was `display: none` with
   * it, leaving a transcript with nothing on screen saying whose it was.
   */
  it('is written after the rule it overrides, or it never wins', () => {
    const base = at(".columns[data-columns='1'] .columnHead")
    expect(base, 'the base rule is gone from this stylesheet').toBeGreaterThan(-1)
    const exception = at(".columns[data-columns='1'] .columnHead", base + 1)
    expect(exception, 'the narrow-room exception is gone from this stylesheet').toBeGreaterThan(-1)

    // The earlier of the two hides it; the later one — inside the container
    // query — brings it back. In that order and no other.
    expect(declarations(base)).toContain('display: none')
    expect(declarations(exception)).toContain('display: flex')

    const query = css.lastIndexOf('@container hd-room', exception)
    expect(query, 'the exception is not inside a container query at all').toBeGreaterThan(base)
  })
})

describe("the room's top row", () => {
  /*
   * `flex: none` on the name meant the row could never be narrower than the
   * room's own name. Measured at a 380px room called "Final round — nine pull
   * requests": the messaging switch and the expand button were pushed 9px past
   * the bar's right edge, with no scroll and no wrap to reach them. The verbs
   * are the one thing on this row that *does* something, and they are never
   * what gives way.
   */
  it('lets the name shrink, so the verbs are never pushed off the end', () => {
    const rule = body('.barName')
    expect(rule, 'a name that cannot shrink pushes the verbs off the row').not.toMatch(
      /flex:\s*none/,
    )
    expect(rule).toMatch(/flex:\s*0 1 auto/)
    // A floor, so the name never vanishes entirely — and a small one, because
    // a floor that can still overflow is not a floor.
    expect(rule).toMatch(/min-width:\s*2rem/)
  })

  it('folds by the same container a conversation header folds by', () => {
    // The window's controls fold their arrows at the width of an `hd-header`;
    // take this line away and the room's simply stop folding, with nothing
    // else in the suite going red.
    expect(body('.bar')).toMatch(/container:\s*hd-header\s*\/\s*inline-size/)
  })

  it('spends the counts before it spends the name', () => {
    const facts = body('.barFacts')
    // Shrink is weighted: the facts take the whole deficit long before the
    // name gives up a pixel, so a narrowing row loses the numbers and keeps
    // which room it is.
    expect(facts).toMatch(/flex:\s*0 100 auto/)
    expect(facts).toMatch(/min-width:\s*0/)
  })
})

describe('watched conversation layout', () => {
  it('gives watched columns a definite full height for their embedded conversations', () => {
    /* `.columnBody` and the Conversation beneath it both size through their
       flex ancestors. Without this definite height on the grid, the columns
       shrink to their headers instead of filling the room body. */
    expect(body('.columns')).toMatch(/height:\s*100%/)
  })
})

describe('appearance ownership', () => {
  it('composes the room roles instead of drawing them, and keeps only geometry in its stylesheet', () => {
    /* A source assertion, because jsdom computes none of the roles' own
       classes: the pane is the view's plate, its top row and a column's head
       are the window's bar, the rail is the sidebar's sections, the presence
       light is the system's dot, and the thread's tail docks with the
       conversation's composer. */
    for (const part of [
      '<PaneSurface',
      '<Bar as="header" corner inset="ink" rule="bottom"',
      '<Bar as="header" rule="bottom"',
      '<RailSection stretch="head" ruled',
      '<RailSection stretch="list"',
      '<NavigationGroupHeader label="Agents">',
      '<Dot state="ready" variant="presence"',
      '<ComposerDock>',
    ]) expect(source, part).toContain(part)
    // No colour, ground, edge or type step is spelled in the stylesheet.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/^\s*(?:color|background[\w-]*|border[\w-]*|box-shadow|font[\w-]*|padding[\w-]*|line-height)\s*:/m)
  })

  it('takes the rail’s edge away only when the narrow room makes the rail the whole pane', () => {
    /* The edge is a `Separator` beside the rail. The same named room
       container that makes the rail the whole pane must drop it, or it leaves
       a stray rule at widths below 38rem. */
    expect(source).toContain('<Separator orientation="vertical" className={styles.railEdge} />')
    const query = css.indexOf('@container hd-room (max-width: 38rem)')
    expect(query).toBeGreaterThan(-1)
    const block = css.slice(query, css.indexOf('\n}\n', query))
    expect(block).toMatch(/\.railEdge\s*\{\s*display:\s*none;?\s*\}/)
  })
})

describe('the narrow rail and the narrow header', () => {
  /** The declarations of the rule for `selector` inside the container query that opens with `query`. */
  const inQuery = (query: string, selector: string): string => {
    const open = css.indexOf(query)
    expect(open, `${query} is gone from this stylesheet`).toBeGreaterThan(-1)
    const block = css.slice(open, css.indexOf('\n}\n', open))
    const at = block.indexOf(`${selector} {`)
    expect(at, `${selector} is not inside ${query}`).toBeGreaterThan(-1)
    return block.slice(at, block.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('drops a roster row to its avatar below a 7rem rail, the name and job staying on its card', () => {
    expect(inQuery('@container hd-room-rail (max-width: 7rem)', '.memberRow [data-slot="list-row-content"]')).toMatch(/display:\s*none/)
  })

  it('never breaks a member’s name or job mid-word, whatever the shared row allows', () => {
    expect(body('.memberRow [data-slot="list-row-subtitle"]')).toMatch(/overflow-wrap:\s*normal/)
  })

  it('folds messaging and Wrap into the More menu below a 22rem header', () => {
    expect(inQuery('@container hd-header (max-width: 22rem)', '.barWrapFull')).toMatch(/display:\s*none/)
    expect(inQuery('@container hd-header (max-width: 22rem)', '.barVerbsCompact')).toMatch(/display:\s*inline-flex/)
    // And outside it the full verbs stand and the menu does not.
    expect(body('.barWrapFull')).toMatch(/display:\s*inline-flex/)
    expect(body('.barVerbsCompact')).toMatch(/display:\s*none/)
  })
})

/**
 * The app's floating notice stack (`.hd-floatingNotices` in `App.tsx`) sits
 * over the whole pane area, starting right under the window's own 46px
 * header — which is also where a room's rail starts. Measured live (#913):
 * with a standing banner showing, its "Board" row was entirely hidden under
 * it and "Chat" was cut through its top half, both unclickable until the
 * banner was dismissed.
 *
 * `Conversation.tsx` already answers this for a plain transcript by reading
 * `--hd-notice-inset` — the height `App.tsx`'s `ResizeObserver` writes onto
 * the pane area — as scroll padding, so its content starts below whatever
 * notice is showing. The rail never read that variable at all, so it never
 * moved. Giving the rail the same padding is what "the rail leaves room for
 * it" (the fix #913 itself offers, alongside sitting only over the reading
 * side) comes down to: Board, Chat and Findings stay below a notice's
 * height, at zero cost when `--hd-notice-inset` is unset.
 */
/**
 * The app's floating notice stack (`.hd-floatingNotices` in `App.tsx`) sits
 * over the whole pane area, starting right under the window's own 46px
 * header — which is also where a room's rail starts. Measured live (#913):
 * with a standing banner showing, its "Board" row was entirely hidden under
 * it and "Chat" was cut through its top half, both unclickable until the
 * banner was dismissed.
 *
 * The fix belongs to the notice system, not the rail, and no longer to the
 * room either: `data-notice-yield` (declared once, in `app.css`, beside
 * `.hd-floatingNotices` itself) reads `--hd-notice-inset` and resets it for
 * what it contains. `Panes.tsx` now composes it once for whatever a pane
 * mounts, so the room's own `.split` no longer carries a copy — one here
 * would only ever read an already-zeroed inset, since the pane host's
 * wrapper sits above it and has spent the variable already.
 */
describe('the room under a standing notice', () => {
  it('carries no `data-notice-yield` of its own — the pane host composes it for every screen now', () => {
    // The name still appears in prose, explaining why it moved; only the
    // JSX attribute itself — the thing that would double the margin — is
    // gone.
    expect(source).not.toMatch(/<[a-zA-Z][^>]*\bdata-notice-yield\b/)
  })

  it('does not keep its own copy of the inset — that is the notice system’s job now', () => {
    expect(body('.rail')).not.toMatch(/margin-top|padding-top/)
    expect(body('.split')).not.toMatch(/margin-top|padding-top/)
  })

  it('is declared once, beside the stack it measures, and reset for whatever it contains', () => {
    expect(appCss).toMatch(/\[data-notice-yield\]\s*{[^}]*margin-top:\s*var\(--hd-notice-inset,\s*0px\)/s)
    expect(appCss).toMatch(/\[data-notice-yield\]\s*>\s*\*\s*{[^}]*--hd-notice-inset:\s*0px/s)
  })
})
