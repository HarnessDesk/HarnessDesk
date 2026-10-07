import path from 'node:path'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`the catalogue keeps a notice beside a content-height empty state in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=empty')
    const empty = page.locator('[data-slot="conversation-empty-state"][data-catalog-variant="content"]')
    await expect(empty).toHaveCount(1)
    await expect(empty).toHaveAttribute('data-height', 'content')
    await expect(empty).toContainText('What should we build?')
    await expect.poll(() => page.locator('html').evaluate(el => el.style.colorScheme)).toBe(theme)
    await page.evaluate(() => document.fonts.ready)
    const pane = empty.locator('..')
    const notice = pane.getByText('A tool was unavailable when this conversation opened.', { exact: true })
    await expect(notice).toBeVisible()
    const box = (await empty.boundingBox())!
    const noticeBox = (await notice.boundingBox())!
    expect(box.height).toBeLessThan(await pane.evaluate(el => el.clientHeight))
    expect(noticeBox.y - (box.y + box.height)).toBeGreaterThanOrEqual(0)
    expect(noticeBox.y - (box.y + box.height)).toBeLessThan(40)
    if (process.env.CONVERSATION_EMPTY_FRAMES_DIR) {
      await pane.screenshot({ path: path.join(process.env.CONVERSATION_EMPTY_FRAMES_DIR, `catalog-content-${theme}.png`) })
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const scene of ['opening', 'restore'] as const) {
    test(`a notice stays beside the ${scene} empty state in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 800 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?notices=conversation-${scene}-after`)
      const frame = page.locator(`[data-frame-id="notices-conversation-${scene}-after"]`)
      const empty = frame.locator('[data-slot="conversation-empty-state"]')
      const notice = frame.getByText('A tool was unavailable when this conversation opened.', { exact: true })
      await expect(empty).toContainText(scene === 'restore' ? 'Nothing to show' : 'What should we build?')
      await expect(notice).toBeVisible()
      await expect.poll(() => page.locator('html').evaluate(el => el.style.colorScheme)).toBe(theme)
      await page.evaluate(() => document.fonts.ready)
      if (process.env.CONVERSATION_EMPTY_FRAMES_DIR) {
        await page.screenshot({ path: path.join(process.env.CONVERSATION_EMPTY_FRAMES_DIR, `${process.env.CONVERSATION_EMPTY_FRAME_PREFIX ?? 'after'}-${scene}-${theme}.png`) })
      }
      const emptyBox = (await empty.boundingBox())!
      const noticeBox = (await notice.boundingBox())!
      const readingHeight = await empty.locator('..').evaluate(el => el.clientHeight)
      expect(emptyBox.height).toBeLessThan(readingHeight / 2)
      expect(noticeBox.y - (emptyBox.y + emptyBox.height)).toBeGreaterThanOrEqual(0)
      expect(noticeBox.y - (emptyBox.y + emptyBox.height)).toBeLessThan(40)
      const composer = (await frame.locator('[data-slot="composer-dock"]').first().boundingBox())!
      expect(noticeBox.y + noticeBox.height).toBeLessThan(composer.y)
    })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`an empty conversation still fills its reading area in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    for (const scene of ['opening', 'restore']) {
      await page.goto(`/preview.html?notices=conversation-${scene}-before`)
      const empty = page.locator('[data-slot="conversation-empty-state"]')
      await expect(empty).toBeVisible()
      const box = (await empty.boundingBox())!
      const readingHeight = await empty.locator('..').evaluate(el => el.clientHeight)
      expect(box.height).toBeGreaterThan(readingHeight * 0.75)
    }
  })
}
