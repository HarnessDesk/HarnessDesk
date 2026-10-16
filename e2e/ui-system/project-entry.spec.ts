import { expect, test } from '@playwright/test'

const preview = '/src/preview/project-entry.html'

test('the empty composer and both sidebar entries open one folder picker with keyboard access', async ({ page }) => {
  await page.goto(preview)
  const open = page.getByRole('button', { name: 'Open a folder…', exact: true })
  await expect(open).toBeEnabled()
  await open.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Open a project folder' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(open).toBeFocused()
  await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
  const menuEntry = page.getByRole('menuitem', { name: 'Open folder…', exact: true })
  await menuEntry.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Open a project folder' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Open a project folder', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Open a project folder' })).toBeVisible()
})

test('catalogue totals leave sidebar labels quiet', async ({ page }) => {
  await page.goto(preview)
  for (const label of ['Agents', 'Plugins']) {
    const row = page.getByRole('button', { name: label, exact: true }).locator('..')
    await expect(row.locator('[data-left-mark]')).toHaveCount(0)
  }
})

test('a finished Team stays under its project with attention until wrapped', async ({ page }) => {
  await page.goto(`${preview}?scene=finished`)
  const team = page.getByRole('button', { name: 'Room Finish checkout retry', exact: true })
  await expect(team).toBeVisible()
  const attention = team.locator('..').locator('[data-slot="sidebar-menu-state"]')
  await expect(attention).toHaveAccessibleName('Ready to wrap')
  await expect(attention).toBeVisible()
  await expect(team.locator('xpath=ancestor::*[@data-project-root]')).toHaveAttribute('data-project-root', '/work/storefront')
  await page.getByRole('button', { name: 'Wrap Team', exact: true }).click()
  await expect(team).toHaveCount(0)
})

test('a finished Team whose project is gone stays hidden', async ({ page }) => {
  await page.goto(`${preview}?scene=finished&gone`)
  await expect(page.getByRole('button', { name: 'Wrap Team', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Room Finish checkout retry', exact: true })).toHaveCount(0)
})

test('Most used earns its section from recorded starts', async ({ page }) => {
  await page.goto(`${preview}?scene=shapes`)
  await expect(page.getByRole('region', { name: 'Most used', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'More shapes', exact: true }).getByRole('button', { name: 'Write and review', exact: true })).toBeVisible()
  await page.evaluate(() => localStorage.setItem('hd-team-shape-starts', JSON.stringify({ comparison: 1 })))
  await page.reload()
  const most = page.getByRole('region', { name: 'Most used', exact: true })
  await expect(most.getByRole('button', { name: 'Side by side', exact: true })).toBeVisible()
  await expect(most.getByRole('button')).toHaveCount(1)
})
