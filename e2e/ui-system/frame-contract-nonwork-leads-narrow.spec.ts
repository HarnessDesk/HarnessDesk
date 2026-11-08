import { test } from '@playwright/test'
import { B10_NONWORK_DESTINATIONS } from './frame-contract-helpers'
import { checkNonworkLeads, leadBatchIds } from './frame-contract-leads-batch'
import { batches } from './frame-snapshot-batch'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()

for (const destinations of batches(B10_NONWORK_DESTINATIONS, 10)) {
  test(`B10 page titles follow their content column and fixed leads follow window state at 720: ${leadBatchIds(destinations)}`, async ({ page }) => {
    await checkNonworkLeads(page, destinations, 'narrow')
  })
}
