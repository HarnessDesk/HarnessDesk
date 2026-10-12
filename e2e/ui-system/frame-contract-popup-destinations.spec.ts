import { expect, test } from '@playwright/test'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { expectDestinationPopupContracts, popupContractDestinations } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
  for (let offset = 0; offset < popupContractDestinations.length; offset += 5) {
    const destinations = popupContractDestinations.slice(offset, offset + 5)
    test(`C10 exhaustive popup contracts ${destinations.map(destination => destination.id).join(', ')} at ${width} in ${theme}`, async ({ page }) => {
      for (const destination of destinations) await expectDestinationPopupContracts(page, destination, theme, width)
    })
  }
  test(`C10 all three popup kinds are exercised at ${width} in ${theme}`, async ({ page }) => {
    const kinds = new Set<string>()
    for (const id of ['popup-menu-none', 'popup-wide-menu', 'popup-info-card']) {
      const destination = WALL_DESTINATIONS.find(destination => destination.id === id)!
      const found = await expectDestinationPopupContracts(page, destination, theme, width)
      expect(found.size).toBeGreaterThan(0)
      for (const kind of found) kinds.add(kind)
    }
    expect([...kinds].sort()).toEqual(['info-card', 'menu', 'wide-menu'])
  })
  for (const destination of WALL_DESTINATIONS.filter(destination => destination.gitRef)) {
    test(`C10 exhaustive popup contracts ${destination.id} at ${width} in ${theme}`, async ({ page }) => {
      await expectDestinationPopupContracts(page, destination, theme, width)
    })
  }
}
