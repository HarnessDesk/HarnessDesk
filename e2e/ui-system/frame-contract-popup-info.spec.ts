import { test } from '@playwright/test'
import { WALL_WIDTHS } from './frame-wall-destinations'
import { batches, batchTitle, checkPopupBatch } from './frame-contract-popup-batch'
import { useFrameContractEvidence } from './frame-contract-split-setup'
import { popupAreaDestinations } from './frame-contract-popup-area-helpers'
useFrameContractEvidence()
for (const width of WALL_WIDTHS) {
  for (const destinations of batches(popupAreaDestinations('info'), 10)) {
    test(`C10 exhaustive popup contracts ${batchTitle(destinations, width)}`, async ({ page }) => {
      await checkPopupBatch(page, destinations, width)
    })
  }
}
