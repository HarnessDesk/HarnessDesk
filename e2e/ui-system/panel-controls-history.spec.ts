import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`WindowControls catalogue renders its sidebar and history states in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/design.html?view=panel-controls&theme=${theme}`)
    await expect(page.getByRole('heading', { name: 'Window · panel controls', exact: true })).toBeVisible()
    await page.screenshot({ path: process.env.PANEL_CONTROLS_FRAMES
      ? `${process.env.PANEL_CONTROLS_FRAMES}/${theme}.png` : testInfo.outputPath(`${theme}.png`) })

    const cases = page.locator('figure').first().locator('[data-measure="page"] > div > div')
    await expect(cases).toHaveCount(3)
    const labels = [
      ['Hide sidebar', 'Back', 'Forward'],
      ['Show sidebar', 'Search everything', 'Back', 'Forward'],
      ['Show sidebar', 'Search everything', 'Back', 'Forward'],
    ]
    for (const [index, names] of labels.entries()) {
      const specimen = cases.nth(index)
      await expect.poll(() => specimen.locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(names)
      for (const name of names) await expect(specimen.getByRole('button', { name, exact: true })).toBeVisible()
      for (const name of ['Back', 'Forward']) {
        const arrow = specimen.getByRole('button', { name, exact: true })
        if (index === 2) await expect(arrow).toBeDisabled()
        else await expect(arrow).toBeEnabled()
      }
    }
  })
}
