import { expect, test } from '@playwright/test'
import { WALL_DESTINATIONS, WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { expectDestinationPopupContracts, popupContractDestinations } from './frame-contract-helpers'


import { useFrameContractEvidence } from './frame-contract-split-setup'
import { popupAreaOffsets } from './frame-contract-popup-area-helpers'
useFrameContractEvidence()
for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
  for (const offset of popupAreaOffsets('pages')) {
    const destinations = popupContractDestinations.slice(offset, offset + 5)
    {

      for (const [item0, destination] of (destinations).entries()) test(`C10 exhaustive popup contracts ${destinations.map(destination => destination.id).join(', ')} at ${width} in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {

        await expectDestinationPopupContracts(page, destination, theme, width)


      })
    }
  }
}
