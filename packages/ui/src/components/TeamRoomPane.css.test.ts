import { describe, expect, it } from 'vitest'

import css from './TeamRoomPane.module.css?raw'

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

  it('spends the counts before it spends the name', () => {
    const facts = body('.barFacts')
    // Shrink is weighted: the facts take the whole deficit long before the
    // name gives up a pixel, so a narrowing row loses the numbers and keeps
    // which room it is.
    expect(facts).toMatch(/flex:\s*0 100 auto/)
    expect(facts).toMatch(/min-width:\s*0/)
  })
})
