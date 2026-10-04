import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 1100, height: 800 }, colorScheme: process.env.NOTICE_FRAME_THEME === 'dark' ? 'dark' : 'light' })
for (const scene of ['startup', 'inbox', 'conversation', 'settings']) {
  test(`quiet messages: ${scene}`, async ({ page }) => {
    await page.goto(`/preview.html?notices=${scene}`)
    const frame = page.locator(`[data-frame-id="notices-${scene}"]`)
    await expect(frame).toBeVisible()
    await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(1)
    const before = process.env.NOTICE_FRAME_PREFIX === 'before'
    if (scene === 'inbox') {
      await page.locator('[data-slot="inbox-button"]').locator('..').click()
      if (!before) await page.getByRole('button', { name: /ignored 2 settings/ }).click()
    }
    if (!before) {
      const dot = page.locator('[data-slot="inbox-dot"]')
      const box = await dot.boundingBox()
      expect(box?.width).toBe(box?.height)
    }
    if (!before && scene === 'conversation') await expect(frame.getByText('Context was compacted to make room for more of this conversation.')).toBeVisible()
    if (process.env.NOTICE_FRAME_DIR) {
      await page.screenshot({ fullPage: scene === 'settings', path: `${process.env.NOTICE_FRAME_DIR}/${process.env.NOTICE_FRAME_PREFIX ?? 'after'}-${scene}-${process.env.NOTICE_FRAME_THEME ?? 'light'}.png` })
    }
    if (before) return
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    if (scene === 'startup') await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(1)
    if (scene === 'conversation') await expect(frame.getByText('Context was compacted to make room for more of this conversation.')).toBeVisible()
    if (scene === 'inbox') {
      const inbox = page.locator('[data-slot="inbox-list"]')
      await expect(inbox.getByText('×3')).toBeVisible()
      const title = inbox.getByRole('button', { name: /ignored 2 settings/ })
      expect(await title.evaluate(element => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true)
      await expect(inbox.locator('[data-part="inbox-full-title"]')).toHaveText(/ignored 2 settings/)
      await expect(inbox.getByText('Ignored configuration settings', { exact: false })).toBeVisible()
      await expect(inbox.getByText('~/.codex/config.toml', { exact: false })).toBeVisible()
      await inbox.getByRole('button', { name: 'Open the file' }).click()
      expect(await page.evaluate(() => (window as unknown as { noticeReveals: unknown[] }).noticeReveals)).toEqual([{ path: '/Users/user/.codex/config.toml' }])
      await inbox.getByRole('button', { name: "Don't show this again" }).click()
      await expect(inbox.getByRole('button', { name: "Don't show this again" })).toHaveCount(0)
      await inbox.getByRole('button', { name: 'Mark all read' }).click()
      await expect(page.locator('[data-slot="inbox-button"][data-unread]')).toHaveCount(0)
    }
    if (scene === 'settings') {
      await expect(page.getByLabel('Where "Configuration warnings" is shown')).toHaveValue('inbox')
      await page.getByLabel('Where "Configuration warnings" is shown').selectOption('off')
      await expect(page.getByLabel('Where "Configuration warnings" is shown')).toHaveValue('off')
    }
  })
}


test('expanded title-only Inbox guidance wraps completely inside the panel', async ({ page }) => {
  await page.goto('/preview.html?notices=inbox&longNotice=1')
  await page.locator('[data-slot="inbox-button"]').locator('..').click()
  const inbox = page.locator('[data-slot="inbox-list"]')
  const title = inbox.getByRole('button', { name: /background configuration warning/ })
  expect(await title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await title.click()
  const full = inbox.locator('[data-part="inbox-full-title"]')
  await expect(full).toHaveText(/including the final instruction: check the configuration file before the next run\.$/)
  expect(await full.evaluate(element => {
    const panel = element.closest('[data-slot="inbox-list"]')!.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    return rect.height > parseFloat(getComputedStyle(element).lineHeight) && element.scrollWidth <= element.clientWidth && rect.right <= panel.right && rect.left >= panel.left
  })).toBe(true)
  if (process.env.NOTICE_FRAME_DIR) await page.screenshot({ path: `${process.env.NOTICE_FRAME_DIR}/after-inbox-long-${process.env.NOTICE_FRAME_THEME ?? 'light'}.png` })
})
