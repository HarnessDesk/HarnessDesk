import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function capture(page: Page, scene: string, theme: string) {
  const directory = process.env.RUNTIME_COPY_RECORDS_FRAMES
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await page.screenshot({ path: `${directory}/${scene}-${theme}.png` })
}

for (const theme of ['light', 'dark'] as const) {
  test(`usage preview names its cached sources in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/runtime-copy-repair.html?scene=usage-overview')
    await expect(page.getByRole('button', { name: /Turns/ }).first()).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    await capture(page, 'usage-overview', theme)
    // Overview shows the accounts needing attention; the unit fixture check covers both cached reports.
    await expect(page.getByText('from its own cache', { exact: false })).toBeVisible()
    await expect(page.getByText("from the agent's own cache", { exact: false })).toHaveCount(0)
  })

  test(`seat catalogue explains runtime chips while preserving the Agent role in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=seat-rows')
    await expect(page.getByText('Three Seats of one role,', { exact: false })).toBeVisible()
    await expect(page.getByText('Mounting the screen…', { exact: true })).toHaveCount(0)
    await page.evaluate(async () => { await document.fonts.ready })
    await capture(page, 'catalogue-seat-rows', theme)
    await expect(page.getByText('Three Seats of one role, one per runtime, all titled by the role — at compact density the runtime is a chip on the title line, drawn only where rows from more than one runtime share a title.', { exact: true })).toBeVisible()
  })
}
