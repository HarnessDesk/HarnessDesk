import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

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
