import { test } from '@playwright/test'
export const useFrameContractEvidence = () => test.use({ screenshot: 'off', trace: 'off', video: 'off' })
