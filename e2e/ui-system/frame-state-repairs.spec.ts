import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

const capture = async (page: Page, name: string) => {
  const directory = process.env.FRAME_REPAIR_FRAMES
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, `${name}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1100, 720]) test(`floating right panel reserves main reading space at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    const main = page.locator('[data-frame-region="main"]')
    const before = await main.boundingBox()
    expect(before).not.toBeNull()
    await page.getByRole('button', { name: 'Changes', exact: true }).first().click()
    const right = page.locator('[data-frame-region="right"]')
    await expect(right).toBeVisible()
    const after = await main.boundingBox(), panel = await right.boundingBox()
    expect(after!.width).toBeGreaterThanOrEqual(Math.min(480, before!.width - 320))
    expect(panel!.width).toBeGreaterThanOrEqual(320)
    expect(after!.width + panel!.width).toBe(before!.width)
    expect(after!.x).toBe(before!.x)
    expect(panel!.x).toBe(after!.x + after!.width)
    expect(panel!.x + panel!.width).toBe(before!.x + before!.width)
    await capture(page, `conversation-floating-${width}-${theme}`)
  })

  test(`Settings hides the terminal and keeps native work sized in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=navigation&frame-terminal=1', theme)
    const work = page.locator('[data-slot="retained-work"]')
    const terminal = page.locator('[data-frame-region="bottom"] [data-terminal-id]').first()
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
    expect(retained.height).toBe(before!.height + await terminal.evaluate(node => node.closest('[data-frame-region="bottom"]')!.getBoundingClientRect().height))
    await expect(terminal).toBeHidden()
    await expect(terminal).toHaveAttribute('data-retention-witness', 'frame-repair')
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
    await capture(page, `settings-terminal-${theme}`)
    await page.keyboard.press('Meta+[')
    await expect(work).toBeVisible()
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-terminal-id', id!)
  })
}

for (const theme of ['light', 'dark'] as const) test(`Agents More omits the retained terminal in ${theme}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-terminal=1', theme)
  const terminal = page.locator('[data-terminal-id]')
  await expect(terminal).toBeVisible()
  await page.locator('[data-frame-region="left"]').getByRole('button', { name: 'Agents', exact: true }).click()
  const destination = page.locator('[data-page-destination="agents"]:visible')
  await destination.getByRole('button', { name: /Code reviewer / }).click()
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  const toggle = page.getByRole('menuitemradio', { name: /Terminal/ })
  await expect(toggle).toHaveCount(0)
  await expect(terminal).toBeHidden()
  await capture(page, `agents-terminal-menu-${theme}`)
  await page.keyboard.press('Escape')
  await expect(terminal).toHaveCount(1)
  await expect(destination).toBeVisible()
})
