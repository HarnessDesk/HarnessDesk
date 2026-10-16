import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

for (const theme of ['light', 'dark'] as const) test(`file tabs retain drafts and close explicitly in ${theme}`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openFrame(page, 'frame-wall=conversation&frame-editor=source', theme, 1440)
  const main = page.locator('[data-slot="editor-main"]'), tabs = main.getByRole('tablist', { name: 'Open files' })
  await expect(main.locator('.cm-content')).toContainText('Checkout')
  await expect(main.locator('[data-slot="file-tab-unsaved"]')).toHaveCount(1)
  const active = tabs.getByRole('tab', { name: 'checkout.ts, unsaved', exact: true })
  const before = await active.boundingBox()
  const shape = await active.evaluate(node => {
    const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--hd-accent)'; node.append(probe)
    const result = { stripHeight: node.closest('[role="tablist"]')!.getBoundingClientRect().height, height: node.getBoundingClientRect().height, top: getComputedStyle(node).borderTopWidth, style: getComputedStyle(node).borderTopStyle, inset: node.getBoundingClientRect().top - node.closest('[role="tablist"]')!.getBoundingClientRect().top, color: getComputedStyle(node).borderTopColor, accent: getComputedStyle(probe).backgroundColor, fill: getComputedStyle(node).backgroundColor, editorFill: '' }
    probe.style.backgroundColor = 'var(--hd-background)'; result.editorFill = getComputedStyle(probe).backgroundColor
    probe.remove(); return result
  })
  expect(shape.stripHeight).toBe(36); expect(shape.height).toBe(36); expect(shape.top).toBe('2px'); expect(shape.style).toBe('solid'); expect(shape.inset).toBe(0); expect(shape.color).toBe(shape.accent); expect(shape.fill).toBe(shape.editorFill)
  await active.hover(); const after = await active.boundingBox(); expect(after?.width).toBe(before?.width)
  await page.screenshot({ path: testInfo.outputPath(`editor-main-${theme}.png`) })
  await tabs.getByRole('tab', { name: 'README.md', exact: true }).click()
  await expect(main.locator('.cm-content')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
  const preview = tabs.getByRole('tab', { name: 'README.md', exact: true })
  expect(await preview.evaluate(node => getComputedStyle(node).fontStyle)).toBe('italic')
  await tabs.getByRole('tab', { name: 'checkout.ts, unsaved', exact: true }).click()
  await expect(main.locator('.cm-content')).toContainText('Checkout')
  await main.getByRole('button', { name: 'Close checkout.ts', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('button', { name: "Don't save", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath(`editor-close-${theme}.png`) })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(active).toBeVisible()
  await main.getByRole('button', { name: 'Close checkout.ts', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(active).toHaveCount(0)
  await expect(tabs.getByRole('tab', { name: 'README.md', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Conversation mode', exact: true }).click()
  await expect(main).toHaveCount(0)
  await expect(page.locator('[data-slot="composer"]:visible')).toBeVisible()
  expect(errors).toEqual([])
})
