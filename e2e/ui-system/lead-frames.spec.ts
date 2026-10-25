import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const scenes = ['pending-plan', 'result-person-gate', 'following', 'handback-running', 'push-card', 'branch-released', 'branch-rewritten', 'handback-limit', 'settings-triggers'] as const
for (const theme of ['light', 'dark']) for (const scene of scenes) test(`Lead synthetic ${scene} in ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 980 })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' || new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort())
  await page.goto(`/preview.html?lead-synthetic=${scene}&theme=${theme}`)
  const frame = page.locator(`[data-frame-id="lead-${scene}"]`)
  await expect(frame).toBeVisible()
  if (scene === 'settings-triggers') {
    await page.getByText('Triggers', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('switch', { name: 'Checks failed' })).toBeChecked()
    await expect(page.getByRole('button', { name: 'Checks failed on acme/widgets' })).toBeVisible()
  } else if (scene === 'pending-plan') await expect(frame.locator('[data-slot="lead-plan-flow"]')).toBeVisible()
  else if (scene === 'result-person-gate' || scene === 'push-card') await expect(frame.getByRole('button', { name: 'Accept and open PR', exact: true })).toBeVisible()
  else if (scene.startsWith('branch-')) await expect(frame.getByRole('button', { name: 'Take the branch back', exact: true })).toBeVisible()
  else if (scene === 'handback-running') await expect(frame.locator('[data-slot="lead-live-line"]')).toHaveText('Repairing checks · round 2')
  else if (scene === 'handback-limit') await expect(frame.locator('[data-lead-card="handback-limit"]')).toContainText('Automatic repairs reached their limit')
  else await expect(frame.locator('[data-slot="lead-pr-status"]')).toContainText('#12')
  expect(await frame.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  const directory = process.env.LEAD_D_FRAMES_DIR ?? info.outputPath('frames')
  await mkdir(directory, { recursive: true })
  await frame.screenshot({ path: join(directory, `${scene}-${theme}.png`), animations: 'disabled' })
})

for (const theme of ['light', 'dark']) test(`Lead plan and four-action result wrap at a narrow short viewport in ${theme}`, async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 540 })
  for (const scene of ['pending-plan', 'result-person-gate']) {
    await page.goto(`/preview.html?lead-synthetic=${scene}&theme=${theme}`)
    const frame = page.locator(`[data-frame-id="lead-${scene}"]`)
    await expect(frame).toBeVisible()
    expect(await frame.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    const action = frame.getByRole('button', { name: scene === 'pending-plan' ? 'Approve' : 'Accept and open PR', exact: true })
    await expect(action).toBeVisible()
    expect(await action.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth })).toBe(true)
  }
})

for (const theme of ['light', 'dark']) test(`an unavailable Lead has one runtime reason and no retry in ${theme}`, async ({ page }, info) => {
  await page.goto(`/preview.html?lead-synthetic=runtime-unavailable&theme=${theme}`)
  const frame = page.locator('[data-frame-id="lead-runtime-unavailable"]')
  await expect(frame.getByText('Lead requires Node 25 or newer. This desk uses an older runtime.', { exact: true })).toHaveCount(1)
  await expect(frame.getByRole('textbox', { name: 'Goal or message' })).toBeDisabled()
  await expect(frame.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await expect(frame.getByRole('alert')).toHaveCount(0)
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  await frame.screenshot({ path: info.outputPath(`runtime-unavailable-${theme}.png`), animations: 'disabled' })
})
