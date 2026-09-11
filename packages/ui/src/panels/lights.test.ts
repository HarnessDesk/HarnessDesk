import { describe, expect, it } from 'vitest'

import conversationCss from '../components/Conversation.module.css?raw'
import panesCss from '../components/Panes.module.css?raw'
import sidebarCss from '../components/Sidebar.module.css?raw'
import teamRoomCss from '../components/TeamRoomPane.module.css?raw'
import toolPanesCss from '../components/ToolPanes.module.css?raw'
import workbenchCss from './Workbench.module.css?raw'
import dockPanel from '../design/patterns/DockPanel.tsx?raw'
import appCss from '../styles/app.css?raw'

/**
 * Room for the macOS window buttons, held to one mechanism.
 *
 * The buttons are the window server's, drawn over the app's top-left corner
 * whatever is there — so exactly one row in the window has to start after
 * them, and which row that is moves: the sidebar's title bar while the sidebar
 * is up, a conversation's header when it is away, a repository's or a
 * terminal's own header when one of those fills the window, a panel's tab
 * strip when it wears one.
 *
 * Every one of those used to be a separate decision, and only two of them were
 * ever made: the sidebar and the conversation each asked `sidebarCollapsed &&
 * hasTrafficLights()` for themselves, and everything else printed its title
 * under the buttons — reported from the running app as a repository filling
 * the window with "History — checkout-api" struck through by three circles.
 *
 * So the shell answers "which area is in the corner" once (`cornerArea`,
 * pinned in `state/workbench.test.ts`), its stylesheet hands that area the
 * room as `--titlebar-inset`, and a row that can be in the corner spends
 * it. This holds the second half of that bargain: a row that stops spending
 * it, or a component that starts deciding for itself again, fails here rather
 * than in a screenshot.
 *
 * Read as text, for the reason `chrome.test.ts` gives: what is asserted is
 * that the code *says* something, and a jsdom render cannot see it — Vitest
 * stubs CSS modules to the empty string, so a computed-style assertion would
 * pass while saying nothing at all.
 */

/** Every row that the layout can put under the window buttons. */
const CORNER_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["the sidebar's title bar", sidebarCss, '.titlebar'],
  ["a conversation's header", conversationCss, '.header'],
  ["a tool's header", toolPanesCss, '.header'],
  ["a terminal's own bar", toolPanesCss, '.terminalBar'],
  // The room draws its own top row and gets no strip above it, so that row is
  // the corner whenever the room is filling the window with the sidebar away.
  ["a room's top row", teamRoomCss, '.bar'],
]

/** The body of one rule, by selector, from a stylesheet read as text. */
const block = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `${selector} is no longer a rule in this stylesheet`).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('the row under the macOS window buttons', () => {
  it.each(CORNER_ROWS)('%s leaves room for them', (_name, css, selector) => {
    const rule = block(css, selector)
    expect(rule).toMatch(/padding[^;]*max\([^;]*var\(--titlebar-inset, 0px\)/)
  })

  it("a panel's tab strip leaves room for them too", () => {
    // Tailwind rather than a module, so the rule is a class on the component.
    expect(dockPanel).toContain('pl-[max(var(--hd-space-2),var(--titlebar-inset,0px))]')
  })

  it('the room itself is zero until the shell says otherwise', () => {
    // Which is what makes the browser build, the design explorer and the
    // preview harness — none of which have window buttons or a `data-lights`
    // — draw every one of these rows at its ordinary padding.
    expect(appCss).toMatch(/--titlebar-inset:\s*0px/)
    expect(appCss).toMatch(/--hd-titlebar-lights:\s*78px/)
  })

  it('a floating sidebar lies over the corner, so it is given the room whenever there are buttons', () => {
    // The desktop app zoomed in is narrower than the line in CSS pixels, and
    // then the sidebar floats over the window's top-left as the column stood
    // in it — its own toggle and arrows would otherwise sit under the buttons.
    expect(workbenchCss).toMatch(
      /\.shell\[data-lights\] \.sidebar\[data-floating\]\s*{\s*--titlebar-inset:\s*var\(--hd-titlebar-lights\)/,
    )
  })

  it('and only the area holding the corner is given it', () => {
    for (const area of ['sidebar', 'main', 'right', 'bottom']) {
      expect(workbenchCss).toContain(`.shell[data-lights='${area}']`)
    }
    expect(workbenchCss).toMatch(/--titlebar-inset:\s*var\(--hd-titlebar-lights\)/)
  })

  it('boxes that are not in the corner hand it back', () => {
    // A second half is below or to the right of a first; a view under a tab
    // strip is below the strip. Both would otherwise inherit the room and
    // indent a header that has nothing above it to clear.
    expect(panesCss).toMatch(/\.child\[data-side='second'\]\s*{\s*--titlebar-inset:\s*0px/)
    expect(panesCss).toMatch(/\.pane\[data-strip\][^{]*{\s*--titlebar-inset:\s*0px/)
    expect(workbenchCss).toMatch(/\.half\[data-side='second'\][^{]*{\s*--titlebar-inset:\s*0px/)
    expect(workbenchCss).toMatch(/\.layers\[data-under-bar\]\s*{\s*--titlebar-inset:\s*0px/)
  })

  it('unless an expansion has left the second half holding the window', () => {
    // The one case where a `second` *is* the corner. It asks for the value the
    // split inherited rather than the width itself, so a split nowhere near
    // the corner still resolves to nothing.
    expect(panesCss).toMatch(
      /\.child\[data-side='first'\]\[data-hidden\] ~ \.child\[data-side='second'\]\s*{\s*--titlebar-inset:\s*var\(--split-lights\)/,
    )
  })
})

describe('nothing decides this for itself', () => {
  const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('only the shell asks whether there are window buttons at all', () => {
    const asking = Object.entries(sources)
      .filter(([path]) => !/\.test\.tsx?$/.test(path) && !/\/lib\/desktop\.ts$/.test(path))
      .filter(([, text]) => /hasTrafficLights\(\)/.test(text))
      .map(([path]) => path)
    // `Workbench` names the area in `data-lights`; every other component is
    // told by the cascade, which is the whole point of doing it in one place.
    expect(asking).toEqual(['./Workbench.tsx'])
  })

  it('and no stylesheet writes the width of the buttons out by hand', () => {
    for (const [name, css] of [
      ['Sidebar', sidebarCss],
      ['Conversation', conversationCss],
      ['ToolPanes', toolPanesCss],
      ['TeamRoomPane', teamRoomCss],
      ['Panes', panesCss],
      ['Workbench', workbenchCss],
    ] as const) {
      expect(css, `${name}.module.css hard-codes the traffic lights' width`).not.toMatch(
        /padding[^;]*\b78px/,
      )
    }
  })
})
