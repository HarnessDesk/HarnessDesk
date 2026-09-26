import { describe, expect, it } from 'vitest'

import css from './Panes.module.css?raw'
import source from './Panes.tsx?raw'

/**
 * A floating desk notice ("Your other agents have skills and servers this
 * machine could share…") rides the pane being read (`[data-notice-host]`),
 * but until now nothing under it made room: a conversation's first message,
 * or any other screen's own top edge, sat exactly where it always did, so a
 * multi-line card could cover it outright.
 *
 * The fix is `Panes.tsx` composing `data-notice-yield` — the notice system's
 * own contract (`app.css`, beside `.hd-floatingNotices`) — for the pane
 * riding the stack, wrapped around whatever that pane mounts, rather than
 * leaving every screen to opt in for itself (the room did, once, for #913;
 * nothing else ever did). Vitest stubs CSS modules to the empty string and
 * jsdom implements neither `ResizeObserver` nor real flex sizing, so this
 * reads the source and the stylesheet as text — the same reason
 * `App.chrome.test.ts` and `TeamRoomPane.css.test.ts` do, for the same
 * system.
 */
describe('a pane leaves room for a standing notice, without every screen opting in', () => {
  it('wraps whatever a pane mounts, marking the wrapper only for the pane riding the stack', () => {
    expect(source).toContain(
      "<div className={styles.screen} {...(pane.id === primary ? { 'data-notice-yield': '' } : {})}>",
    )
  })

  it('never marks the same box `data-notice-host` measures — that would chase the notice down the page', () => {
    // `data-notice-host` names the box `App.tsx` reads live to place the
    // stack; a margin on that same box would move its own top on the next
    // frame instead of holding still while the room opens up beneath it.
    const paneSurfaceAt = source.indexOf('<PaneSurface')
    const hostAt = source.indexOf("'data-notice-host': ''")
    const screenDivAt = source.indexOf('<div className={styles.screen}')
    const yieldAt = source.indexOf("'data-notice-yield': ''")
    expect(paneSurfaceAt).toBeGreaterThan(-1)
    expect(hostAt).toBeGreaterThan(-1)
    expect(screenDivAt).toBeGreaterThan(-1)
    expect(yieldAt).toBeGreaterThan(-1)
    // The host is the `PaneSurface` itself: its opening tag carries
    // `data-notice-host` directly. The yield is a later, separate `div`
    // mounted inside it, after the optional strip — never the same element.
    expect(paneSurfaceAt).toBeLessThan(hostAt)
    expect(hostAt).toBeLessThan(screenDivAt)
    expect(screenDivAt).toBeLessThan(yieldAt)
  })

  it('gives the wrapper the room left after any strip, so a screen with none still fills the pane', () => {
    expect(css).toMatch(/\.screen\s*{[^}]*flex:\s*1/s)
    expect(css).toMatch(/\.screen\s*{[^}]*min-height:\s*0/s)
  })
})
