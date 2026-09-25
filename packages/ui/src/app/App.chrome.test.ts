import { expect, it } from 'vitest'

import app from './App.tsx?raw'
import appCss from '../styles/app.css?raw'
import appWindowCss from '../components/AppWindow.module.css?raw'
import tokensCss from '../design/foundation/tokens.css?raw'

/**
 * Global chrome still has to respect the workbench geometry.
 *
 * The floating notice stack reads the split tree's own primary pane
 * (`[data-notice-pane]`, marked in `Panes.tsx`) live, rather than
 * reconstructing its box from the sizes a right or bottom panel were last
 * dragged to — a zoom or a narrow window overrides a saved size without
 * changing it, so a reconstruction still let a banner spill past the real
 * boundary and catch a click meant for the pane beside it (#896). The pure
 * math this measurement feeds is `lib/notice-bounds.ts`'s own tests; this
 * checks that `App.tsx` actually wires the measurement up.
 */
it('confines standing notices to the split tree’s own primary pane', () => {
  expect(app).toContain("document.querySelector<HTMLElement>('[data-notice-pane]')")
  expect(app).toContain('noticeBounds(')
  expect(app).toContain('observer.observe(pane)')
  expect(appCss).toMatch(/\.hd-shellBody\s*{[^}]*position:\s*relative/s)
  expect(appCss).toMatch(/\.hd-floatingNotices\s*{[^}]*transition:\s*[\s\S]*left/)
})

/**
 * A full-window surface (Settings, Usage, Agents — `AppWindow`'s `.win`) has
 * to paint over the floating notice stack, not the other way around: opened
 * while a standing banner was showing, the banner must never float on top of
 * the window and catch a click meant for a control underneath it.
 *
 * This alone is not the guard for #896 — both z-index values already held
 * this ordering at the commit the issue was reported against, so this
 * ordering was never what broke. It is `lib/notice-bounds.ts`'s own
 * confinement, read live off the primary pane's box, that #896 actually
 * needed. This test stays because the invariant is real and worth keeping,
 * not because it explains the report: both read their z-index from a token
 * rather than a literal, so this reads the tokens themselves and checks the
 * ordering `--hd-z-window` is supposed to hold.
 */
it('keeps a full-window surface above the floating notice stack', () => {
  expect(appCss).toMatch(/\.hd-floatingNotices\s*{[^}]*z-index:\s*var\(--hd-z-notice\)/s)
  expect(appWindowCss).toMatch(/\.win\s*{[^}]*z-index:\s*var\(--hd-z-window\)/s)

  const tokenValue = (name: string): number => {
    const match = new RegExp(`--${name}:\\s*(-?\\d+)`).exec(tokensCss)
    expect(match, `${name} is not defined in tokens.css`).not.toBeNull()
    return Number(match![1])
  }
  const notice = tokenValue('hd-z-notice')
  const windowZ = tokenValue('hd-z-window')
  expect(windowZ, 'a full-window surface must stack above a floating notice').toBeGreaterThan(notice)
})

/**
 * `--hd-notice-inset` is the notice system's own contract for a pane that
 * yields room to the floating stack (#913) — a foundation token, set from JS
 * where the stack is measured, read through `[data-notice-yield]` in
 * `app.css` rather than by a screen reaching for the variable itself. A
 * screen defining this name itself, instead of composing the system's own
 * helper, is exactly the forked-token mistake rule 11 refuses.
 */
it('registers the notice inset as a foundation token, at 0px until something measures it', () => {
  expect(tokensCss).toMatch(/--hd-notice-inset:\s*0px/)
  expect(appCss).toMatch(/\[data-notice-yield\]/)
})
