import { describe, expect, it } from 'vitest'

import css from './TeamRoomPane.module.css?raw'
import source from './TeamRoomPane.tsx?raw'

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

describe('a conversation opened from the Team', () => {
  it('always carries its identity when there is no Team roster beside it', () => {
    expect(source).toContain('className={styles.columnHead}')
    expect(css).not.toContain(".columns[data-columns='1'] .columnHead")
    expect(body('.columnHead')).toMatch(/flex:\s*none/)
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
      '<ToolPaneHeader ref={headerLayout.ref} variant="window" corner',
      '<Bar as="header" rule="bottom"',
      '<TabsList variant="section"',
      '<RailSection stretch="list"',
      '<NavigationGroupHeader label="Agents">',
      '<Dot state="ready" variant="presence"',
      '<ComposerDock>',
    ]) expect(source, part).toContain(part)
    // No colour, ground, edge or type step is spelled in the stylesheet.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/^\s*(?:color|background[\w-]*|border[\w-]*|box-shadow|font[\w-]*|padding[\w-]*|line-height)\s*:/m)
  })

  it('has no Team rail beside the content at any width', () => {
    expect(source).not.toContain('<aside')
    expect(source).not.toContain('className={styles.railEdge}')
    expect(source).not.toContain('data-showing=')
    expect(body('.tabs')).toMatch(/overflow-x:\s*auto/)
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

  it('keeps member names in the popover rather than a clipped rail', () => {
    expect(css).not.toContain('hd-room-rail')
    expect(source).toContain('data-slot="team-members"')
  })

  it('never breaks a member’s name or job mid-word, whatever the shared row allows', () => {
    expect(body('.memberRow [data-slot="list-row-subtitle"]')).toMatch(/overflow-wrap:\s*normal/)
  })

  it('folds tools according to the measured header, including its portalled menu', () => {
    expect(source).toContain('useNarrowLayout<HTMLElement>(608)')
    expect(source).toContain('hidden={headerLayout.narrow === true}')
    expect(source).toContain('{headerLayout.narrow && <>')
    expect(body('.barWrapFull[hidden]')).toMatch(/display:\s*none/)
  })
})

