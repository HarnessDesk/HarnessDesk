import { test, expect } from '@playwright/test'

for (const theme of ['light', 'dark']) for (const scene of ['overview', 'wrap'] as const) {
  test(`Recorded merge and Overview pick ${scene} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 850 })
    await page.goto(`/preview.html?shape-graph&theme=${theme}`)
    await page.evaluate(async scene => {
      const fixture = await import('/src/preview/team-words-repairs-fixture.tsx')
      fixture.mountTeamWordsRepairPreview(scene)
    }, scene)
    const before = process.env.TEAM_WORDS_REPAIRS_BEFORE === '1'
    if (scene === 'wrap') {
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'What finished' })).toHaveValue(before
        ? /#1.*Kept\n#2.*Not kept/ : /#1.*Not kept\n#2.*Merged/)
      await expect(page.getByRole('combobox', { name: 'Disposition for #2 · Improve the session store' })).toHaveValue(before ? 'dropped' : 'finished')
    } else {
      await page.getByRole('tab', { name: 'Overview', exact: true }).click()
      const overview = page.locator('[data-slot="team-overview"]')
      await expect(overview).toBeVisible()
      await expect(overview).toContainText(before ? '2 attempts' : '2 attempts · Referee picked')
      if (before) await expect(overview).not.toContainText('Referee picked')
    }
    if (process.env.TEAM_WORDS_REPAIRS_FRAMES) await page.screenshot({ path: `${process.env.TEAM_WORDS_REPAIRS_FRAMES}/${scene}-${before ? 'before' : 'after'}-${theme}.png` })
  })
}
