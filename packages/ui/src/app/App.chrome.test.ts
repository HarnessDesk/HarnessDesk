import { expect, it } from 'vitest'

import app from './App.tsx?raw'
import appCss from '../styles/app.css?raw'

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
