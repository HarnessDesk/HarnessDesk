import { expect, test } from '@playwright/test'
import path from 'node:path'

for (const theme of ['light', 'dark'] as const) {
  test(`the race opens the prefilled New Team form with editable attempts in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=form&theme=${theme}`)
    await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
    await expect(page.getByLabel('What should both try?')).toHaveValue('Fix the cart total')
    await expect(page.getByRole('combobox', { name: 'Agent for Attempt A', exact: true })).toHaveValue('codex')
    await expect(page.getByRole('combobox', { name: 'Agent for Attempt B', exact: true })).toHaveValue('claude-code')
    for (const attempt of ['A', 'B']) {
      const model = page.getByRole('combobox', { name: `Model for Attempt ${attempt}`, exact: true })
      await expect(model).toBeEnabled()
      await model.selectOption({ index: 1 })
      const effort = page.getByRole('combobox', { name: `Effort for Attempt ${attempt}`, exact: true })
      await expect(effort).toBeEnabled()
      await effort.selectOption({ index: 1 })
    }
    await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `after-race-${theme}.png`) })
  })

  test(`the form shows placeholder rows while its source is loading in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=loading&theme=${theme}`)
    const loading = page.getByLabel('Loading Team form')
    await expect(loading.locator('[data-slot="row"]')).toHaveCount(2)
    await expect(page.getByRole('status')).toHaveText('Reading the shape…')
    await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `loading-${theme}.png`) })
  })

  test(`Start names the missing task and clears its reason when ready in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=disabled&theme=${theme}`)
    await expect(page.getByRole('status')).toHaveText('Add a task first.')
    await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `disabled-${theme}.png`) })
    await page.getByLabel('What should both try?').fill('Fix the cart total')
    await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
    await expect(page.getByRole('status')).toHaveCount(0)
  })

  test(`Run again names each read before Start in ${theme}`, async ({ page }) => {
    for (const [scene, reason] of [['again-source', 'Reading the saved Flow and inputs…'], ['again-preview', 'Checking the earlier Run’s seats and inputs…']]) {
      await page.goto(`/preview.html?race-entry=${scene}&theme=${theme}`)
      await expect(page.getByRole('status')).toHaveText(reason!)
      await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled()
      if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `${scene}-${theme}.png`) })
    }
  })

  test(`a comparison opens on its tiles with Overview one tab away in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=tiles&theme=${theme}`)
    await expect(page.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
    await expect(page.locator('[data-slot="team-overview"]')).toHaveCount(0)
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `tiles-${theme}.png`) })
    await page.getByRole('tab', { name: /^Overview/ }).click()
    await expect(page.locator('[data-slot="team-overview"]')).toBeVisible()
  })

  test(`a comparison keeps a removed tile off the grid when returning to Chat in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?race-entry=tiles&theme=${theme}`)
    const tiles = page.locator('[data-slot="side-by-side-tile"]')
    await expect(tiles).toHaveCount(2)
    await tiles.last().getByRole('button', { name: / actions$/ }).click()
    await page.getByRole('menuitem', { name: 'Take off the grid', exact: true }).click()
    await expect(tiles).toHaveCount(1)
    await page.getByRole('tab', { name: /^Overview/ }).click()
    await expect(page.locator('[data-slot="team-overview"]')).toBeVisible()
    await page.getByRole('tab', { name: /^Chat/ }).click()
    await expect(tiles).toHaveCount(1)
    if (process.env.HD_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.HD_FRAMES_DIR, `tiles-choice-${theme}.png`) })
  })
}
