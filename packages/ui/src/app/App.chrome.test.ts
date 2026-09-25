import { expect, it } from 'vitest'

import app from './App.tsx?raw'
import appCss from '../styles/app.css?raw'
import appWindowCss from '../components/AppWindow.module.css?raw'
import tokensCss from '../design/foundation/tokens.css?raw'

/**
 * Global chrome still has to respect the workbench geometry.
 *
 * At the supported 1024px minimum, a full-width standing banner centred on
 * the window started inside the sidebar and cut its HarnessDesk wordmark in
 * half. The notice rail is a sibling of the workbench, so only this explicit
 * hand-off can keep it over the readable pane while the sidebar owns a
 * column.
 */
it('keeps standing notices out of the sidebar column', () => {
  expect(app).toContain("sidebarPlacement(snapshot) === 'column'")
  expect(app).toContain("snapshot.workbench.sidebar.size")
  expect(app).toContain('style={{ left: `${noticeLeft}px` }}')
  expect(appCss).toMatch(/\.hd-shellBody\s*{[^}]*position:\s*relative/s)
  expect(appCss).toMatch(/\.hd-floatingNotices\s*{[^}]*transition:\s*left/s)
})

/**
 * A full-window surface (Settings, Usage, Agents — `AppWindow`'s `.win`) has
 * to paint over the floating notice stack, not the other way around (#896):
 * opened while the Library import banner or a status banner was showing, the
 * banner floated on top of the window and caught the clicks meant for a
 * control underneath it.
 *
 * Both read their z-index from a token rather than a literal, so this reads
 * the tokens themselves and checks the ordering `--hd-z-window` is supposed
 * to hold — a numeric regression here is exactly how #896 could come back
 * without either stylesheet's own rule appearing to change.
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
