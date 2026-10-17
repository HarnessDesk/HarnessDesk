import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

const frame = async (page: Page, name: string) => {
  if (!process.env.HD_LIBRARY_UPDATE_FRAMES) return
  await mkdir(process.env.HD_LIBRARY_UPDATE_FRAMES, { recursive: true })
  await page.screenshot({ path: `${process.env.HD_LIBRARY_UPDATE_FRAMES}/${name}.png` })
}
const openSkill = async (page: Page) => {
  await page.locator('[data-slot="skill-card"]').first().click()
  return page.getByRole('dialog', { name: 'Code review', exact: true })
}
for (const theme of ['light', 'dark'] as const) {
  test(`Library explicit update check and review ${theme}`, async ({ page }) => {
    await openFrame(page, 'library-updates=unchecked', theme)
    await page.setViewportSize({ width: 1440, height: 1100 })
    await expect(page.locator('[data-slot="skill-card"]')).not.toContainText('Update available')
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await bar.getByRole('button', { name: 'More', exact: true }).click()
    const labels = await page.getByRole('menuitem').allTextContents()
    expect(labels.slice(0, 2)).toEqual(['Check for updates', 'Rescan'])
    expect(labels).not.toContain('Add from GitHub…')
    await page.getByRole('menuitem', { name: 'Check for updates', exact: true }).click()
    await expect(page.locator('[data-slot="skill-card"]')).toContainText('Update available')
    await frame(page, `row-${theme}`)
    const sheet = await openSkill(page)
    await expect(sheet.getByText('Update available', { exact: true })).toBeVisible()
    await expect(sheet.getByText('1a2b3c4 → 9f8e7d6', { exact: true })).toBeVisible()
    await expect(sheet.getByText('review/code-review · main, pinned at 1a2b3c4', { exact: true })).toBeVisible()
    await frame(page, `sheet-${theme}`)
    await sheet.getByRole('button', { name: 'Review update…', exact: true }).click()
    const plan = page.getByRole('dialog', { name: 'Update code-review', exact: true })
    await expect(plan.getByText('Changed · 1.2 KB', { exact: true })).toBeVisible()
    await expect(plan.getByText('Added · 142 B', { exact: true })).toBeVisible()
    await expect(plan.getByText('Removed · 420 B', { exact: true })).toBeVisible()
    await expect(plan.locator('table')).toBeVisible()
    await expect(plan.getByRole('button', { name: 'Read', exact: true })).toHaveCount(1)
    await expect(plan.getByRole('button', { name: 'Apply 1 change', exact: true })).toBeDisabled()
    await expect(plan.getByText(/backed up/i)).toHaveCount(0)
    await frame(page, `clean-${theme}`)
    await plan.getByRole('button', { name: 'Read', exact: true }).click()
    await expect(plan.locator('[data-slot="code-block-body"]')).toContainText('git diff --check')
    await plan.getByRole('checkbox', { name: 'I read the file that can run', exact: true }).check()
    await expect(plan.getByRole('button', { name: 'Apply 1 change', exact: true })).toBeEnabled()
    expect(await plan.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await plan.getByRole('button', { name: 'Apply 1 change', exact: true }).click()
    await expect(plan.getByTestId('apply-summary')).toHaveText('1 change made.')
    await plan.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(page.locator('[data-slot="skill-card"]')).not.toContainText('Update available')
  })
  test(`Library edited-copy update review ${theme}`, async ({ page }) => {
    await openFrame(page, 'library-updates=edited', theme)
    await page.setViewportSize({ width: 1440, height: 1100 })
    const sheet = await openSkill(page)
    await sheet.getByRole('button', { name: 'Review update…', exact: true }).click()
    const plan = page.getByRole('dialog', { name: 'Update code-review', exact: true })
    await expect(plan.getByText('This copy has been edited since install; the edited copy is backed up before replacement.', { exact: true })).toBeVisible()
    await expect(plan.getByText('The current copy is backed up before this happens.', { exact: true })).toBeVisible()
    await expect(plan.locator('table')).toBeVisible()
    await expect(plan.getByRole('button', { name: 'Apply 1 change', exact: true })).toBeDisabled()
    await frame(page, `edited-${theme}`)
  })
  for (const status of ['unchecked', 'current', 'gone', 'unreachable'] as const) test(`Library ${status} source facts ${theme}`, async ({ page }) => {
    await openFrame(page, `library-updates=${status}`, theme)
    await page.setViewportSize({ width: 1440, height: 1100 })
    const sheet = await openSkill(page)
    await expect(sheet.getByText('Where it came from', { exact: true })).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Review update…', exact: true })).toHaveCount(0)
    if (status === 'gone') await expect(sheet.getByText('The branch main no longer exists in acme-dev/skills.', { exact: true })).toBeVisible()
    if (status === 'unreachable') await expect(sheet.getByText('Could not check: The repository did not answer. Try again later.', { exact: true })).toBeVisible()
    await frame(page, `${status}-${theme}`)
  })
}
