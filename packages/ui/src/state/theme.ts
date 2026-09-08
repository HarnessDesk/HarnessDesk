import { useEffect, useState } from 'react'

import { setNativeTheme } from '../lib/desktop'
import { useSnapshot } from './context'

/**
 * Resolved theme.
 *
 * `system` follows the OS, which on macOS changes without a reload, so the
 * media query is watched rather than read once. The resolved value is written to
 * `body[data-hd-dark-theme]` because that is the selector the platform sheet
 * switches on, alongside `body[data-hd-palette]`.
 *
 * The preference also goes to the desktop shell, which hands it to Chromium.
 * That is what dresses the parts of the window this document cannot: native
 * menus and dialogs, and the browser pane's page, whose `prefers-color-scheme`
 * is Chromium's and would otherwise follow the OS past an explicit choice.
 */

export type ResolvedTheme = 'light' | 'dark'

const query = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export const useTheme = (): ResolvedTheme => {
  const { theme: preference, palette, accent, corners, look } = useSnapshot()
  const [system, setSystem] = useState<ResolvedTheme>(() => (query().matches ? 'dark' : 'light'))

  useEffect(() => {
    const media = query()
    const listener = (event: MediaQueryListEvent): void => {
      setSystem(event.matches ? 'dark' : 'light')
    }
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  const resolved: ResolvedTheme = preference === 'system' ? system : preference

  useEffect(() => {
    if (resolved === 'dark') document.body.setAttribute('data-hd-dark-theme', '')
    else document.body.removeAttribute('data-hd-dark-theme')
    document.documentElement.style.colorScheme = resolved
  }, [resolved])

  // The palette rides the same body the dark flag does: `editorial.css` and
  // `shadcn-themes.css` switch on this attribute, and the default palette is
  // its absence, so a build that predates the sheets renders exactly as
  // before. Accent and corners are the other two dials of the same customizer
  // (shadcn-themes.css), and their defaults are also an absent attribute.
  useEffect(() => {
    if (palette === 'harnessdesk') document.body.removeAttribute('data-hd-palette')
    else document.body.setAttribute('data-hd-palette', palette)
  }, [palette])

  useEffect(() => {
    if (accent === 'default') document.body.removeAttribute('data-hd-accent')
    else document.body.setAttribute('data-hd-accent', accent)
  }, [accent])

  useEffect(() => {
    if (corners === 'default') document.body.removeAttribute('data-hd-corners')
    else document.body.setAttribute('data-hd-corners', corners)
  }, [corners])

  // The interface is the same mechanism again, and for the same reason: Desk
  // is the absence of the attribute, so it is what the token file already
  // says and what a build that predates this dial renders. Studio is one
  // block of overrides at the foot of tokens.css — no component knows.
  useEffect(() => {
    if (look === 'desk') document.body.removeAttribute('data-hd-interface')
    else document.body.setAttribute('data-hd-interface', look)
  }, [look])

  useEffect(() => {
    setNativeTheme(preference)
  }, [preference])

  return resolved
}
