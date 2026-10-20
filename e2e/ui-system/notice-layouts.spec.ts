import { expect, test, type Locator, type Page } from '@playwright/test'
import { selectTeamDestination } from './team-frame-actions'

test.use({ colorScheme: process.env.NOTICE_FRAME_THEME === 'dark' ? 'dark' : 'light', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })

const layout = (page: Page, id: string): Locator => page.locator(`[data-frame-id="${id}"]`)

const showMain = async (frame: Locator): Promise<void> => {
  const closePane = frame.getByRole('button', { name: 'Close pane', exact: true })
  if (await closePane.isVisible()) await closePane.click()
  await expect(frame.locator('[data-frame-region="right"]')).toBeHidden()
  await expect(frame.locator('[data-frame-region="main"]')).toBeVisible()
}


const expectOneNotice = async (frame: Locator, surface: 'composer' | 'strip'): Promise<void> => {
  await expect(frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]')).toHaveCount(1)
  await expect(frame.locator(`[data-slot="${surface === 'composer' ? 'composer-notice' : 'notice-strip'}"]`)).toHaveCount(1)
}

test('real Workbench and Panes put each notice in one mounted outlet', async ({ page }) => {
  await page.goto('/preview.html?notice-placement')
  const room = layout(page, 'coverage-notice-room-board')
  await selectTeamDestination(room, 'board')
  const narrow = layout(page, 'coverage-notice-narrow-overlay')
  await expectOneNotice(narrow, 'strip')
  await expect(narrow.locator('[data-frame-region="right"] [data-slot="notice-strip"]')).toHaveCount(1)
  await expect(narrow.locator('[data-frame-region="main"]')).toBeHidden()
  await showMain(narrow)

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
      'coverage-notice-split-composers',
      'coverage-notice-split-unfocused-composer',
      'coverage-notice-composer-strip',
      'coverage-notice-pane-bar-strip',
    ]
    const selected = process.env.NOTICE_FRAME_CASES?.split(',')
    for (const id of cases.filter((candidate) => !selected || selected.includes(candidate))) {
      await layout(page, id).screenshot({ path: `${frameDir}/${prefix}-${id.replace('coverage-notice-', '')}.png` })
    }
  }

  await expectOneNotice(layout(page, 'coverage-notice-narrow-overlay'), 'composer')
  await expectOneNotice(room, 'strip')
  const pendingRoom = layout(page, 'coverage-notice-room-pending-approval')
  await selectTeamDestination(pendingRoom, 'room')
  await expect(pendingRoom.locator('[data-slot="composer"]')).toBeVisible()
  await expect(pendingRoom.locator('[data-slot="approval-card"]')).toBeVisible()
  await expectOneNotice(pendingRoom, 'composer')
  const pendingStrip = pendingRoom.locator('[data-slot="composer-notice"]')
  await expect(pendingStrip.locator('xpath=ancestor::*[@hidden]')).toHaveCount(0)
  await expect(pendingRoom.locator('[data-slot="workbench-notice-fallback"][data-area="main"] [data-slot="notice-strip"]')).toHaveCount(0)

  await expectOneNotice(layout(page, 'coverage-notice-folder-gone'), 'strip')
  await expectOneNotice(layout(page, 'coverage-notice-zoomed-sidebar'), 'composer')
  await expectOneNotice(layout(page, 'coverage-notice-zoomed-dock'), 'composer')
  for (const [id, area] of [
    ['coverage-notice-room-board', 'main'],
    ['coverage-notice-folder-gone', 'main'],
  ] as const) {
    await expect(layout(page, id).locator(`[data-slot="workbench-notice-fallback"][data-area="${area}"] [data-slot="notice-strip"]`)).toHaveCount(1)
  }
  await expect(layout(page, 'coverage-notice-narrow-overlay').locator('[data-slot="composer-dock"] [data-slot="composer-notice"]')).toHaveCount(1)
  await expect(layout(page, 'coverage-notice-zoomed-sidebar').locator('[data-slot="composer-dock"] [data-slot="composer-notice"]')).toHaveCount(1)
  await expect(layout(page, 'coverage-notice-zoomed-dock').locator('[data-slot="composer-dock"] [data-slot="composer-notice"]')).toHaveCount(1)
  await expectOneNotice(layout(page, 'coverage-notice-split-composers'), 'composer')
  await expectOneNotice(layout(page, 'coverage-notice-split-unfocused-composer'), 'composer')

  const composerStrip = layout(page, 'coverage-notice-composer-strip')
  await expect(composerStrip.locator('[data-slot="composer-notice"]').locator('xpath=ancestor::*[@data-slot="composer-notices"]')).toHaveCount(1)
  const paneBarStrip = layout(page, 'coverage-notice-pane-bar-strip')
  await expectOneNotice(paneBarStrip, 'strip')
  await expect(paneBarStrip.locator('[data-slot="notice-strip"]').locator('xpath=ancestor::*[@data-pane-id]')).toHaveCount(1)
  expect(await paneBarStrip.locator('[data-slot="notice-strip"]').evaluate((strip) =>
    strip.parentElement?.previousElementSibling?.matches('[data-slot="dock-panel-bar"]') ?? false,
  )).toBe(true)

})

test('a narrow room keeps its composer notice visible when widened', async ({ page }) => {
  await page.goto('/preview.html?notice-placement')
  const frame = layout(page, 'coverage-notice-room-container-query')
  await frame.scrollIntoViewIfNeeded()
  await showMain(frame)
  await selectTeamDestination(frame, 'room')
  const body = frame.locator('[data-slot="room-body"]')
  const visibleNoticeCount = (): Promise<number> => frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]').evaluateAll((nodes) =>
    nodes.filter((node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getClientRects().length > 0).length,
  )

  await expect(frame.locator('[data-team-page="room"]')).toBeVisible()
  await expect(frame.locator('[data-team-page="room"]')).toHaveAttribute('aria-selected', 'true')
  await expect(frame.locator('[data-slot="top-bar"] [role="tab"]')).toHaveCount(0)
  await expect(body).toBeVisible()
  await expect.poll(visibleNoticeCount).toBe(1)
  await expect(frame.locator('[data-slot="composer-notices"] :is([data-slot="notice-strip"], [data-slot="composer-notice"])')).toBeVisible()

  await frame.getByTestId('notice-layout-canvas').evaluate((canvas) => { (canvas as HTMLElement).style.width = '1400px' })
  await expect(body).toBeVisible()
  await expect.poll(visibleNoticeCount).toBe(1)
  const composerStrip = frame.locator('[data-slot="composer-notices"] :is([data-slot="notice-strip"], [data-slot="composer-notice"])')
  await expect(composerStrip).toBeVisible()
  await expect(frame.locator('[data-slot="workbench-notice-fallback"][data-area="main"] [data-slot="notice-strip"]')).toHaveCount(0)
})


test('the composer notice dismiss glyph shares the send control column', async ({ page }) => {
  await page.goto('/preview.html?notice-placement')
  const frame = layout(page, 'coverage-notice-split-composers')
  await showMain(frame)
  const notice = frame.locator('[data-slot="composer-notice"]')
  await expect(notice).toHaveCount(1)
  const dock = notice.locator('xpath=ancestor::*[@data-slot="composer-dock"]')
  const dismiss = await notice.getByRole('button', { name: 'Dismiss' }).locator('svg').boundingBox()
  const send = await dock.getByRole('button', { name: 'Send', exact: true }).boundingBox()
  expect(dismiss).not.toBeNull()
  expect(send).not.toBeNull()
  expect(Math.abs(dismiss!.x + dismiss!.width - (send!.x + send!.width))).toBeLessThanOrEqual(1)
})


for (const surface of ['preview', 'catalogue'] as const) {
  test(`the ${surface} standing goal clear glyph lands on its alert text edge`, async ({ page }) => {
    await page.goto(surface === 'preview' ? '/preview.html' : '/design.html?view=conversation')
    const alert = page.locator(surface === 'preview'
      ? '[data-frame-id="conversation-composer"] [data-slot="alert"]'
      : '[data-alignment-board-id="conversation"] [data-slot="alert"]').filter({ has: page.getByRole('button', { name: 'Clear goal' }) }).first()
    await expect(alert).toBeVisible()
    const gap = await alert.evaluate(element => {
      const style = getComputedStyle(element)
      const edge = element.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
      const glyph = element.querySelector('button[aria-label="Clear goal"] svg')!
      return Math.abs(edge - glyph.getBoundingClientRect().right)
    })
    expect(gap).toBeLessThanOrEqual(1)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`folder-gone banner keeps a long worktree name on one line and offers Archive in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html')
    const frame = layout(page, 'transcript-missing-folder')
    await frame.evaluate(element => { (element as HTMLElement).style.width = '400px' })
    const banner = frame.getByRole('status')
    await expect(banner).toBeVisible()
    await expect(banner.getByRole('button')).toHaveText(['Open a copy in another folder', 'Archive'])
    await expect(banner.getByRole('button').first()).toHaveAttribute('title', "Starts a new conversation with this one's summary; you choose the folder.")
    const name = banner.locator('[data-slot="middle-truncate"]')
    await expect(name).toHaveAttribute('title', '/home/jane/storefront/.worktrees/agent-inventory-retry-long-worktree-name-1771')
    const geometry = await name.evaluate(element => {
      const box = element.getBoundingClientRect()
      const body = element.closest('[data-slot="alert-description"]')!
      const bodyBox = body.getBoundingClientRect()
      return {
        fits: box.right <= bodyBox.right + 1,
        truncates: [...element.querySelectorAll('[data-part]')].some(part => part.scrollWidth > part.clientWidth),
        sentenceWraps: bodyBox.height > box.height,
      }
    })
    expect(geometry).toEqual({ fits: true, truncates: true, sentenceWraps: true })
    if (process.env.FOLDER_GONE_FRAMES) await frame.screenshot({ path: `${process.env.FOLDER_GONE_FRAMES}/folder-gone-${theme}.png` })
  })
}
