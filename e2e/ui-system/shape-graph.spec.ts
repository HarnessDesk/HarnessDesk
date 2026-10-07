import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  test.describe(`Shape graph on the shared canvas in ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/preview.html?shape-graph&theme=${theme}`)
      await expect(page.locator('#shape-graph .react-flow__node')).toHaveCount(6)
    })
    test('initial fit and Fit keep every rule word inside the canvas', async ({ page }) => {
      const canvas = page.locator('#shape-graph [data-slot="flow-canvas"]')
      const outside = () => canvas.evaluate(root => {
        const box = root.getBoundingClientRect()
        return [...root.querySelectorAll('[data-flow-edge-id]')].filter(el => {
          const word = el.getBoundingClientRect()
          return word.left < box.left || word.right > box.right || word.top < box.top || word.bottom > box.bottom
        }).map(el => el.textContent)
      })
      await expect(canvas.locator('[data-flow-edge-id]')).toHaveCount(4)
      expect(await outside()).toEqual([])
      await canvas.getByRole('button', { name: 'Fit plan' }).click()
      expect(await outside()).toEqual([])
    })
    test('selection and bounded keyboard positions retain the ordered policy', async ({ page }) => {
      const step = page.locator('#shape-graph .react-flow__node[data-id="write"]')
      await step.click()
      await expect(page.getByRole('spinbutton', { name: 'Horizontal' })).toHaveValue('40')
      await step.focus()
      await page.keyboard.press('ArrowRight')
      await expect(page.getByRole('spinbutton', { name: 'Horizontal' })).toHaveValue('56')
      await page.getByRole('spinbutton', { name: 'Horizontal' }).fill('9999999')
      await expect(page.getByRole('spinbutton', { name: 'Horizontal' })).toHaveValue('10000')
      expect(await page.locator('[data-saved-positions]').getAttribute('data-saved-positions')).toContain('10000')
    })
    test('drag commits a position and Escape cancels the next drag without a write', async ({ page }) => {
      const step = page.locator('#shape-graph .react-flow__node[data-id="write"]')
      const drag = async () => {
        const box = (await step.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 5 })
      }
      await drag()
      await page.mouse.up()
      await expect.poll(() => page.locator('[data-saved-positions]').getAttribute('data-saved-positions')).toContain('write')
      const saved = await page.locator('[data-saved-positions]').getAttribute('data-saved-positions')
      const before = await step.getAttribute('style')
      await drag()
      await expect(step).not.toHaveAttribute('style', before!)
      await page.keyboard.press('Escape')
      await page.mouse.up()
      await expect(step).toHaveAttribute('style', before!)
      await expect(page.locator('[data-saved-positions]')).toHaveAttribute('data-saved-positions', saved!)
    })
    test('rules still select the ordered editor and no connection or delete edits are exposed', async ({ page }) => {
      await page.locator('#shape-graph').getByRole('button', { name: /Review.*Fix/i }).click()
      await expect(page.locator('[data-selected-rule]')).toHaveAttribute('data-selected-rule', 'changes')
      const step = page.locator('#shape-graph .react-flow__node[data-id="review"]')
      await step.click()
      await step.focus()
      await page.keyboard.press('Delete')
      await expect(page.locator('#shape-graph .react-flow__node')).toHaveCount(6)
      await expect(page.locator('#shape-graph .react-flow__handle.connectable')).toHaveCount(0)
    })
  })
}
