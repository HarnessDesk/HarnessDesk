import { expect, test, type Locator } from '@playwright/test'

const contrast = async (locator: Locator): Promise<number> =>
  locator.evaluate((node: Element) => {
    const context = document.createElement('canvas').getContext('2d')!
    const stack: Element[] = []
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) stack.unshift(ancestor)
    const paint = (color: string) => {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
    }
    const luminance = (rgb: Uint8ClampedArray) => {
      const channels = [...rgb].slice(0, 3).map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    for (const ancestor of stack) paint(getComputedStyle(ancestor).backgroundColor)
    const background = luminance(context.getImageData(0, 0, 1, 1).data)
    paint(getComputedStyle(node).color)
    const foreground = luminance(context.getImageData(0, 0, 1, 1).data)
    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
  })

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

for (const theme of ['light', 'dark'] as const) {
  test(`an inline diff is one plate with neutral code and AA metadata in ${theme}`, async ({ page }) => {
    await page.goto('/design.html?view=code')
    // The catalogue starts light and has its own switch for dark.
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'dark', exact: true }).click()
      await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    }

    const sample = page.getByTestId('inline-diff-sample')
    const body = sample.locator('[class*="_rowBodyBare_"]')
    const plate = sample.locator('[class*="_diff_"]')
    const added = sample.locator('tr[class*="_add_"]')
    const removed = sample.locator('tr[class*="_remove_"]')

    await expect(plate).toBeVisible()
    const frames = await Promise.all([body, plate].map((part) => part.evaluate((node) => {
      const style = getComputedStyle(node)
      return { background: style.backgroundColor, shadow: style.boxShadow }
    })))
    expect(frames[0]).toEqual({ background: 'rgba(0, 0, 0, 0)', shadow: 'none' })
    expect(frames[1]?.shadow).not.toBe('none')

    const plateInk = await plate.evaluate((node) => getComputedStyle(node).color)
    await expect(added.locator('[class*="_code_"]')).toHaveCSS('color', plateInk)
    await expect(removed.locator('[class*="_code_"]')).toHaveCSS('color', plateInk)

    for (const row of [added, removed]) {
      const gutter = row.locator('[class*="_gutter_"]')
      const marker = row.locator('[class*="_marker_"]')
      expect(await contrast(gutter)).toBeGreaterThanOrEqual(4.5)
      expect(await contrast(marker)).toBeGreaterThanOrEqual(4.5)
    }
  })
}
