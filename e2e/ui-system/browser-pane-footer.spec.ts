import { expect, test } from '@playwright/test'

const toolWall = process.env.FRAME_TOOL_WALL_DIR ?? 'output/frame-wall/tool-bodies'

/** The shell retains an earned driving fact and omits an empty footer
 * at each supported panel width. Drive state comes from a real
 * host-shaped in-flight tool item in the isolated frame fixture. */
for (const theme of ['light', 'dark'] as const) for (const state of ['idle', 'driven'] as const) {
  test(`the Browser facts stay whole in ${state} ${theme} at supported panel widths`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?frame-wall=conversation${state === 'driven' ? '&frame-browser-driving=1' : ''}&theme=${theme}`)
    await page.locator('[data-work-tool="browser"]').click()
    const panel = page.locator('[data-frame-region="right"]')
    const footer = page.locator('[data-slot="tool-footer"]')
    if (state === 'driven') await expect(footer.getByText('Being driven', { exact: true })).toBeVisible()
    else await expect(footer).toHaveCount(0)
    for (const width of [320, 400, 640]) {
      const seam = page.getByRole('separator', { name: 'Resize the right panel' })
      const current = (await panel.boundingBox())!.width
      const handle = (await seam.boundingBox())!
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
      await page.mouse.down()
      await page.mouse.move(handle.x + handle.width / 2 + current - width, handle.y + handle.height / 2, { steps: 6 })
      await page.mouse.up()
      await expect.poll(async () => (await panel.boundingBox())!.width).toBe(width)
      if (state === 'driven') {
      await expect(footer.getByText('Being driven', { exact: true })).toBeVisible()
      const held = await footer.evaluate(element => {
        const box = element.getBoundingClientRect()
        const children = [...element.querySelectorAll('*')].map(child => child.getBoundingClientRect())
        return { height: box.height, sideways: element.scrollWidth > element.clientWidth,
          spills: children.filter(rect => rect.height > 0 && (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5)).length,
          ellipsis: [...element.querySelectorAll('[data-slot="text"]')].some(child => getComputedStyle(child).textOverflow === 'ellipsis'),
        }
      })
      expect(held.height).toBeGreaterThan(0)
      expect(held.sideways, `${state}: footer fits at ${width}`).toBe(false)
      expect(held.spills, `${state}: whole facts fit the natural footer at ${width}`).toBe(0)
      expect(held.ellipsis).toBe(false)
      } else await expect(footer).toHaveCount(0)
      // The composer measures its compact controls after a live seam resize.
      // Wait for the real controls, not merely the panel's synchronous box.
      await expect.poll(async () => page.locator('[data-slot="workbench-main"]').evaluate(main => {
        const edge = main.getBoundingClientRect()
        return [...main.querySelectorAll('[data-slot="composer-tools"] button')].every(button => {
          const box = button.getBoundingClientRect()
          return box.width === 0 || box.left >= edge.left - 0.5 && box.right <= edge.right + 0.5
        })
      }), `${state}: composer controls stay inside main at ${width}`).toBe(true)
      await page.screenshot({ path: `${toolWall}/browser-${state}-${width}-${theme}.png` })
    }
  })
}
