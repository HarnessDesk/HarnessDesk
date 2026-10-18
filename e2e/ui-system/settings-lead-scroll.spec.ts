import { expect, test } from '@playwright/test'

test.use({ screenshot: 'off', trace: 'retain-on-failure', video: 'off' })
for (const theme of ['light', 'dark'] as const) test(`Settings Lead groups stay whole and the body scrolls at 1280x480 in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.goto(`/preview.html?lead-synthetic=settings-configured&theme=${theme}`)
  const groups = page.locator('[data-slot="rows"]')
  await expect(groups).toHaveCount(4)
  for (const group of await groups.all()) {
    const metrics = await group.evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight, bottom: node.getBoundingClientRect().bottom, lastBottom: node.lastElementChild?.getBoundingClientRect().bottom ?? null }))
    expect(metrics.client).toBeGreaterThan(0)
    expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1)
    expect(metrics.lastBottom).not.toBeNull()
    expect(metrics.lastBottom!).toBeLessThanOrEqual(metrics.bottom + 1)
  }
  const body = page.locator('[data-slot="rows"]').first().locator('xpath=ancestor::*[contains(@class, "overflow-auto")][1]')
  await expect(body).toHaveCount(1)
  expect(await body.evaluate(node => node.scrollHeight > node.clientHeight + 1)).toBe(true)
  expect(await body.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop })).toBeGreaterThan(0)
})
