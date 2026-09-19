import { expect, test } from '@playwright/test'

test('command output and fenced prose share one code plate', async ({ page }) => {
  await page.goto('/design.html?view=code')

  const block = page.getByTestId('code-block-sample').locator('[data-slot="code-block"]')
  const command = block.locator('[data-slot="code-block-command"] code')
  const output = block.locator('[data-slot="code-block-body"]')
  const fenced = page.getByTestId('markdown-code-sample').locator('pre')
  const fencedCode = fenced.locator('code')

  await expect(block).toBeVisible()
  await expect(fenced).toBeVisible()

  const commandType = await command.evaluate((node) => {
    const style = getComputedStyle(node)
    return { size: style.fontSize, family: style.fontFamily }
  })
  const outputType = await output.evaluate((node) => {
    const style = getComputedStyle(node)
    return { size: style.fontSize, family: style.fontFamily }
  })
  expect(outputType).toEqual(commandType)

  const plate = await block.evaluate((node) => {
    const style = getComputedStyle(node)
    return { fill: style.backgroundColor, radius: style.borderRadius, size: style.fontSize }
  })
  const prose = await fenced.evaluate((node) => {
    const style = getComputedStyle(node)
    return { fill: style.backgroundColor, radius: style.borderRadius }
  })
  expect(prose).toEqual({ fill: plate.fill, radius: plate.radius })
  await expect(fencedCode).toHaveCSS('font-size', plate.size)
})
