import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const frame = async (page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready)
  expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
  if (process.env.SWEEP_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.SWEEP_FRAMES_DIR, `${name}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Fold keeps headers and cards aligned when a foundation moves the target in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?board-list&theme=${theme}`)
    const ready = page.locator('[data-column="ready"]')
    await ready.getByRole('button', { name: 'Ready 1 — Open column', exact: true }).click()
    for (const target of [24, 28, 32]) {
      await page.evaluate(target => document.body.style.setProperty('--hd-icon-target', `${target}px`), target)
      const geometry = await page.locator('[data-slot="board"]').evaluate(board => {
        const ready = board.querySelector('[data-column="ready"]')!
        const other = board.querySelector('[data-column="needs"]')!
        return {
          readyHeader: ready.querySelector('header')!.getBoundingClientRect().height,
          otherHeader: other.querySelector('header')!.getBoundingClientRect().height,
          readyCard: ready.querySelector('[data-slot="board-card"]')!.getBoundingClientRect().top,
          otherCard: other.querySelector('[data-slot="board-card"]')!.getBoundingClientRect().top,
        }
      })
      if (target === 32) await frame(page, `fold-${theme}`)
      expect.soft(geometry.readyHeader).toBe(geometry.otherHeader)
      expect.soft(geometry.readyCard).toBe(geometry.otherCard)
    }
  })

  test(`Team members keep their full keyboard ring inside clipping ancestors in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const trigger = page.getByRole('button', { name: 'Team members', exact: true })
      await trigger.focus()
      await page.keyboard.press('Tab')
      await trigger.focus()
      await expect(trigger).toBeFocused()
      const clipped = await trigger.evaluate(node => {
        const style = getComputedStyle(node)
        const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
        const rect = node.getBoundingClientRect()
        const hits: string[] = []
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor)
          const box = ancestor.getBoundingClientRect()
          const margin = css.overflowX === 'clip' && css.overflowY === 'clip' ? parseFloat(css.overflowClipMargin.split(' ').at(-1) ?? '') || 0 : 0
          if (/(hidden|clip|auto|scroll)/.test(css.overflowX) && (rect.left - reach < box.left - margin - 0.5 || rect.right + reach > box.right + margin + 0.5)) hits.push('inline')
          if (/(hidden|clip|auto|scroll)/.test(css.overflowY) && (rect.top - reach < box.top - margin - 0.5 || rect.bottom + reach > box.bottom + margin + 0.5)) hits.push('block')
        }
        return { reach, hits }
      })
      await frame(page, `members-${width}-${theme}`)
      expect(clipped.reach).toBeGreaterThan(0)
      expect.soft(clipped.hits).toEqual([])
    }
  })

  test(`consent stays open with an explanation when its Run ends in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?theme=${theme}`)
    await page.evaluate(async () => {
      const root = document.getElementById('root')!
      root.remove()
      const container = document.createElement('section')
      document.body.appendChild(container)
      // Vite loads the fixture from this checkout, using the production dialog.
      const url = '/src/preview/frames-retry-lifecycle.tsx'
      const { mountRetryLifecycle } = await import(url)
      mountRetryLifecycle(container)
    })
    await page.getByRole('button', { name: 'Run again…', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Run this check again?' })
    await expect(dialog.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: 'Keep', exact: true }).focus()
    // The lifecycle update comes from outside the modal, as the host's event does.
    await page.getByRole('button', { name: 'End Run', exact: true, includeHidden: true }).evaluate((node: HTMLButtonElement) => node.click())
    await frame(page, `consent-${theme}`)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('This run is settled. Start a new run to run this check again.')
    await expect(dialog.getByRole('button', { name: 'Run again', exact: true })).toBeDisabled()
    expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}
