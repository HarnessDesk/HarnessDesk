import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

import { ShortcutsSection } from './SettingsYou'

it('prints one cap per key and folds the four focus tile shortcuts into a range', () => {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<ShortcutsSection />)
  const rows = [...container.querySelectorAll('[data-slot="row"]')]
  const tiles = rows.filter(row => row.textContent?.includes('Focus tile'))
  expect(tiles).toHaveLength(1)
  expect(tiles[0]?.querySelector('[data-slot="row-title"]')?.textContent).toBe('Focus tile 1 – 4')
  expect([...tiles[0]!.querySelectorAll('kbd')].map(cap => cap.textContent)).toEqual(['⌥', '⌘', '1 – 4'])
  const newLine = rows.find(row => row.textContent?.startsWith('New line'))!
  expect([...newLine.querySelectorAll('kbd')].map(cap => cap.textContent)).toEqual(['⇧', '↵'])
  const showChanges = rows.find(row => row.textContent?.startsWith('Show changes'))!
  expect([...showChanges.querySelectorAll('kbd')].map(cap => cap.textContent)).toEqual(['⇧', '⌘', 'D'])
})

it('reads focus-tile modifiers and range keys from the shortcut table', async () => {
  vi.resetModules()
  vi.doMock('../lib/shortcuts', async () => {
    const actual = await vi.importActual<typeof import('../lib/shortcuts')>('../lib/shortcuts')
    return { ...actual, SHORTCUTS: actual.SHORTCUTS.map(shortcut => shortcut.action.match(/^tile-\d+$/)
      ? { ...shortcut, alt: false, shift: true, key: String(Number(shortcut.key) + 4) }
      : shortcut) }
  })
  try {
    const { ShortcutsSection: Changed } = await import('./SettingsYou')
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<Changed />)
    const row = [...container.querySelectorAll('[data-slot="row"]')].find(row => row.textContent?.includes('Focus tile'))!
    expect(row.querySelector('[data-slot="row-title"]')?.textContent).toBe('Focus tile 5 – 8')
    expect([...row.querySelectorAll('kbd')].map(cap => cap.textContent)).toEqual(['⇧', '⌘', '5 – 8'])
  } finally { vi.doUnmock('../lib/shortcuts'); vi.resetModules() }
})
