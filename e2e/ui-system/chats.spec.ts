import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const open = async (page: Page, theme: 'light' | 'dark', query = '') => {
  await page.route('**/preview.html?chats*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('/src/preview/main.tsx', '/src/preview/chats.tsx') })
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?chats${query}`)
  await page.evaluate(() => document.fonts.ready)
}

for (const theme of ['light', 'dark'] as const) {
  test(`chats frames in ${theme}`, async ({ page }) => {
    const frames = process.env.CHATS_FRAMES_DIR
    await open(page, theme)
    await expect(page.getByText('What should we build?', { exact: true })).toBeVisible()
    if (!process.env.CHATS_BEFORE) {
      await page.getByRole('button', { name: 'Chats', exact: true }).click()
      await expect(page.getByText('Plan a weekend project', { exact: true })).toBeVisible()
    }
    if (frames) await page.screenshot({ path: path.join(frames, `${process.env.CHATS_BEFORE ? 'before' : 'after'}-composer-${theme}.png`) })
    await open(page, theme, '&view=settings')
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
    if (!process.env.CHATS_BEFORE) await expect(page.getByText('Chats folder', { exact: true })).toBeVisible()
    if (frames) await page.screenshot({ path: path.join(frames, `${process.env.CHATS_BEFORE ? 'before' : 'after'}-settings-${theme}.png`) })
  })

  test(`sends without a picker and clears an explicit folder in ${theme}`, async ({ page }) => {
    await open(page, theme)
    const folder = page.getByRole('button', { name: 'No folder', exact: true })
    await expect(folder).toHaveAttribute('title', 'Starts in /demo/chats')
    const input = page.locator('[data-slot="composer-text"]')
    await input.fill('Explain the retry budget')
    await page.locator('[data-slot="composer-send"]').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('data-sent-text', 'Explain the retry budget')
    await expect(page.locator('html')).toHaveAttribute('data-sent-folder', '/demo/chats/2026-10-16-demo02')
    await folder.click()
    await expect(page.getByRole('menuitemradio').first()).toHaveText('No folder')
    await page.getByRole('menuitem', { name: 'Choose folder…', exact: true }).click()
    await page.getByRole('button', { name: 'Open “custom”', exact: true }).click()
    await input.fill('Keep this draft')
    await page.locator('[data-composer-track="work-in"]').getByRole('button', { name: 'custom', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'No folder', exact: true }).click()
    await expect(folder).toBeVisible()
    await expect(input).toHaveValue('Keep this draft')
    await expect(page.getByRole('button', { name: /Work in|New worktree/ })).toHaveCount(0)
  })

  test(`a non-repository chat keeps file actions without Git actions in ${theme}`, async ({ page }) => {
    await open(page, theme, '&view=chat')
    await page.getByRole('button', { name: 'Folder actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Changes', exact: true })).toBeVisible()
    for (const name of ['History', 'Not a git branch', 'Commit the changes', 'Review uncommitted changes']) {
      await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(0)
    }
    if (process.env.CHATS_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.CHATS_FRAMES_DIR, `after-chat-${theme}.png`) })
  })

  test(`settings changes and resets the chats location in ${theme}`, async ({ page }) => {
    await open(page, theme, '&view=settings')
    await page.getByRole('button', { name: 'Change…', exact: true }).click()
    await page.getByRole('button', { name: 'Open “custom”', exact: true }).click()
    const row = page.locator('[data-slot="row"]').filter({ has: page.getByText('Chats folder', { exact: true }) })
    await expect(row.locator('[data-part="head"]')).toHaveText('/demo')
    await expect(row.locator('[data-part="tail"]')).toHaveText('/custom')
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(row.locator('[data-part="tail"]')).toHaveText('/chats')
  })
}
