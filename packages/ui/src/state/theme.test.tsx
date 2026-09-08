import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DesktopBridge } from '../lib/desktop'
import { StoreProvider } from './context'
import { emptySnapshot, type AppSnapshot, type AppStore } from './store'
import { useTheme } from './theme'

/**
 * The theme's contract: this document is dressed from the resolved value, and
 * the shell is told the preference itself — the browser pane's page reads
 * `prefers-color-scheme` from Chromium, not from us, so an explicit Light or
 * Dark has to travel further than `body[data-hd-dark-theme]`.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let told: string[]

/** jsdom has no media queries; the OS in these tests is light unless said otherwise. */
let osIsDark = false
const stubMatchMedia = (): void => {
  ;(window as { matchMedia?: unknown }).matchMedia = (query: string) =>
    ({
      media: query,
      matches: osIsDark,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
}

beforeEach(() => {
  osIsDark = false
  stubMatchMedia()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  told = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as { harnessdesk?: DesktopBridge }).harnessdesk
  document.body.removeAttribute('data-hd-dark-theme')
  document.body.removeAttribute('data-hd-palette')
})

const shell = (): void => {
  ;(window as { harnessdesk?: Partial<DesktopBridge> }).harnessdesk = {
    platform: 'darwin',
    setTheme: (theme: string) => told.push(theme),
  } as Partial<DesktopBridge> as DesktopBridge
}

const storeOf = (snapshot: AppSnapshot): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  }) as unknown as AppStore

const Probe = () => {
  useTheme()
  return null
}

const mount = (theme: AppSnapshot['theme'], palette?: AppSnapshot['palette']): void => {
  act(() => {
    root.render(
      <StoreProvider
        store={storeOf({ ...emptySnapshot(), theme, ...(palette ? { palette } : {}) })}
      >
        <Probe />
      </StoreProvider>,
    )
  })
}

describe('useTheme', () => {
  it('hands the preference to the shell, so Chromium dresses the browser pane too', () => {
    shell()
    mount('dark')
    expect(told).toEqual(['dark'])
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(true)

    mount('light')
    expect(told).toEqual(['dark', 'light'])
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(false)

    // `system` is passed on as itself: the OS decides, on both sides at once.
    mount('system')
    expect(told).toEqual(['dark', 'light', 'system'])
  })

  it('leaves the OS in charge under `system`', () => {
    shell()
    osIsDark = true
    mount('system')
    expect(told).toEqual(['system'])
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(true)
  })

  it('is silent in the browser build, which has no shell to tell', () => {
    expect(() => mount('dark')).not.toThrow()
    expect(told).toEqual([])
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(true)
  })

  // The palette is a second axis, not a fourth theme: `editorial` marks the
  // body for editorial.css and rides along under any light/dark preference,
  // and the default palette leaves no attribute behind — a body older sheets
  // render exactly as before.
  it('marks the body for the editorial palette, and unmarks it for the default', () => {
    mount('light', 'editorial')
    expect(document.body.getAttribute('data-hd-palette')).toBe('editorial')
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(false)

    mount('dark', 'editorial')
    expect(document.body.getAttribute('data-hd-palette')).toBe('editorial')
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(true)

    mount('dark', 'harnessdesk')
    expect(document.body.hasAttribute('data-hd-palette')).toBe(false)
  })
})
