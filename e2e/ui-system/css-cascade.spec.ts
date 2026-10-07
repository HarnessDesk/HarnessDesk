import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`code plates and diff cells keep their ground and spacing without priority in ${theme}`, async ({ page }) => {
    await page.goto('/design.html?view=code')
    if (theme === 'dark') await page.getByRole('radio', { name: 'dark', exact: true }).click()
    const markdown = page.getByTestId('markdown-code-sample')
    const pre = markdown.locator('pre.shiki')
    await expect(pre).toBeVisible()
    expect(await pre.evaluate((node: HTMLElement) => node.style.backgroundColor)).toBe('')
    const plateFill = await markdown.locator('[data-code-block]').evaluate((node) => getComputedStyle(node).backgroundColor)
    await expect(pre).toHaveCSS('background-color', plateFill)
    const diff = page.getByTestId('diff-sample')
    const gutters = diff.locator('td[class*="_gutter_"]')
    for (const gutter of await gutters.all()) await expect(gutter).toHaveCSS('padding-right', '8px')
    const code = diff.locator('td[class*="_code_"]')
    for (const cell of await code.all()) await expect(cell).toHaveCSS('padding-left', '10px')
    const hunk = diff.locator('tr[class*="_hunk_"] td[class*="_code_"]').first()
    await expect(hunk).toHaveCSS('padding-top', '8px')
    await expect(hunk).toHaveCSS('padding-bottom', '2px')
  })
}

test('a closed narrow sidebar keeps its slide transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/design.html?view=panels')
  const seam = page.getByRole('separator', { name: 'Resize the sidebar' })
  const shell = seam.locator('xpath=ancestor::*[contains(@class,"_shell_")][1]')
  await shell.evaluate((node) => node.setAttribute('data-narrow', ''))
  const sidebar = shell.locator('[class*="_sidebar_"]').first()
  await sidebar.evaluate((node) => node.setAttribute('data-hidden', ''))

  const properties = await sidebar.evaluate((node) =>
    getComputedStyle(node).transitionProperty.split(',').map((property) => property.trim()),
  )
  expect(properties).toContain('transform')
  expect(properties).toContain('visibility')
  expect(properties).not.toContain('width')
})

test('document resize state suppresses component transitions, cursors and guest-frame hit tests', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/design.html?view=panels')
  const seam = page.getByRole('separator', { name: 'Resize the sidebar' })
  await expect(seam).toBeVisible()
  const shell = seam.locator('xpath=ancestor::*[contains(@class,"_shell_")][1]')
  // Include the floating narrow state, whose transition used to outrank the drag state.
  await shell.evaluate((node) => node.setAttribute('data-narrow', ''))
  const sidebar = shell.locator('[class*="_sidebar_"]').first()
  await sidebar.evaluate((node) => node.setAttribute('data-floating', ''))
  await expect(sidebar).not.toHaveCSS('transition-duration', '0s')
  await page.addStyleTag({ content: '[data-resize-cursor-probe][data-resize-cursor-probe][data-resize-cursor-probe] { cursor: auto; }' })
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div data-resize-cursor-probe></div>'))
  const cursorProbe = page.locator('[data-resize-cursor-probe]')
  await expect(cursorProbe).toHaveCSS('cursor', 'auto')
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-hd-resizing', 'vertical')
    const frame = document.createElement('iframe')
    frame.dataset.resizeProbe = ''
    document.body.append(frame)
  })
  await expect(sidebar).toHaveCSS('transition-duration', '0s')
  await expect(seam).toHaveCSS('cursor', 'col-resize')
  await expect(cursorProbe).toHaveCSS('cursor', 'col-resize')
  await expect(page.locator('iframe[data-resize-probe]')).toHaveCSS('pointer-events', 'none')
  await page.evaluate(() => document.documentElement.setAttribute('data-hd-resizing', 'horizontal'))
  await expect(seam).toHaveCSS('cursor', 'row-resize')
  await expect(cursorProbe).toHaveCSS('cursor', 'row-resize')
  await page.evaluate(() => document.documentElement.removeAttribute('data-hd-resizing'))
  await expect(sidebar).not.toHaveCSS('transition-duration', '0s')
  await expect(cursorProbe).toHaveCSS('cursor', 'auto')
  await expect(page.locator('iframe[data-resize-probe]')).toHaveCSS('pointer-events', 'auto')
})
