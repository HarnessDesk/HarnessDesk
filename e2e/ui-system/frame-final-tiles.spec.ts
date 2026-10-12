import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`final split tiles retain their geometry without painted column rules in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/preview.html?side-by-side')
    const grid = page.locator('[data-frame-id="side-by-side-two"] [data-slot="side-by-side-grid"]')
    await expect(grid).toBeVisible()
    const seams = grid.locator(':scope > [data-slot="separator"]')
    await expect(seams).not.toHaveCount(0)
    const clear = () => seams.evaluateAll(nodes => nodes.every(node => {
      const box = node.getBoundingClientRect()
      return Math.min(box.width, box.height) === 1
        && getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)'
    }))
    await expect.poll(clear).toBe(true)
    await seams.first().evaluate(node => { (node as HTMLElement).style.backgroundColor = 'rgb(200, 0, 0)' })
    expect(await clear(), 'a painted seam must fail the no-column-rule check').toBe(false)
    await seams.first().evaluate(node => { (node as HTMLElement).style.removeProperty('background-color') })
    await expect.poll(clear).toBe(true)
  })
}
