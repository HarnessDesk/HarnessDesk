import { expect, test } from '@playwright/test'

// Bounded dialogs keep groups whole and long branch lists within their scrolling cap.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })

for (const theme of ['light', 'dark'] as const) for (const height of [1000, 480, 360]) {
  test(`New worktree branches keep their scrolling cap at 1280x${height} in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height })
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?theme=${theme}`)
    await page.getByLabel('git sheet').selectOption('new worktree')
    const dialog = page.getByRole('dialog', { name: 'New worktree', exact: true })
    await expect(dialog).toBeVisible()
    await page.evaluate(async () => { await document.fonts.ready })
    const branches = dialog.getByRole('radiogroup', { name: 'Start the worktree from' })
    await expect(branches.getByRole('radio').first()).toBeVisible()
    // Extend the rendered synthetic list without changing its CSS. The cap
    // must work for a long list, rather than passing on three short branches.
    await branches.evaluate(node => {
      const sample = node.querySelector('[role="radio"]')
      if (!sample) throw new Error('The synthetic branch list is empty')
      while (node.querySelectorAll('[role="radio"]').length < 15) {
        const row = sample.cloneNode(true) as HTMLElement
        row.setAttribute('aria-label', `Synthetic branch ${node.children.length + 1}`)
        node.append(row)
      }
    })
    expect(await branches.getByRole('radio').count()).toBeGreaterThanOrEqual(15)
    const metrics = await branches.evaluate(node => ({ height: node.getBoundingClientRect().height, client: node.clientHeight, scroll: node.scrollHeight, overflow: getComputedStyle(node).overflowY }))
    expect(metrics.client).toBeGreaterThan(0)
    expect(metrics.height).toBeLessThanOrEqual(Math.min(168, height * 0.4) + 1)
    expect(metrics.overflow).toBe('auto')
    expect(metrics.scroll).toBeGreaterThan(metrics.client + 1)
    expect(await branches.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop })).toBeGreaterThan(0)
  })
}
