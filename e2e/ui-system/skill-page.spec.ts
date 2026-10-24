import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

for (const theme of ['light', 'dark'] as const) {
  test(`Library skill detail route, definition card and 320px facts ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library&frame-detail=skill&frame-name=code-review', theme, 1440)
    const detail = page.locator('[data-slot="skill-page"]')
    await expect(detail.getByRole('heading', { name: 'code-review', exact: true })).toBeVisible()
    await expect(detail.getByRole('button', { name: 'Use in composer', exact: true })).toBeVisible()
    await expect(detail.getByRole('region', { name: 'Definition', exact: true })).toContainText('SKILL.md')
    const rail = detail.locator('[data-slot="skill-page-facts"]')
    expect(Math.round((await rail.boundingBox())!.width)).toBe(320)
    await expect(rail.locator('[aria-label="Loaded by"] [data-slot="row"]')).toHaveCount(3)
    await expect(detail.locator('[data-slot="empty-state"]')).toHaveCount(0)
    if (process.env.HD_L3_A_FRAMES) {
      await mkdir(process.env.HD_L3_A_FRAMES, { recursive: true })
      await page.screenshot({ path: `${process.env.HD_L3_A_FRAMES}/skill-page-${theme}.png` })
    }
    await detail.getByRole('radio', { name: 'Source', exact: true }).click()
    await expect(detail.getByRole('region', { name: 'Definition' }).locator('pre')).toContainText('name: code-review')
    await detail.getByRole('button', { name: 'Back to Customize', exact: true }).click()
    await expect(page.locator('[data-slot="skill-cards"]')).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).first().click()
    await expect(detail).toBeVisible()
    await page.setViewportSize({ width: 720, height: 900 })
    await expect.poll(() => detail.locator('[data-slot="skill-page-columns"]').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
  test(`Library missing skill has a short state and a way back ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library&frame-detail=skill&frame-name=removed', theme)
    const empty = page.locator('[data-page-destination="library"] [data-slot="empty-state"]')
    await expect(empty.getByRole('heading', { name: 'Skill not found', exact: true })).toBeVisible()
    await expect(empty.locator('p')).toHaveCount(0)
    await empty.getByRole('button', { name: 'Back to Customize', exact: true }).click()
    await expect(page.locator('[data-slot="skill-cards"]')).toBeVisible()
  })
}

for (const theme of ['light', 'dark'] as const) for (const state of ['healthy', 'findings'] as const) {
  test(`Library skill page ${state} facts and findings ${theme}`, async ({ page }) => {
    await openFrame(page, `frame-wall=library&frame-detail=skill&frame-name=code-review&frame-skill-state=${state}`, theme, 1440)
    const detail = page.locator('[data-slot="skill-page"]')
    for (const label of ['Loaded by', 'Source', 'Files', 'Cost']) await expect(detail.locator(`[data-slot="tool-section"][aria-label="${label}"]`)).toBeVisible()
    await expect(detail.getByRole('region', { name: 'Update', exact: true })).toHaveCount(0)
    const banners = detail.locator('[data-slot="alert"]')
    if (state === 'healthy') await expect(banners).toHaveCount(0)
    else {
      await expect(banners).toHaveCount(1)
      await expect(banners.filter({ hasText: 'missing field `description`' })).toBeVisible()
      await expect(banners.locator('[data-slot="alert-title"]')).toHaveText('Alpha')
      await expect(banners.locator('[data-slot="alert-description"]')).toHaveText('missing field `description`')
      expect(await banners.evaluateAll(nodes => nodes.every(node => node.getAttribute('data-tone') === 'warning'))).toBe(true)
      const columns = (await detail.locator('[data-slot="skill-page-columns"]').boundingBox())!
      const banner = (await banners.boundingBox())!
      expect(Math.abs(banner.x - columns.x)).toBeLessThan(1)
      expect(Math.abs(banner.width - columns.width)).toBeLessThan(1)
      await expect(detail).not.toContainText('would not load this one.')
      await page.getByRole('button', { name: 'More', exact: true }).click()
      const menu = page.getByRole('menu')
      await expect(menu.getByRole('menuitem', { name: /Install to/ })).toBeVisible()
      await expect(menu.locator('[data-menu-note]')).toHaveText('Alpha would not load this one.')
      await page.keyboard.press('Escape')
    }
    await detail.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(detail.getByRole('region', { name: 'Source', exact: true })).toContainText('acme-dev/skills')
    await detail.getByRole('button', { name: 'Cost', exact: true }).click()
    await expect(detail.getByRole('region', { name: 'Cost', exact: true })).toContainText('Every turn')
    if (process.env.HD_L3_B_FRAMES) {
      await mkdir(process.env.HD_L3_B_FRAMES, { recursive: true })
      await page.screenshot({ path: `${process.env.HD_L3_B_FRAMES}/skill-page-${state}-${theme}.png`, fullPage: true })
      await detail.evaluate(node => {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.scrollHeight > parent.clientHeight) parent.scrollTop = parent.scrollHeight
      })
      await expect(detail.getByRole('region', { name: 'Cost', exact: true })).toBeVisible()
      await page.screenshot({ path: `${process.env.HD_L3_B_FRAMES}/skill-page-${state}-${theme}-facts.png`, fullPage: true })
    }
    await page.setViewportSize({ width: 720, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
