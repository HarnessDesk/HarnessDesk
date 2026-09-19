import { expect, test } from '@playwright/test'

test('command output and fenced prose share one code plate', async ({ page }) => {
  await page.goto('/design.html?view=code')

  const block = page.getByTestId('code-block-sample').locator('[data-slot="code-block"]')
  const command = block.locator('[data-slot="code-block-command"] code')
  const output = block.locator('[data-slot="code-block-body"]')
  const fenced = page.getByTestId('markdown-code-sample').locator('pre')
  const fencedCode = fenced.locator('code')
  const fencedSample = page.getByTestId('markdown-code-sample')
  const fencedPlate = fencedSample.locator('[data-code-block]')
  const diff = page.getByTestId('diff-sample')

  await expect(block).toBeVisible()
  await expect(fenced).toBeVisible()
  await expect(fencedSample.locator('[data-code-language]')).toHaveText('ts')
  await expect(fencedSample.getByRole('button', { name: 'Copy this code' })).toBeVisible()
  await expect(diff).not.toContainText('diff --git')
  await expect(diff).not.toContainText('index 0000000')

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
  const prose = await fencedPlate.evaluate((node) => {
    const style = getComputedStyle(node)
    return { fill: style.backgroundColor, radius: style.borderRadius }
  })
  expect(prose).toEqual({ fill: plate.fill, radius: plate.radius })
  await expect(fencedCode).toHaveCSS('font-size', plate.size)

  const currentCells = diff.locator('tr[data-current] td')
  await expect(currentCells).toHaveCount(3)
  const accented = await currentCells.evaluateAll((cells) =>
    cells.filter((cell) => getComputedStyle(cell).boxShadow !== 'none').length,
  )
  expect(accented).toBe(1)
})
