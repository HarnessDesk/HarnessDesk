import { expect, test } from '@playwright/test'

test('Side by side defaults to You and allows either attempt’s provider to judge', async ({ page }) => {
  await page.goto('/preview.html?team-start=comparison')
  const judge = page.getByRole('combobox', { name: 'Agent for Judge', exact: true })
  await expect(page.getByText('Judge · optional', { exact: true })).toBeVisible()
  await expect(judge.locator('option:checked')).toHaveText('You')
  await expect(page.getByRole('combobox', { name: 'Model for Judge' })).toHaveCount(0)
  await judge.selectOption('codex')
  await expect(judge.locator('option:checked')).toHaveText('Runtime 1')
  await expect(page.getByRole('combobox', { name: 'Model for Judge' })).toBeVisible()
  await judge.selectOption('')
  await expect(judge.locator('option:checked')).toHaveText('You')
})

test('/race defaults to You and offers both providers as judges', async ({ page }) => {
  await page.goto('/preview.html?optional-judge')
  const judge = page.getByRole('combobox', { name: 'Judge · optional', exact: true })
  await expect(judge.locator('option:checked')).toHaveText('You')
  await judge.selectOption('alpha')
  await expect(judge.locator('option:checked')).toHaveText('Runtime 1')
  await judge.selectOption('beta')
  await expect(judge.locator('option:checked')).toHaveText('Runtime 2')
  await judge.selectOption('')
  await expect(judge.locator('option:checked')).toHaveText('You')
})
