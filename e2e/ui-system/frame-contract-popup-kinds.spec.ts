import { expect, test } from '@playwright/test'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { expectDestinationPopupContracts, popupContractDestinations } from './frame-contract-helpers'


import { useFrameContractEvidence } from './frame-contract-split-setup'
useFrameContractEvidence()
for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
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
