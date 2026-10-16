import type { Page } from '@playwright/test'

/** Reserve the native corner through the same bridge flag as the macOS shell. */
export const installNativeCorner = async (page: Page) => {
  await page.addInitScript(() => {
    window.harnessdesk = {
      platform: 'darwin', openExternal: () => {}, setTitle: () => {}, onShortcut: () => () => {},
    }
  })
}
