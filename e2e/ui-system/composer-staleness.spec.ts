import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`live replacement and stale saved defaults remain readable and clearable in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/preview.html?composer-slots')
    const surface = page.locator('[data-composer-staleness]')
    await expect(surface).toBeVisible()
    await surface.scrollIntoViewIfNeeded()
    const model = surface.locator('[data-composer-track="model"] button[aria-haspopup="dialog"]')
    const mode = surface.locator('[data-composer-track="mode"]')
    await expect(model).toContainText('Model A')
    await expect(model).toContainText('Low')
    await expect(mode.locator('button')).toBeDisabled()
    // Main's natural-width Mode/Permissions contract lets an empty extension
    // anchor follow the preceding label. Measure rendered controls, and keep
    // asserting that the extension has no action whose position could change.
    const extension = surface.locator('[data-composer-track="extension"]')
    await expect(extension.locator(':scope > *')).toHaveCount(0)
    const positions = () => surface.locator('[data-composer-track]').evaluateAll((nodes) => nodes
      .filter((node) => node.childElementCount > 0)
      .map((node) => [node.getAttribute('data-composer-track'), Math.round(node.getBoundingClientRect().x)]))
    const before = await positions()
    await surface.locator('[data-replace-options]').click()
    await expect(model).toContainText('model-a')
    await expect(model).not.toContainText('Low')
    await expect(model).toHaveAttribute('title', /Low/)
    expect(await model.getByText('model-a', { exact: true }).evaluate((label) => {
      const range = document.createRange()
      range.setStart(label.firstChild!, 0)
      range.setEnd(label.firstChild!, 1)
      const first = range.getBoundingClientRect()
      const bounds = label.getBoundingClientRect()
      return bounds.width > first.width && first.right <= bounds.right
    })).toBe(true)
    const unavailable = model.locator('[data-slot="chip"]')
    await expect(unavailable).toHaveText('Unavailable')
    expect(await unavailable.evaluate((chip) => {
      const words = chip.querySelector('[data-slot="chip-words"]')!
      const range = document.createRange()
      range.selectNodeContents(words)
      const text = range.getBoundingClientRect()
      const bounds = words.getBoundingClientRect()
      const track = chip.closest('[data-composer-track]')!.getBoundingClientRect()
      return text.width <= bounds.width + 1 && text.left >= track.left && text.right <= track.right
    })).toBe(true)
    await expect(model.getByLabel('Stale saved default')).toBeVisible()
    expect(await model.getByLabel('Stale saved default').evaluate((mark) => {
      const bounds = mark.getBoundingClientRect()
      const glyph = mark.querySelector('svg')!.getBoundingClientRect()
      return glyph.width >= 12 && glyph.left >= bounds.left && glyph.right <= bounds.right
    })).toBe(true)
    await expect(mode).toContainText('Plan')
    await expect(mode.locator('button')).toBeEnabled()
    await expect(surface).toContainText('Saved Model: Model A')
    await expect(surface).toContainText('This value is no longer offered.')
    expect(await positions()).toEqual(before)
    await expect(extension.locator(':scope > *')).toHaveCount(0)
    await expect(surface.locator('[data-setter-count]')).toHaveText('Selection changes: 0')
    await surface.screenshot({ path: testInfo.outputPath(`stale-defaults-${theme}.png`) })
    await model.click()
    const menu = page.getByRole('menu')
    await expect(menu).toContainText('Saved Model: Model A. This value is no longer offered.')
    await expect(menu).toContainText('model-a — Unavailable')
    await expect(menu.getByRole('menuitemradio', { name: 'Model B' })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath(`stale-menu-${theme}.png`) })
    await writeFile(testInfo.outputPath(`visible-text-${theme}.txt`), `${await surface.innerText()}\nMenu:\n${await menu.innerText()}`)
    await page.keyboard.press('Escape')
    const toolbar = surface.locator('[data-composer-layout="live"]')
    await toolbar.evaluate((node) => { node.style.width = '320px' })
    await expect(surface.locator('[data-composer-track="model"]')).toHaveAttribute('data-tight')
    expect(await model.evaluate((trigger) => {
      const track = trigger.closest('[data-composer-track]')!.getBoundingClientRect()
      return [...trigger.querySelectorAll('svg')].every((node) => {
        const glyph = node.getBoundingClientRect()
        return glyph.width >= 12 && glyph.left >= track.left && glyph.right <= track.right
      })
    })).toBe(true)
    await toolbar.evaluate((node) => { node.style.removeProperty('width') })
    await expect(surface.locator('[data-composer-track="model"]')).not.toHaveAttribute('data-tight')
    await surface.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(surface.locator('[data-send-count]')).toHaveText('Messages sent: 1')
    await surface.getByRole('button', { name: 'Use the agent’s current value', exact: true }).click()
    await expect(surface).not.toContainText('Saved Model: Model A')
    await expect(model.getByLabel('Stale saved default')).toHaveCount(0)
    // Clearing the new-session default never silently changes this conversation.
    await expect(model).toContainText('model-a')
    await expect(unavailable).toHaveText('Unavailable')
    await model.click()
    await page.getByRole('menuitemradio', { name: 'Model B' }).click()
    await expect(model).toContainText('Model B')
    await expect(model).not.toContainText('Unavailable')
    await expect(surface.locator('[data-setter-count]')).toHaveText('Selection changes: 1')
    await surface.screenshot({ path: testInfo.outputPath(`cleared-defaults-${theme}.png`) })
  })
}
