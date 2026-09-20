import { expect, test } from '@playwright/test'

test('provenance preview keeps history labels passive and opens an immutable historical Seat', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  await expect(frame).toContainText('Contributor 7')
  await expect(frame.locator('[data-provenance-label] button, [data-provenance-label] a')).toHaveCount(0)
  await frame.getByRole('button', { name: 'Seat record' }).click()
  const dialog = page.getByRole('dialog', { name: 'Seat record', exact: true })
  await expect(dialog).toContainText('The historical Seat record is unavailable.')
  await expect(dialog.getByRole('button', { name: 'Open conversation' })).toBeDisabled()
  await dialog.screenshot({ path: info.outputPath('provenance-dialog.png') })
  expect(errors).toEqual([])
})

test('provenance detail retains its explanation and complete association mark', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  await expect(frame).toContainText('Associated Seat')
  await expect(frame).toContainText('A local diff observation associates this change with its Seat.')
})

test('provenance preview offers a saved-on capture switch and host wording', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  const capture = frame.getByRole('switch', { name: 'Capture provenance on this machine' })
  await expect(capture).toHaveAttribute('aria-checked', 'true')
  await expect(frame).toContainText('Capture is current for the refs Git exposes.')
})

test('turning capture off preserves the stopped explanation and disables retry', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  await frame.getByRole('switch', { name: 'Capture provenance on this machine' }).click()
  await expect(frame).toContainText('Capture is off on this machine.')
  await expect(frame.getByRole('button', { name: 'Retry capture' })).toBeDisabled()
})

test('turning capture back on restores the saved state', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  const capture = frame.getByRole('switch', { name: 'Capture provenance on this machine' })
  await capture.click(); await capture.click()
  await expect(capture).toHaveAttribute('aria-checked', 'true')
  await expect(frame.getByRole('button', { name: 'Retry capture' })).toBeEnabled()
})

test('historical Seat dialog does not expose an unavailable conversation action', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  await frame.getByRole('button', { name: 'Seat record' }).click()
  const dialog = page.getByRole('dialog', { name: 'Seat record', exact: true })
  await expect(dialog).toContainText('The historical Seat record is unavailable.')
  await expect(dialog.getByRole('button', { name: 'Open conversation' })).toBeDisabled()
})

test('provenance controls remain visible at the narrow reference width', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 900 })
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Provenance preview', exact: true })
  await expect(frame.getByRole('switch', { name: 'Capture provenance on this machine' })).toBeVisible()
  await expect(frame.getByRole('button', { name: 'Retry capture' })).toBeVisible()
})
