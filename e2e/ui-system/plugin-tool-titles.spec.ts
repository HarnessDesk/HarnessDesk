import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

const frames = process.env.PLUGIN_TOOL_FRAMES
for (const theme of ['light', 'dark'] as const) {
  test(`plugin tool titles and group reach note in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=plugins&frame-plugin-page=capabilities&frame-plugin-reach=1', theme)
    const tools = page.getByRole('region', { name: '14 tools', exact: true })
    await expect(tools).toBeVisible()
    if (frames) await page.screenshot({ path: `${frames}/capabilities-${theme}.png` })
    await expect(tools.locator('[data-slot="row-title"]').first()).toHaveText('Open a page')
    await expect(tools.locator('[data-slot="row-desc"]').first()).toHaveText('Browser')
    await expect(tools.locator('[data-slot="section-description"]')).toContainText('Reaches runtime')
    await expect(tools.locator('[data-slot="chip"]')).toHaveCount(0)
  })
  test(`plugin tool exceptions stay beside their titles in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=plugins&frame-plugin-page=capabilities', theme)
    const tools = page.getByRole('region', { name: '14 tools', exact: true })
    if (frames) await page.screenshot({ path: `${frames}/own-config-${theme}.png` })
    await expect(tools.locator('[data-slot="row-title-name"]').first()).toHaveText('Open a page')
    await expect(tools.locator('[data-slot="row-title-chip"]')).toHaveCount(14)
    await expect(tools.locator('[data-slot="row-title-chip"]').first()).toHaveText('Own config only')
  })
  test(`plugin detail keeps titles and whole descriptions in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=plugins&frame-plugin-page=detail', theme)
    const tools = page.getByRole('region', { name: 'Tools', exact: true })
    await expect(tools.locator('[data-slot="row-title"]').first()).toHaveText('Open a page')
    const description = tools.locator('[data-slot="row-desc"]').nth(2)
    await expect(description).toContainText('Prefer this over measuring a screenshot.')
    expect(await description.evaluate(element => getComputedStyle(element).whiteSpace)).toBe('normal')
    if (frames) await page.screenshot({ path: `${frames}/detail-${theme}.png` })
  })
}
