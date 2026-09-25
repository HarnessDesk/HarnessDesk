import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { Dialog as DialogRoot, DialogPortal } from '../ui/dialog'
import {
  AppWindowPage,
  AppWindowRail,
  AppWindowRailScroll,
  AppWindowRailTop,
  AppWindowSurface,
} from './AppWindow'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('names the full-window surface and exposes its rail and page anatomy', () => {
  act(() => root.render(
    <DialogRoot open>
      <DialogPortal container={container}>
        <AppWindowSurface aria-label="Settings" modal>
          <AppWindowRail>
            <AppWindowRailTop>Back to app</AppWindowRailTop>
            <AppWindowRailScroll>Pages</AppWindowRailScroll>
          </AppWindowRail>
          <AppWindowPage>Appearance</AppWindowPage>
        </AppWindowSurface>
      </DialogPortal>
    </DialogRoot>,
  ))

  expect(container.querySelector('[data-slot="app-window"]')?.getAttribute('aria-label')).toBe('Settings')
  expect(container.querySelector('[data-slot="app-window"]')?.getAttribute('aria-modal')).toBe('true')
  expect(container.querySelector('[data-slot="app-window-nav"]')?.textContent).toContain('Pages')
  expect(container.querySelector('[data-slot="app-window-page"]')?.textContent).toBe('Appearance')
})
