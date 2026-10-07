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

test('a phone header keeps room for slightly wider text metrics', async ({ page }) => {
  await page.setViewportSize({ width: 340, height: 800 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  const bar = page.locator('[data-frame-id="conversation-composer"] header')
  // CI's text metrics used five more pixels than this Mac. Keep that margin.
  await bar.getByRole('group', { name: 'Conversation status', exact: true }).evaluate((node) => { (node as HTMLElement).style.paddingRight = '5px' })
  expect(await bar.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0)
})

test('every grouped header Tab stop has an unclipped focus ring', async ({ page }) => {
  const group = page.locator('header [role="group"][aria-label="Conversation status"]')
  const stops = 1 + await group.locator('button').count()
  expect(stops).toBe(6)
  for (let index = 0; index < stops; index++) {
    await page.keyboard.press('Tab')
    const clipped = await group.evaluate((node) => {
      const target = document.activeElement as HTMLElement
      if (!node.contains(target)) throw new Error('Tab left the status group')
      const style = getComputedStyle(target)
      const outset = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
      if (style.outlineStyle === 'none' || outset < 4) throw new Error('No full focus ring')
      const ring = target.getBoundingClientRect()
      const cuts: string[] = []
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor)
        const box = ancestor.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(css.overflowX) && (ring.left - outset < box.left || ring.right + outset > box.right)) cuts.push(`${ancestor.dataset['slot']}: horizontal`)
        if (/hidden|clip|auto|scroll/.test(css.overflowY) && (ring.top - outset < box.top || ring.bottom + outset > box.bottom)) cuts.push(`${ancestor.dataset['slot']}: vertical`)
      }
      return cuts
    })
    expect(clipped).toEqual([])
  }
})

test('a keyboard-opened plan menu stays above a closed status card', async ({ page }) => {
  await page.clock.install()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  // Observe through Base UI's 420ms delayed focus-open, not just the close on click.
  await page.clock.runFor(650)
  await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(0)
})

test('a pointer-opened menu returns quietly after Escape', async ({ page }) => {
  await page.clock.install()
  const trigger = page.locator('header button[aria-label*=" — "]').first()
  await trigger.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.clock.runFor(650)
  await expect(page.locator('[data-slot="hover-card-content"]')).toHaveCount(0)
})

test('a folded group never adds a second native tooltip', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 900 })
  const group = page.locator('header [role="group"][aria-label="Conversation status"]')
  await group.hover()
  await expect(page.locator('[data-slot="hover-card-content"]')).toBeVisible()
  await expect(group.locator('[title]')).toHaveCount(0)
})
