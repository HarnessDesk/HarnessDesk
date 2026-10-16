import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { openFrame } from './frame-contract-helpers'
import { applyLeftColumnActions } from './left-column-actions'
import { installNativeCorner } from './native-corner-fixture'

for (const theme of ['light', 'dark'] as const) for (const width of [FRAME.sidebar.width, FRAME.sidebar.min]) {
  test(`native history remains reachable at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await installNativeCorner(page)
    await openFrame(page, 'frame-wall=conversation', theme)
    await applyLeftColumnActions(page, { leftOpen: true, leftWidth: width })
    const column = page.locator('[data-left-column]:visible')
    await column.locator('[data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.keyboard.press('Meta+[')
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(0)
    await applyLeftColumnActions(page, { leftOpen: true, leftWidth: width })
    const top = column.locator('[data-left-top]')
    await expect.poll(() => top.locator('[data-slot="bar"]').evaluate(node => getComputedStyle(node).paddingLeft)).toBe('78px')
    await expect.poll(async () => (await top.boundingBox())!.width).toBe(width)
    await page.screenshot({ path: process.env.ARROWS_FRAMES
      ? `${process.env.ARROWS_FRAMES}/${theme}-${width}.png` : testInfo.outputPath(`${theme}-${width}.png`) })
    const owner = width === FRAME.sidebar.width ? top : page.locator('[data-topbar="lead"]:visible')
    for (const name of ['Back', 'Forward']) {
      const arrow = owner.getByRole('button', { name, exact: true })
      await expect(arrow).toBeVisible()
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
      const box = (await arrow.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(24)
      expect(box.height).toBeGreaterThanOrEqual(24)
    }
    const targets = await top.locator('button:visible').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width, height: box.height,
        disabled: (node as HTMLButtonElement).disabled,
        name: node.getAttribute('aria-label'), hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button')?.getAttribute('aria-label') }
    }))
    expect(targets[0]!.left).toBeGreaterThanOrEqual(78)
    for (const [index, target] of targets.entries()) {
      expect(target.width).toBeGreaterThanOrEqual(24)
      expect(target.height).toBeGreaterThanOrEqual(24)
      if (!target.disabled) expect(target.hit).toBe(target.name)
      if (index) expect(target.left).toBeGreaterThanOrEqual(targets[index - 1]!.right)
    }
    const mode = top.getByRole('button', { name: 'Editor mode', exact: true })
    await expect(mode).toBeVisible()
    expect(targets.at(-1)!.right).toBeLessThanOrEqual(width - FRAME.rail.inset)
    await owner.getByRole('button', { name: 'Forward', exact: true }).click()
    await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
    await page.keyboard.press('Meta+[')
    await applyLeftColumnActions(page, { leftOpen: true, leftWidth: width })
    await mode.click()
    await expect(mode).toHaveAttribute('aria-pressed', 'true')
    await applyLeftColumnActions(page, { leftOpen: true, leftWidth: width === FRAME.sidebar.min ? FRAME.sidebar.width : FRAME.sidebar.min })
    const nextOwner = width === FRAME.sidebar.min ? top : page.locator('[data-topbar="lead"]:visible')
    for (const name of ['Back', 'Forward']) {
      await expect(nextOwner.getByRole('button', { name, exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
    }
  })
}

for (const destination of ['team', 'agents']) test(`native narrow sidebar hands history to the ${destination} bar`, async ({ page }) => {
  await installNativeCorner(page)
  await openFrame(page, `frame-wall=${destination}`, 'light')
  await applyLeftColumnActions(page, { leftOpen: true, leftWidth: FRAME.sidebar.min })
  const lead = page.locator('[data-topbar="lead"]:visible')
  for (const name of ['Back', 'Forward']) await expect(lead.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(lead.getByRole('button', { name: 'Hide sidebar', exact: true })).toHaveCount(0)
})
