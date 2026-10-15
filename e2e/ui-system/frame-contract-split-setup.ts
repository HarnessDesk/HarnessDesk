import { test } from '@playwright/test'
export const useFrameContractEvidence = () => test.use({ screenshot: 'off', trace: 'retain-on-failure', video: 'off' })
