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
    // Overview includes both accounts, including the healthy cached report.
    const sources = page.getByText('from its own cache', { exact: true })
    await expect(sources).toHaveCount(2)
    await expect(sources.nth(0)).toBeVisible()
    await expect(sources.nth(1)).toBeVisible()
    await expect(page.getByText("from the agent's own cache", { exact: false })).toHaveCount(0)
  })

  test(`seat catalogue explains runtime chips while preserving the Agent role in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/design.html?view=seat-rows')
    await expect(page.getByText('Three Seats of one role,', { exact: false })).toBeVisible()
    await expect(page.getByText('Mounting the screen…', { exact: true })).toHaveCount(0)
    // The rows themselves, not the copy about them (#1724): the surface seeds
    // the sidebar's row source — the history the shipped list reads — with
    // three Seats of one role, and the assertion fails if the specimen falls
    // back to the generic rows or loses one of the three.
    while (await page.getByRole('button', { name: 'Show more', exact: true }).count() > 0) {
      await page.getByRole('button', { name: 'Show more', exact: true }).first().click()
    }
    const seatRows = page.getByRole('button', { name: 'Code reviewer', exact: true })
    await expect(seatRows).toHaveCount(3)
    // Each row wears its runtime chip on the title's own line — the runtime's
    // mark, named in the runtime's presented words (rule 8). The fixture's
    // three runtimes present as Alpha, Beta and Gamma, one per Seat; a
    // regression that drops the mark or seats two rows on one runtime fails
    // here. The row's own facts line reads the same runtime as its chip.
    const chips = await seatRows.evaluateAll((rows) =>
      rows.map((row) => ({
        mark: [...row.querySelectorAll('span[aria-label]')].map((span) => span.getAttribute('aria-label')),
        facts: row.getAttribute('title'),
      })),
    )
    for (const chip of chips) expect(chip.mark).toHaveLength(1)
    expect(chips.map((chip) => chip.mark[0]).sort()).toEqual(['Alpha', 'Beta', 'Gamma'])
    for (const chip of chips) expect(chip.facts).toContain(chip.mark[0]!)
    await page.evaluate(async () => { await document.fonts.ready })
    await capture(page, 'catalogue-seat-rows', theme)
    await expect(page.getByText('Three Seats of one role, one per runtime, all titled by the role — at compact density the runtime is a chip on the title line, drawn only where rows from more than one runtime share a title.', { exact: true })).toBeVisible()
  })
}
