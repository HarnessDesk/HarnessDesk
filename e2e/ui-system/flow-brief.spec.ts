import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const paragraphs = 'Make the settings easier to read.\n\nKeep each choice beside its explanation and preserve keyboard navigation.\n\nCheck both themes and a narrow window before handing over the change.'
const frames = 'output/flow-brief'

for (const theme of ['light', 'dark'] as const) {
  test(`Start stays disabled while a brief file is reading (${theme})`, async ({ page }) => {
    await mkdir(frames, { recursive: true })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?flow-brief=pending')
    const dialog = page.getByRole('dialog', { name: 'Run a flow', exact: true })
    await expect(dialog.getByRole('button', { name: 'Reading…', exact: true })).toBeDisabled()
    const start = dialog.getByRole('button', { name: 'Start', exact: true })
    await expect(start).toBeDisabled()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    await dialog.screenshot({ path: `${frames}/pending-${theme}.png` })
    // New typing cancels the import and previews the typed brief instead.
    await dialog.getByRole('textbox', { name: 'Brief', exact: true }).fill(paragraphs)
    await expect(start).toBeEnabled()
    await expect(dialog.getByRole('button', { name: 'Attach a file…', exact: true })).toBeEnabled()
  })

  test(`the start dialog grows Brief, scrolls long text and preserves the title (${theme})`, async ({ page }) => {
    await mkdir(frames, { recursive: true })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?flow-brief=empty')
    const dialog = page.getByRole('dialog', { name: 'Run a flow', exact: true })
    const brief = dialog.getByRole('textbox', { name: 'Brief', exact: true })
    const title = dialog.getByRole('textbox', { name: 'What finishes this?' })
    await expect(brief).toBeVisible()
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    await expect(title).toHaveValue('Improve the settings')
    await expect(brief).toHaveValue('')
    const empty = (await brief.boundingBox())!.height
    expect(empty).toBeGreaterThanOrEqual(80)
    if (theme === 'light') await dialog.screenshot({ path: `${frames}/empty-light.png` })

    await brief.fill(paragraphs)
    await expect(brief).toHaveValue(paragraphs)
    expect((await brief.boundingBox())!.height).toBeGreaterThan(empty)
    await expect(title).toHaveValue('Improve the settings')
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
    await dialog.screenshot({ path: `${frames}/filled-${theme}.png` })

    await brief.fill(Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: ${paragraphs}`).join('\n\n'))
    const geometry = await brief.evaluate((node) => {
      const style = getComputedStyle(node)
      return { height: node.clientHeight, scroll: node.scrollHeight, max: parseFloat(style.maxHeight), overflow: style.overflowY, font: style.fontSize, token: style.getPropertyValue('--hd-text').trim() }
    })
    expect(geometry.scroll).toBeGreaterThan(geometry.height)
    expect(geometry.height).toBeLessThanOrEqual(geometry.max)
    expect(geometry.overflow).toBe('auto')
    expect(geometry.font).toBe(geometry.token)
    await brief.evaluate((node) => { node.scrollTop = 0 })
    if (theme === 'light') await dialog.screenshot({ path: `${frames}/long-light.png` })
    await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeInViewport()

    await brief.fill(paragraphs)
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.alloc(64 * 1024 + 1, 'A') })
    await expect(dialog.getByRole('alert')).toContainText('64 KiB (65,536 bytes)')
    await expect(brief).toHaveValue(paragraphs)
    if (theme === 'light') await dialog.screenshot({ path: `${frames}/refused-light.png` })
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'brief.md', mimeType: 'text/markdown', buffer: Buffer.from('A file brief.\n\nSecond paragraph.') })
    await expect(brief).toHaveValue('A file brief.\n\nSecond paragraph.')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(title).toHaveValue('Improve the settings')
    await expect(dialog.getByRole('button', { name: 'Attach a file…' })).toBeEnabled()
  })
}

test('Brief wraps and scrolls within a narrow start dialog', async ({ page }) => {
  await mkdir(frames, { recursive: true })
  await page.setViewportSize({ width: 720, height: 520 })
  await page.goto('/preview.html?flow-brief=long')
  const dialog = page.getByRole('dialog', { name: 'Run a flow', exact: true })
  const brief = dialog.getByRole('textbox', { name: 'Brief', exact: true })
  await expect(brief).toBeVisible()
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(720)
  expect(box!.y + box!.height).toBeLessThanOrEqual(520)
  expect(await brief.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
  expect(await brief.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Start', exact: true })).toBeInViewport()
  await dialog.screenshot({ path: `${frames}/long-narrow.png` })
})

test('the catalogue mounts the real Brief in every file and text state', async ({ page }) => {
  await page.goto('/design.html?view=flow-brief')
  const brief = page.getByRole('textbox', { name: 'Brief', exact: true })
  await expect(brief).toBeVisible()
  await expect(brief).toHaveValue('')
  await page.getByRole('button', { name: 'filled', exact: true }).click()
  await expect(brief).toHaveValue(paragraphs)
  await page.getByRole('button', { name: 'long', exact: true }).click()
  await expect(brief).toHaveValue(/Paragraph 80/)
  expect(await brief.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await page.getByRole('button', { name: 'refused', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('64 KiB')
  await page.getByRole('button', { name: 'pending', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reading…', exact: true })).toBeDisabled()
})
