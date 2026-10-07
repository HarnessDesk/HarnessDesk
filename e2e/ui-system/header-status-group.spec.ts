import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/preview.html?header-status')
})

for (const dismiss of ['row', 'outside'] as const) {
  test(`pointer ${dismiss} dismissal leaves returned header focus quiet`, async ({ page }) => {
    const trigger = page.locator('header button[aria-label*=" — "]').first()
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    if (dismiss === 'row') await menu.getByRole('menuitem').first().click()
    else await page.locator('h2').click()
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(0)
  })
}

test('keyboard focus and menu Escape still open the labelled card', async ({ page }) => {
  const group = page.locator('header [role="group"][aria-label="Conversation status"]')
  await page.keyboard.press('Tab')
  await expect(group).toBeFocused()
  await expect(page.locator('[data-slot="hover-card-content"]')).toBeVisible()
  const trigger = page.locator('header button[aria-label*=" — "]').first()
  await page.keyboard.press('Tab')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(page.locator('[data-slot="hover-card-content"]')).toBeVisible()
})

test('the review scenes select the git trigger and open its menu', async ({ page }) => {
  const source = readFileSync('script/shots/shoot.mjs', 'utf8')
  const selector = source.match(/const openGitMenu = async \(\) => \{\s*if \(!\(await press\(\{ selector: '([^']+)'/)?.[1]
  expect(selector).toBeDefined()
  const trigger = page.locator(selector!).first()
  await expect(trigger).toHaveAccessibleName(/feat\/worktrees/)
  await trigger.click()
  await expect(page.getByRole('menu').getByRole('menuitem', { name: /^Changes/ })).toBeVisible()
})

test('a reduced-motion narrow header keeps running distinct from idle', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 900 })
  const bar = page.locator('[data-frame-id="header-status-conversation"] header')
  const dot = bar.locator('[data-slot="header-status-reading"]').filter({ has: page.locator('[data-slot="dot"]') }).first().locator('[data-slot="dot"]')
  const idle = await dot.evaluate((node) => getComputedStyle(node).borderRadius)
  await page.goto('/preview.html?header-status&running')
  await expect(dot).toHaveAttribute('data-pulse', '')
  expect(await dot.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
  expect(await dot.evaluate((node) => getComputedStyle(node).borderRadius)).not.toBe(idle)
})
