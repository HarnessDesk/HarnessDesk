import { expect, test, type Locator, type Page } from '@playwright/test'
import path from 'node:path'

const open = async (page: Page, theme: 'light' | 'dark', scene = 'running') => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?stop-run=${scene}&theme=${theme}`)
  await page.evaluate(() => document.fonts.ready)
  return page.locator('#stop-run-frame')
}
const capture = async (frame: Locator, name: string) => {
  if (process.env.STOP_RUN_FRAMES_DIR) await frame.screenshot({ path: path.join(process.env.STOP_RUN_FRAMES_DIR, name) })
}
for (const theme of ['light', 'dark'] as const) {
  test(`the header and Overview stop one Run, with whole Seat lines and the stopped record in ${theme}`, async ({ page }) => {
    const frame = await open(page, theme)
    await capture(frame, `running-after-${theme}.png`)
    await frame.locator('[data-slot="run-header"]').getByRole('button', { name: 'Stop run…' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Stop this Run?' })
    await expect(dialog.locator('p').first()).toHaveText('The Run stops now and no further step starts.')
    await expect(dialog.locator('[data-stop-seat="alpha"]')).toContainText('stops now')
    await expect(dialog.locator('[data-stop-seat="beta"]')).toContainText('stops when its current turn ends')
    await expect(dialog.getByRole('button', { name: 'Stop run', exact: true })).toHaveAttribute('data-variant', 'default')
    await capture(dialog, `dialog-${theme}.png`)
    await dialog.getByRole('button', { name: 'Keep running' }).click()
    await frame.locator('[aria-label="Run"]').getByRole('button', { name: 'Stop run…' }).click()
    await dialog.getByRole('textbox', { name: 'Note' }).fill('The brief changed.')
    await dialog.getByRole('button', { name: 'Stop run', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(frame).toContainText('Stopped by you')
    await expect(frame).toContainText('The brief changed.')
    await expect(frame.getByRole('button', { name: 'Stop run…' })).toHaveCount(0)
    await frame.getByText('Stopped by you', { exact: true }).scrollIntoViewIfNeeded()
    await capture(frame.locator('[data-slot="run-workspace"]'), `stopped-${theme}.png`)
  })

  test(`the abandon question transfers to Stop without abandoning, in ${theme}`, async ({ page }) => {
    const frame = await open(page, theme)
    await frame.getByRole('button', { name: 'Abandon card…' }).click()
    const abandon = page.getByRole('alertdialog', { name: 'Abandon card #4?' })
    await capture(abandon, `abandon-after-${theme}.png`)
    await abandon.getByRole('button', { name: 'Stop the run instead' }).click()
    await expect(abandon).toBeHidden()
    const dialog = page.getByRole('alertdialog', { name: 'Stop this Run?' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('alertdialog')).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Keep running' }).click()
    await expect(frame.getByRole('button', { name: 'Abandon card…' })).toBeVisible()
  })

  for (const width of [390, 760]) test(`the question and its actions fit at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 })
    const frame = await open(page, theme, 'narrow')
    await frame.locator('[data-slot="run-header"]').getByRole('button', { name: 'Stop run…' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Stop this Run?' })
    const box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    for (const name of ['Stop run', 'Keep running']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport()
    expect(await dialog.locator('[data-stop-seat]').evaluateAll(rows => rows.every(row => {
      const text = row.querySelector('[data-slot="list-row-subtitle"]')!
      return getComputedStyle(text).textOverflow !== 'ellipsis' && text.scrollWidth <= text.clientWidth + 1
    }))).toBe(true)
    await capture(dialog, `dialog-${width}-${theme}.png`)
  })

  test(`empty, pending and failed stop questions remain usable in ${theme}`, async ({ page }) => {
    let frame = await open(page, theme, 'empty')
    await frame.locator('[data-slot="run-header"]').getByRole('button', { name: 'Stop run…' }).click()
    let dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText('No open Seats in this Run.')
    frame = await open(page, theme, 'pending')
    await frame.locator('[data-slot="run-header"]').getByRole('button', { name: 'Stop run…' }).click()
    dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Stop run', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    await capture(dialog, `pending-${theme}.png`)
    frame = await open(page, theme, 'failed')
    await frame.locator('[data-slot="run-header"]').getByRole('button', { name: 'Stop run…' }).click()
    dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Stop run', exact: true }).click()
    await expect(dialog).toContainText('one Seat could not be released')
    await expect(dialog.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled()
    await capture(dialog, `failed-${theme}.png`)
  })
}
