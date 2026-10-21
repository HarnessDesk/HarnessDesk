import { expect, test } from '@playwright/test'
import path from 'node:path'
import { closeFloatingTeamRail } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`the race opens the prefilled New Team form with editable attempts in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=form&theme=${theme}`)
    await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
    await expect(page.getByLabel('What should both try?')).toHaveValue('Fix the cart total')
    await expect(page.getByRole('button', { name: 'Configure Attempt A', exact: true })).toHaveText('Runtime 1 · Opus')
    await expect(page.getByRole('button', { name: 'Configure Attempt B', exact: true })).toHaveText('Runtime 2 · Opus')
    for (const attempt of ['A', 'B']) {
      const configure = page.getByRole('button', { name: `Configure Attempt ${attempt}`, exact: true })
      await configure.click()
      await expect(page.getByRole('group', { name: `Attempt ${attempt} configuration`, exact: true })).toBeVisible()
      const model = page.getByRole('button', { name: `Model for Attempt ${attempt}`, exact: true })
      await expect(model).toBeEnabled()
      await model.click()
      await page.getByRole('menuitemradio').nth(1).click()
      const effort = page.getByRole('button', { name: `Effort for Attempt ${attempt}`, exact: true })
      await expect(effort).toBeEnabled()
      await effort.click()
      await page.getByRole('menuitemradio').nth(1).click()
      await expect(effort).toHaveText('High')
      await page.keyboard.press('Escape')
      await expect(configure).toHaveAttribute('aria-expanded', 'false')
      await expect(configure).toBeFocused()
      await expect(model).toHaveCount(0)
    }
    await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `after-race-${theme}.png`) })
  })

  test(`the form shows placeholder rows while its source is loading in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=loading&theme=${theme}`)
    const loading = page.getByLabel('Loading Team form')
    await expect(loading.locator('[data-slot="row"]')).toHaveCount(2)
    await expect(page.locator('#team-start-reason')).toHaveText('Reading the shape…')
    const start = page.getByRole('button', { name: 'Start Team', exact: true })
    await expect(start).toBeDisabled()
    await expect(start).toHaveAccessibleDescription('Reading the shape…')
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `loading-${theme}.png`) })
  })

  test(`Start names the missing task and clears its reason when ready in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=disabled&theme=${theme}`)
    const reason = page.locator('#team-start-reason')
    const start = page.getByRole('button', { name: 'Start Team', exact: true })
    await expect(reason).toHaveText('Add a task first.')
    await expect(start).toBeDisabled()
    await expect(start).toHaveAccessibleDescription('Add a task first.')
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `disabled-${theme}.png`) })
    await page.getByLabel('What should both try?').fill('Fix the cart total')
    await expect(start).toBeEnabled()
    await expect(reason).toHaveCount(0)
    await expect(start).not.toHaveAttribute('aria-describedby')
  })

  test(`Run again names each read before Start in ${theme}`, async ({ page }) => {
    for (const [scene, reason] of [['again-source', 'Reading the saved Flow and inputs…'], ['again-preview', 'Checking the earlier Run’s seats and inputs…']]) {
      await page.goto(`/preview.html?race-entry=${scene}&theme=${theme}`)
      await expect(page.getByRole('status')).toHaveText(reason!)
      await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
      if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `${scene}-${theme}.png`) })
    }
  })

  test(`a comparison opens on Work and preserves its tiles in Chat in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=tiles&theme=${theme}`)
    await closeFloatingTeamRail(page.locator('body'))
    await expect(page.getByRole('tab', { name: 'Work', exact: true })).toHaveAttribute('aria-selected', 'true')
    const work = page.locator('[data-slot="run-workspace"][data-view="work"]')
    await expect(work).toBeVisible()
    await expect(work.locator('[data-slot="run-flow"]')).toBeVisible()
    await page.getByRole('tab', { name: /^Chat/ }).click()
    await page.getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click()
    await expect(page.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
    await expect(work).toHaveCount(0)
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `tiles-${theme}.png`) })
    await page.getByRole('tab', { name: 'Work', exact: true }).click()
    await expect(work).toBeVisible()
  })

  test(`a comparison keeps a removed tile off the grid when returning to Chat in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=tiles&theme=${theme}`)
    await closeFloatingTeamRail(page.locator('body'))
    const tiles = page.locator('[data-slot="side-by-side-tile"]')
    await page.getByRole('tab', { name: /^Chat/ }).click()
    await page.getByRole('button', { name: /^(Chat|Split)$/ }).click()
    await page.getByRole('menuitemradio', { name: 'Split', exact: true }).click()
    await expect(tiles).toHaveCount(2)
    const retained = await tiles.first().getAttribute('data-session-key')
    await tiles.last().getByRole('button', { name: / actions$/ }).click()
    await page.getByRole('menuitem', { name: 'Take off the grid', exact: true }).click()
    await expect(tiles).toHaveCount(1)
    await page.getByRole('tab', { name: 'Work', exact: true }).click()
    await expect(page.locator('[data-slot="run-workspace"][data-view="work"]')).toBeVisible()
    await page.getByRole('tab', { name: /^Chat/ }).click()
    await expect(tiles).toHaveCount(1)
    await expect(tiles.first()).toHaveAttribute('data-session-key', retained!)
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `tiles-choice-${theme}.png`) })
  })
}
