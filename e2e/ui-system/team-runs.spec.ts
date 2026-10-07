import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 800, 480]) {
    test(`trigger Runs keep their facts and gutter at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?team-frame=trigger-runs&theme=${theme}`)
      const team = page.locator('[data-slot="team-room"]')
      await team.getByRole('tab', { name: /^Runs/ }).click()
      const runs = team.locator('[data-slot="team-runs"]')
      await expect(runs).toBeVisible()
      await expect(runs.locator('[data-run]')).toHaveCount(3)
      await expect(runs.locator('[data-run]').first()).toHaveAttribute('data-run', 'trigger-run-3')
      await expect(runs).toContainText('2 of 3 answered')
      await expect(runs).toContainText('2 findings')
      await expect(runs).toContainText('$6.00 of $20.00 daily cap')
      const geometry = await runs.evaluate(el => {
        const table = el.querySelector('table')!.getBoundingClientRect()
        const bounds = el.getBoundingClientRect()
        return { overflow: el.scrollWidth > el.clientWidth, left: table.left - bounds.left, right: bounds.right - table.right }
      })
      expect(geometry.overflow).toBe(false)
      expect(geometry.left).toBeGreaterThan(12)
      expect(geometry.right).toBeGreaterThan(12)
      const directory = process.env.TEAM_RUNS_SHOTS_DIR
      if (directory) {
        expect(textReasons(await page.evaluate(COLLECT), { user: USER })).toEqual([])
        mkdirSync(directory, { recursive: true })
        await page.evaluate(async () => { await document.fonts.ready })
        await page.screenshot({ path: `${directory}/after-runs-${width}-${theme}.png` })
      }
      await runs.getByRole('button', { name: 'Pause all triggers' }).click()
      await expect(team.locator('header').first()).toContainText('Paused')
      await runs.getByRole('button', { name: 'Resume all triggers' }).click()
      await expect(team.locator('header').first()).toContainText('Armed')
      await runs.getByRole('searchbox', { name: 'Filter Runs' }).fill('Run 2')
      await expect(runs.locator('[data-run]')).toHaveCount(1)
      await runs.getByRole('button', { name: 'Open Run 2: Retry checkout after a payment timeout' }).click()
      await expect(team.locator('[data-slot="run-view"]')).toBeVisible()
      await team.getByRole('button', { name: 'Back to Runs' }).click()
      await expect(runs.getByRole('searchbox', { name: 'Filter Runs' })).toHaveValue('Run 2')
      await expect(runs.locator('[data-run]')).toHaveCount(1)
    })
  }
}
