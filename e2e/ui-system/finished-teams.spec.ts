import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  {

    for (const [item0, stage] of (['before', 'after'] as const).entries()) test(`finished Teams stop asking for the person in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 760 })
      await page.goto(`/preview.html?teams-page&finished=${stage}&theme=${theme}`)
      await page.locator('label').filter({ hasText: /^theme/ }).locator('select').first().selectOption(theme)
      await expect(page.locator('html')).toHaveCSS('color-scheme', theme)
      await page.evaluate(() => document.fonts.ready)
      const frame = page.locator('#teams-page-active')
      const needs=frame.locator('[data-slot="teams-board-column"][aria-label="Needs you"]')
      const ready=frame.locator('[data-slot="teams-board-column"][aria-label="Ready to wrap"]')
      if(stage==='before'){
        await expect(needs.locator('[data-team-row]')).toHaveCount(2)
        await expect(ready.locator('[data-team-row]')).toHaveCount(0)
      }else{
        await expect(ready.locator('[data-team-row="team-0"]')).toBeVisible()
        await expect(needs.locator('[data-team-row="team-1"]')).toContainText('stopped')
      }
      await frame.screenshot({ path: `output/playwright/finished-teams/${stage}-${theme}.png` })


    })
  }
}
