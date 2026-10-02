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
    const cases = [
      'coverage-notice-narrow-overlay',
      'coverage-notice-room-board',
      'coverage-notice-room-pending-approval',
      'coverage-notice-room-container-query',
      'coverage-notice-folder-gone',
      'coverage-notice-zoomed-sidebar',
      'coverage-notice-zoomed-dock',
      'coverage-notice-split-unfocused-composer',
      'coverage-notice-composer-strip',
      'coverage-notice-pane-bar-strip',
    ]
    const selected = process.env.NOTICE_FRAME_CASES?.split(',')
    for (const id of cases.filter((candidate) => !selected || selected.includes(candidate))) {
      await layout(page, id).screenshot({ path: `${frameDir}/${prefix}-${id.replace('coverage-notice-', '')}.png` })
    }
  }

  await expectOneNotice(layout(page, 'coverage-notice-narrow-overlay'), 'strip')
  await expectOneNotice(room, 'strip')
  const pendingRoom = layout(page, 'coverage-notice-room-pending-approval')
  await expectOneNotice(pendingRoom, 'strip')
  const pendingStrip = pendingRoom.locator('[data-slot="notice-strip"]')
  await expect(pendingStrip.locator('xpath=ancestor::*[@hidden]')).toHaveCount(0)
  await expect(pendingRoom.locator('[data-slot="workbench-notice-fallback"][data-area="main"] [data-slot="notice-strip"]')).toHaveCount(1)

  await expectOneNotice(layout(page, 'coverage-notice-folder-gone'), 'strip')
  await expectOneNotice(layout(page, 'coverage-notice-zoomed-sidebar'), 'strip')
  await expectOneNotice(layout(page, 'coverage-notice-zoomed-dock'), 'strip')
  for (const [id, area] of [
    ['coverage-notice-room-board', 'main'],
    ['coverage-notice-folder-gone', 'main'],
    ['coverage-notice-zoomed-sidebar', 'sidebar'],
  ] as const) {
    await expect(layout(page, id).locator(`[data-slot="workbench-notice-fallback"][data-area="${area}"] [data-slot="notice-strip"]`)).toHaveCount(1)
  }
  await expect(layout(page, 'coverage-notice-narrow-overlay').locator('[data-notice-host=""] [data-slot="notice-strip"]')).toHaveCount(1)
  await expect(layout(page, 'coverage-notice-zoomed-dock').locator('[data-notice-host=""] [data-slot="notice-strip"]')).toHaveCount(1)
  await expectOneNotice(layout(page, 'coverage-notice-split-composers'), 'composer')
  await expectOneNotice(layout(page, 'coverage-notice-split-unfocused-composer'), 'composer')

  const composerStrip = layout(page, 'coverage-notice-composer-strip')
  await expect(composerStrip.locator('[data-slot="notice-strip"]').locator('xpath=ancestor::*[@data-slot="composer-notices"]')).toHaveCount(1)
  const paneBarStrip = layout(page, 'coverage-notice-pane-bar-strip')
  await expectOneNotice(paneBarStrip, 'strip')
  await expect(paneBarStrip.locator('[data-slot="notice-strip"]').locator('xpath=ancestor::*[@data-pane-id]')).toHaveCount(1)
  expect(await paneBarStrip.locator('[data-slot="notice-strip"]').evaluate((strip) =>
    strip.parentElement?.previousElementSibling?.matches('[data-slot="dock-panel-bar"]') ?? false,
  )).toBe(true)

})

test('a container-hidden room composer gives the notice to the fallback, then takes it back when widened', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = layout(page, 'coverage-notice-room-container-query')
  await frame.scrollIntoViewIfNeeded()
  const body = frame.locator('[data-slot="room-body"]')
  const visibleNoticeCount = (): Promise<number> => frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]').evaluateAll((nodes) =>
    nodes.filter((node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getClientRects().length > 0).length,
  )

  await expect(frame.getByRole('button', { name: /Board/ })).toBeVisible()
  await expect(body).toBeHidden()
  await expect.poll(visibleNoticeCount).toBe(1)
  await expect(frame.locator('[data-slot="workbench-notice-fallback"][data-area="main"] [data-slot="notice-strip"]')).toBeVisible()

  await frame.getByTestId('notice-layout-canvas').evaluate((canvas) => { (canvas as HTMLElement).style.width = '1400px' })
  await expect(body).toBeVisible()
  await expect.poll(visibleNoticeCount).toBe(1)
  const composerStrip = frame.locator('[data-slot="composer-notices"] [data-slot="notice-strip"]')
  await expect(composerStrip).toBeVisible()
  await expect(frame.locator('[data-slot="workbench-notice-fallback"][data-area="main"] [data-slot="notice-strip"]')).toHaveCount(0)
})
