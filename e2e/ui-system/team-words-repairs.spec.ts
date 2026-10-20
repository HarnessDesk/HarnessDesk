import { test, expect } from '@playwright/test'
import { closeFloatingTeamRail } from './team-frame-actions'

for (const theme of ['light', 'dark']) for (const scene of ['overview', 'wrap'] as const) {
  test(`Recorded merge and Work pick ${scene} in ${theme}`, async ({ page }) => {
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
      await closeFloatingTeamRail(page.locator('body'))
      await page.getByRole('tab', { name: 'Work', exact: true }).click()
      if (before) {
        const overview = page.locator('[data-slot="team-overview"]')
        await expect(overview).toBeVisible()
        await expect(overview).toContainText('2 attempts')
        await expect(overview).not.toContainText('Referee picked')
      } else {
        // Work now shows the recorded path. Inspect the Judge's actual pick,
        // keeping its two attempts separate from the person's later merge.
        const work = page.locator('[data-slot="run-workspace"][data-view="work"]')
        await expect(work).toBeVisible()
        await work.getByRole('button', { name: 'Full record', exact: true }).click()
        const record = work.getByRole('list', { name: 'Run timeline', exact: true })
        const judge = record.locator('[data-row="card-3-5"]')
        await expect(judge).toContainText('Judge')
        await expect(judge).toContainText('Picked')
        await judge.getByRole('button').click()
        const compared = page.locator('[data-slot="run-inspector"]').getByRole('region', { name: 'Compared attempts', exact: true }).locator('[data-slot="list-row"]')
        await expect(compared).toHaveCount(2)
        await expect(compared.first()).toContainText('Attempt A')
        await expect(compared.first()).toContainText('Picked')
        await expect(compared.last()).toContainText('Attempt B')
        await expect(compared.last()).toContainText('Not kept')
      }
    }
    if (process.env.TEAM_WORDS_REPAIRS_FRAMES) await page.screenshot({ path: `${process.env.TEAM_WORDS_REPAIRS_FRAMES}/${scene}-${before ? 'before' : 'after'}-${theme}.png` })
  })
}
