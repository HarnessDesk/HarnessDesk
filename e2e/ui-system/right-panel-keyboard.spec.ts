import { expect, test } from '@playwright/test'

const views = ['trajectory', 'git', 'terminal', 'browser', 'file', 'changes', 'agents', 'tasks'] as const

const expectClosed = async (page: import('@playwright/test').Page, view: typeof views[number]) => {
  await expect.poll(() => page.evaluate((terminal) => {
    const store = (window as unknown as { __narrowOverlayStore: import('../../packages/ui/src/state/store').AppStore }).__narrowOverlayStore
    const snapshot = store.getSnapshot(), subject = store.workSubject()
    if (!terminal) return subject !== null && snapshot.workbench.frameTools[subject]?.open === false
    const root = snapshot.workbench.bottom.root
    return root.kind === 'stack' && root.views.every(one => one.view.kind !== 'terminal')
  }, view === 'terminal')).toBe(true)
}

const tabToCollapse = async (page: import('@playwright/test').Page, collapse: import('@playwright/test').Locator) => {
  await collapse.evaluate((target) => {
    const focusable = [...document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]',
    )].filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.matches(':disabled'))
    const previous = focusable[focusable.indexOf(target as HTMLElement) - 1]
    if (!previous) throw new Error('collapse button has no preceding Tab stop')
    previous.focus()
  })
  await page.keyboard.press('Tab')
  await expect(collapse).toBeFocused()
}

for (const view of views) {
  test(`${view}: keyboard collapse returns focus to the conversation composer`, async ({ page }) => {
    await page.goto(`/narrow-overlay.html?view=${view}`)
    await page.setViewportSize({ width: 1200, height: 900 })

    const composer = page.locator('[data-pane-id] textarea').first()
    await expect(composer).toBeVisible()
    await composer.focus()

    const collapse = page.getByRole('button', { name: view === 'terminal' ? 'Close terminal' : 'Toggle right panel', exact: true })
    await tabToCollapse(page, collapse)
    await page.keyboard.press('Enter')
    await expectClosed(page, view)
    await expect(composer).toBeFocused()

    await page.reload()
    await composer.focus()
    const again = page.getByRole('button', { name: view === 'terminal' ? 'Close terminal' : 'Toggle right panel', exact: true })
    await tabToCollapse(page, again)
    await page.keyboard.press('Space')
    await expectClosed(page, view)
    await expect(composer).toBeFocused()
  })
}

test('terminal: Escape then Tab moves focus from xterm to the panel controls', async ({ page }) => {
  await page.goto('/narrow-overlay.html?view=terminal')
  const terminal = page.locator('.xterm textarea').first()
  await expect(terminal).toBeVisible()
  const hint = page.locator('[data-slot="tool-pane-bar"]')
  await expect(hint).toHaveAttribute('title', /Escape.*Tab.*1\.5 seconds/i)
  const describedBy = await terminal.getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy!.split(/\s+/)[0]}`)).toContainText(/single Escape is sent to the shell immediately/i)
  await terminal.focus()
  await page.keyboard.press('Tab')
  await expect(terminal).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(terminal).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close terminal' })).toBeFocused()
})

test('git commit history is one Tab stop and uses arrow keys within the grid', async ({ page }) => {
  await page.goto('/narrow-overlay.html?view=git')
  const commits = page.getByRole('grid', { name: 'Commits' })
  await expect(commits).toHaveAttribute('tabindex', '0')
  const activeRows = await commits.locator('[role="row"][aria-selected]').evaluateAll((nodes) =>
    nodes.filter((node) => Number((node as HTMLElement).tabIndex) >= 0).length,
  )
  expect(activeRows).toBe(0)
  await commits.focus()
  await page.keyboard.press('ArrowDown')
  await expect(commits).toBeFocused()
  const active = await commits.getAttribute('aria-activedescendant')
  expect(active).toBeTruthy()
  await expect(commits.locator(`[id="${active}"]`)).toHaveAttribute('role', 'row')
})
