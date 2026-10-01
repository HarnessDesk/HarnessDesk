import { expect, test } from '@playwright/test'

const caseLabel = (page: import('@playwright/test').Page, label: string) =>
  page.getByText(label, { exact: true }).locator('..')

test('the catalogue renders shipped composer slots and Side by side cases', async ({ page }) => {
  await page.goto('/design.html?view=composer-fixed-slots')
  await expect(page.locator('[data-composer-layout="live"] [data-composer-track="model"]').first()).toBeVisible()

  await page.goto('/design.html?view=room-side-by-side')
  const rail = caseLabel(page, 'room rail — Side by side · disabled with its reason')
  await expect(rail).toBeVisible()
  await expect(rail.locator('[aria-disabled="true"]')).toContainText('Side by side')
  await expect(rail.locator('[aria-disabled="true"]')).not.toHaveAttribute('data-refused')
  await expect(rail).toContainText('Watch a member to put it here')

  const two = caseLabel(page, 'room — Side by side · two members, grid without a composer')
  await expect(two.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(two.locator('[data-slot="composer"]')).toHaveCount(0)
  await expect(two.getByRole('dialog')).toHaveCount(0)

  const waiting = caseLabel(page, 'room — Side by side · two members, waiting for you')
  await expect(waiting.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(waiting.getByRole('dialog', { name: 'Run this command?' })).toBeVisible()

  const four = caseLabel(page, 'room — Side by side · four members, tile states and ceiling')
  await expect(four.locator('[data-slot="side-by-side-tile"]')).toHaveCount(4)
  const tile = (nickname: string) => four.locator(`[data-slot="side-by-side-tile"][aria-label="${nickname}"]`)
  await expect(tile('Alpha').getByText('Working', { exact: true })).toBeVisible()
  await expect(tile('Alpha').getByText(/Edit.*Held/i)).toBeVisible()
  await expect(four.getByRole('dialog')).toHaveCount(0)
  await expect(tile('Beta').getByText('Done', { exact: true })).toBeVisible()
  await expect(tile('Gamma').getByText('Stopped', { exact: true })).toBeVisible()
  await expect(tile('Delta').getByText(/Working|Waiting for you|Done|Stopped/)).toHaveCount(0)

  const narrow = caseLabel(page, 'room — Side by side · narrow tabs with a waiting mark')
  await expect(narrow.getByRole('tablist', { name: 'Side by side tiles' })).toBeVisible()
  await expect(narrow.getByRole('tab', { name: /Beta/ }).getByLabel('waiting for you')).toBeVisible()
})

test('the catalogue renders refused and partial TurnFiles states', async ({ page }) => {
  await page.goto('/design.html?view=code')
  const refused = caseLabel(page, 'Undo refused: the unrecoverable file is named and the rest can be put back')
  await expect(refused).toBeVisible()
  await expect(refused.getByRole('button', { name: 'Undo the rest' })).toBeVisible()
  await expect(refused.getByRole('button', { name: /empty\.tsdeleted/ })).toBeVisible()
  await expect(page.getByText('Cannot put back /workspace/src/empty.ts: the agent recorded no content for it. Nothing was changed.')).toBeVisible()

  const partial = caseLabel(page, 'partial Undo: Close stays greyed until the half changed turn is resolved')
  await expect(partial).toBeVisible()
  await expect(partial.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(partial.getByRole('button', { name: 'Close' })).toBeDisabled()
})
