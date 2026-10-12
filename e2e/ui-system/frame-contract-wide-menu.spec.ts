import { openWallDestination } from './frame-wall-actions'
import { expect, test } from '@playwright/test'
import { WALL_THEMES } from './frame-wall-destinations'
import { FRAME_MENU } from '../../packages/ui/src/design/frame'
import { openFrame, expectMenuGeometry } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C4 wide menu search and footer at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=wide', theme, width)
    await page.getByRole('button', { name: 'Frame wide menu', exact: true }).click()
    const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
    await expectMenuGeometry(surface)
    const input = surface.locator('[data-menu-search] input')
    expect((await input.boundingBox())!.height).toBe(FRAME_MENU.searchHeight)
    const footer = surface.locator('[data-menu-footer]')
    await expect(footer).toBeVisible()
    expect(await footer.evaluate(el => el.previousElementSibling?.getAttribute('role'))).toBe('separator')
    const firstLabel = surface.locator('[data-menu-label]').first()
    expect((await firstLabel.boundingBox())!.height).toBeGreaterThan(FRAME_MENU.labelLine)
    expect(await firstLabel.evaluate(el => getComputedStyle(el).whiteSpace)).not.toBe('nowrap')
    await input.fill('发布')
    await expect(surface.locator('[data-menu-row]')).toHaveCount(1)
    await expectMenuGeometry(surface)
  })
  test(`C4 missing usage keeps its reading column at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=metered', theme, width)
    await page.getByRole('button', { name: 'Frame metered menu', exact: true }).click()
    const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
    await expectMenuGeometry(surface)
    const xs = await surface.locator('[data-slot="usage-meter-row"]').evaluateAll(rows => rows.map(row => row.querySelector('[data-meter-column="reading"]')!.getBoundingClientRect().left))
    expect(xs).toHaveLength(2)
    expect(xs[0]).toBe(xs[1])
  })
  for (const plan of ['anchor', 'rest']) {
    test(`C4 actual plan usage ${plan} at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=conversation&popup=${plan === 'rest' ? 'other-agents' : 'plan-usage'}`, theme, width)
      const trigger = page.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))')
      await openWallDestination(page, { plan: plan as 'anchor' | 'rest' })
      const surface = page.locator('[data-popup-kind="wide-menu"]:visible').last()
      await expectMenuGeometry(surface)
      await expect(surface.locator('[data-slot="usage-meter-row"]')).not.toHaveCount(0)
      const columns = await surface.locator('[data-slot="usage-meter-row"]').evaluateAll(rows => rows.map(row => ({ reading: row.querySelector('[data-meter-column="reading"]')!.getBoundingClientRect().left, reset: row.querySelector('[data-meter-column="reset"]')?.getBoundingClientRect().left ?? null })))
      if (plan === 'rest') {
        const note = surface.locator('[data-menu-note]').filter({ hasText: 'No usage reported' })
        await expect(note).toHaveCount(1)
        await expect(note).toBeVisible()
        await expect(surface.locator('[data-menu-hint]').filter({ hasText: 'No usage reported' })).toHaveCount(0)
        expect((await surface.innerText()).match(/No usage reported/g)).toHaveLength(1)
      }
      const resets = columns.map(row => row.reset).filter(x => x !== null)
      expect(new Set(resets).size).toBeLessThanOrEqual(1)
      const details = surface.locator('[data-usage-details]')
      await expect(details.getByRole('menuitem', { name: 'Open usage', exact: true })).toBeVisible()
      await expect(details.locator('[data-menu-note]').last()).toBeVisible()
      expect((await details.locator('[data-menu-note]').last().innerText()).trim().length).toBeGreaterThan(4)
      expect(await page.locator('[data-popup-kind="info-card"]:visible').count()).toBe(0)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    })
  }
}


for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C5 branch search and entry at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await openWallDestination(page, { git: true, branch: true })
    const flyout = page.locator('[data-slot="dropdown-menu-sub-content"]:visible').last()
    await expectMenuGeometry(flyout)
    const input = flyout.locator('[data-menu-search] input')
    await expect(input).toBeFocused()
    expect((await input.boundingBox())!.height).toBe(FRAME_MENU.searchHeight)
    await input.fill('发布')
    await expect(flyout.locator('[data-menu-row][role="menuitemradio"]')).toHaveCount(1)
    await expect(flyout.locator('[data-menu-label]').filter({ hasText: 'feature/发布前检查' })).toHaveCount(1)
    await input.fill('missing')
    await expect(flyout.locator('[data-menu-note]')).toContainText(['No branch matches.', 'Checking out a branch keeps the existing folder.'])
    await page.getByRole('menuitem', { name: 'Create and checkout new branch…', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Create and checkout new branch' })).toBeVisible()
    await expect(page.locator('[data-popup-kind]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Keep current branch', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeHidden()
  })

}
for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`C9 suggestion listbox uses the only row at ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=suggestions', theme, width)
    const list = page.getByRole('listbox')
    await expect(list).toBeVisible()
    await expect(list).toHaveAttribute('data-popup-kind', 'wide-menu')
    await expectMenuGeometry(list)
    await expect(list.getByRole('option')).toHaveCount(3)
    await expect(list.getByRole('option').last()).toHaveAttribute('aria-disabled', 'true')
    await page.getByRole('textbox', { name: 'Frame suggestion anchor' }).focus()
    await expect(page.getByRole('textbox', { name: 'Frame suggestion anchor' })).toBeFocused()
  })
  test(`C9 Select preserves selection with canonical geometry at ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&popup=select', theme, width)
    await page.getByRole('combobox', { name: 'Frame Select' }).click()
    const plate = page.locator('[data-slot="select-content"]')
    await expectMenuGeometry(plate)
    await page.getByRole('option', { name: 'Catalogue diagnostics and checkout retry policy' }).click()
    await expect(page.getByRole('combobox', { name: 'Frame Select' })).toContainText('Catalogue diagnostics and checkout retry policy')
    await expect(plate).toBeHidden()
    const trigger = page.getByRole('combobox', { name: 'Frame Select' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(plate).toBeVisible()
    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    await expect(trigger).toContainText('Scout — Storefront compatibility review')
    await expect(plate).toBeHidden()
    await expect(trigger).toBeFocused()
  })
}
