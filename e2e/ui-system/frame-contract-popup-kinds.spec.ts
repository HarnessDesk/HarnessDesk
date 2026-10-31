import { expect, test } from '@playwright/test'
import { WALL_DESTINATIONS, WALL_WIDTHS } from './frame-wall-destinations'
import { batchTitle, checkPopupBatch } from './frame-contract-popup-batch'
import { useFrameContractEvidence } from './frame-contract-split-setup'
useFrameContractEvidence()
for (const width of WALL_WIDTHS) {
  test(`C10 all three popup kinds are exercised at ${width} in both themes`, async ({ page }) => {
    const destinations = ['popup-menu-none', 'popup-wide-menu', 'popup-info-card'].map(id => WALL_DESTINATIONS.find(destination => destination.id === id)!)
    const kinds = await checkPopupBatch(page, destinations, width)
    expect([...kinds].sort()).toEqual(['info-card', 'menu', 'wide-menu'])
  })
  const gitRef = WALL_DESTINATIONS.filter(destination => destination.gitRef)
  test(`C10 exhaustive popup contracts ${batchTitle(gitRef, width)}`, async ({ page }) => {
    await checkPopupBatch(page, gitRef, width)
  })
}
