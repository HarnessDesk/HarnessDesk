import { expect, test, type Page } from '@playwright/test'

const before = process.env.NOTICES_D3_BEFORE === '1'
const seed = async (page: Page) => {
  await page.route('**/src/preview/frame-destination-store.ts*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    expect(source).toContain('return store;')
    await route.fulfill({ response, body: 'import { installNoticesD3 } from "/src/preview/notices-d3-fixture.ts";\n' + source.replace('return store;', 'installNoticesD3(store); return store;') })
  })
}
for (const theme of ['light', 'dark'] as const) {
  test(`usage gates and distinct title/detail, ${theme}`, async ({ page }) => {
    await seed(page)
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    for (const scene of ['fresh', 'roomy', 'low', 'dashboard']) {
      await page.goto(`/preview.html?frame-wall=${scene === 'dashboard' ? 'dashboard' : 'conversation'}&theme=${theme}&notices-d3=${scene === 'dashboard' ? 'roomy' : scene}`)
      const frame = page.locator('[data-frame-id="frame-wall"]')
      await expect(frame).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const notice = frame.locator('[data-slot="composer-notice"], [data-slot="notice-strip"]').filter({ hasText: 'will run out before it refills' })
      const visible = before || scene === 'low' || scene === 'dashboard'
      await expect(notice).toHaveCount(visible ? 1 : 0)
      if (visible) {
        const title = notice.locator('[data-part="notice-title"]'), detail = notice.locator('[data-part="notice-detail"]')
        await expect(title).toBeVisible()
        await expect(detail).toBeVisible()
        if (!before) await expect(title).toHaveText(/refills\.$/)
      }
      if (process.env.NOTICES_D3_FRAMES && scene !== 'dashboard') await page.screenshot({ path: `${process.env.NOTICES_D3_FRAMES}/${before ? 'before' : 'after'}-${scene}-${theme}.png` })
    }
  })
  test(`a waiting Team pick opens and clears from Inbox, ${theme}`, async ({ page }) => {
    await seed(page)
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}&notices-d3=waiting`)
    await expect(page.locator('[data-frame-id="frame-wall"]')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.locator('[data-slot="inbox-button"]').locator('..').click()
    if (before) await expect(page.getByText('Nothing kept yet')).toBeVisible()
    else {
      await page.getByRole('menuitem', { name: /Retry the checkout call/ }).click()
      await expect(page.getByText('Your pick is next', { exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Open the Team', exact: true })).toBeVisible()
    }
    if (process.env.NOTICES_D3_FRAMES) await page.screenshot({ path: `${process.env.NOTICES_D3_FRAMES}/${before ? 'before' : 'after'}-waiting-${theme}.png` })
    if (before) return
    await page.getByRole('menuitem', { name: 'Open the Team', exact: true }).click()
    await expect(page.locator('[data-team-page="overview"]')).toHaveAttribute('aria-selected', 'true')
    const pending = page.getByRole('region', { name: 'Pending', exact: true })
    await expect(pending).toContainText('A decision is waiting')
    await pending.getByRole('button', { name: 'Open task', exact: true }).click()
    const detail = page.locator('[data-frame-region="right"] [data-slot="run-inspector"]')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('Your pick is next')
    await expect(detail.getByRole('button', { name: 'Kept', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close pane', exact: true }).click()
    // The host can also report an answer from another session. Its kept
    // notification clears the same attention entry and Inbox row.
    await page.evaluate(() => (window as unknown as { noticesD3: { answer(): void } }).noticesD3.answer())
    await expect(pending).toHaveCount(0)
    await page.locator('[data-slot="inbox-button"]').locator('..').click()
    await expect(page.getByRole('menuitem', { name: /Retry the checkout call/ })).toHaveCount(0)
  })
}
