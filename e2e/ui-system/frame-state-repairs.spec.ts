import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'
import { FRAME } from '../../packages/ui/src/design/frame'

const capture = async (page: Page, name: string) => {
  const directory = process.env.FRAME_REPAIR_FRAMES
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, `${name}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1100, 720]) test(`narrow pane replaces main and restores its reading space at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    const main = page.locator('[data-frame-region="main"]')
    const before = await main.boundingBox()
    expect(before).not.toBeNull()
    await page.getByRole('button', { name: 'Changes', exact: true }).first().click()
    const right = page.locator('[data-frame-region="right"]')
    await expect(right).toBeVisible()
    const panel = await right.boundingBox()
    expect(panel!.width).toBeGreaterThanOrEqual(FRAME.rightPanel.min)
    expect(panel!.x).toBe(before!.x)
    expect(panel!.x + panel!.width).toBe(width)
    expect(panel!.y).toBe(0)
    expect(panel!.height).toBe(900)
    await expect(main).toBeHidden()
    await capture(page, `conversation-floating-${width}-${theme}`)
    await right.getByRole('button', { name: 'Close pane', exact: true }).click()
    await expect(main).toBeVisible()
    expect(await main.boundingBox()).toEqual(before)
  })

  test(`Settings keeps the project terminal and native work sized in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=navigation&frame-terminal=1', theme)
    const work = page.locator('[data-slot="retained-work"]')
    const terminal = page.locator('[data-frame-region="right"] [data-terminal-id]').first()
    await expect(terminal).toBeVisible()
    const id = await terminal.getAttribute('data-terminal-id')
    const before = await work.boundingBox()
    await terminal.evaluate(node => { node.setAttribute('data-retention-witness', 'frame-repair') })
    await page.keyboard.press('Meta+,')
    await expect(page.locator('[data-page-destination="settings"]')).toBeVisible()
    await expect(work).toBeHidden()
    await expect(work).toHaveAttribute('inert', '')
    await expect(work).not.toHaveAttribute('hidden', '')
    const retained = await work.evaluate(node => ({ display: getComputedStyle(node).display, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
    expect(retained.display).not.toBe('none')
    expect(retained.width).toBeGreaterThanOrEqual(before!.width)
    expect(retained.height).toBe(before!.height)
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-retention-witness', 'frame-repair')
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
    await capture(page, `settings-terminal-${theme}`)
    await page.keyboard.press('Meta+[')
    await expect(work).toBeVisible()
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
  })
}

for (const theme of ['light', 'dark'] as const) test(`Agents More offers the retained project terminal in ${theme}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
  const terminal = page.locator('[data-terminal-id]')
  await expect(terminal).toBeVisible()
  await page.locator('[data-frame-region="left"]').getByRole('button', { name: 'Agents', exact: true }).click()
  const destination = page.locator('[data-page-destination="agents"]:visible')
  await destination.getByRole('button', { name: /Code reviewer / }).click()
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  const toggle = page.getByRole('menuitemradio', { name: /Terminal/ })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(terminal).toBeVisible()
  await capture(page, `agents-terminal-menu-${theme}`)
  await page.keyboard.press('Escape')
  await expect(terminal).toHaveCount(1)
  await expect(destination).toBeVisible()
})
