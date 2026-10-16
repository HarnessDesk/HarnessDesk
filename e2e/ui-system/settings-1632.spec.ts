import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { expectSettingsChrome } from './frame-page-contract'

const frames = process.env.SETTINGS_FRAMES_DIR
for (const theme of ['light', 'dark'] as const) {
  for (const [section, title] of [['general', 'General'], ['models', 'Models'], ['permissions', 'Permissions']] as const) {
    test(`${section} has one visible page title and a title-free bar in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=settings&frame-section=${section}&frame-settings-round4=1`, theme)
      const content = page.locator('[data-page-destination="settings"]:visible')
      await expect(content).toBeVisible()
      await expect(content.locator('[data-slot="rows"]').first()).toBeVisible()
      if (frames) {
        mkdirSync(frames, { recursive: true })
        await page.screenshot({ path: path.join(frames, `${section}-${theme}.png`) })
      }
      const heading = content.getByRole('heading', { name: title, exact: true, level: 1 })
      await expect(heading).toBeVisible()
      const geometry = await heading.evaluate(node => {
        const box = node.getBoundingClientRect()
        const css = getComputedStyle(node)
        const explanation = node.closest('[data-slot="page-options"]')!.nextElementSibling!.getBoundingClientRect()
        return { left: box.left, bottom: box.bottom, explanationLeft: explanation.left, explanationTop: explanation.top, size: css.fontSize }
      })
      expect(geometry.left).toBe(geometry.explanationLeft)
      expect(geometry.bottom).toBeLessThan(geometry.explanationTop)
      expect(parseFloat(geometry.size)).toBeGreaterThan(14)
      await expectSettingsChrome(page, 1440)
    })
  }
  test(`Permissions folds unused ceiling rows with a keyboard disclosure in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings&frame-section=permissions&frame-settings-round4=1', theme)
    const ceilings = page.getByRole('region', { name: 'Ceilings', exact: true })
    const disclosure = ceilings.getByRole('button', { name: /^Other agents · / })
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    const count = Number((await disclosure.innerText()).match(/· (\d+)/)![1])
    const visible = await ceilings.locator('[data-slot="row"]').count()
    await disclosure.focus()
    await page.keyboard.press('Enter')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    await expect(ceilings.locator('[data-slot="row"]')).toHaveCount(visible + count)
    if (frames) await page.screenshot({ path: path.join(frames, `permissions-expanded-${theme}.png`) })
    await page.keyboard.press('Space')
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(ceilings.locator('[data-slot="row"]')).toHaveCount(visible)
    await expect(disclosure).toBeFocused()
  })
}
