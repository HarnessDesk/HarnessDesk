import { expect, test, type Locator, type Page } from '@playwright/test'

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })

const layout = (page: Page, id: string): Locator => page.locator(`[data-frame-id="${id}"]`)

const expectOneNotice = async (frame: Locator, surface: 'composer' | 'strip'): Promise<void> => {
  await expect(frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]')).toHaveCount(1)
  await expect(frame.locator(`[data-slot="${surface === 'composer' ? 'composer-notice' : 'notice-strip'}"]`)).toHaveCount(1)
}

test('real Workbench and Panes put each notice in one mounted outlet', async ({ page }) => {
  await page.goto('/preview.html')
  const room = layout(page, 'coverage-notice-room-board')
  await room.getByRole('button', { name: /Board/ }).click()

  const frameDir = process.env.NOTICE_FRAME_DIR
  if (frameDir) {
    const prefix = process.env.NOTICE_FRAME_PREFIX ?? 'after'
    for (const id of [
      'coverage-notice-narrow-overlay',
      'coverage-notice-room-board',
      'coverage-notice-folder-gone',
      'coverage-notice-zoomed-sidebar',
      'coverage-notice-zoomed-dock',
    ]) {
      await layout(page, id).screenshot({ path: `${frameDir}/${prefix}-${id.replace('coverage-notice-', '')}.png` })
    }
  }

  await expectOneNotice(layout(page, 'coverage-notice-narrow-overlay'), 'strip')
  await expectOneNotice(room, 'strip')

  await expectOneNotice(layout(page, 'coverage-notice-folder-gone'), 'strip')
  await expectOneNotice(layout(page, 'coverage-notice-zoomed-sidebar'), 'strip')
  await expectOneNotice(layout(page, 'coverage-notice-zoomed-dock'), 'strip')
  await expectOneNotice(layout(page, 'coverage-notice-split-composers'), 'composer')
  await expectOneNotice(layout(page, 'coverage-notice-split-unfocused-composer'), 'composer')

})
