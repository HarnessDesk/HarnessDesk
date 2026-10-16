import { expect, test, type Page } from '@playwright/test'

/**
 * The front door, mounted from the real preview harness through the same
 * New Team dialog. Fill its task, choose a Flow, then Start Team; keyboard and
 * pointer both reach it. `FrontDoor.test.tsx` and `store.front-door.test.ts` own the
 * interaction logic itself; this is the one thing jsdom cannot answer: what
 * a real browser lays out and focuses, at desktop and narrow widths, in
 * light and dark.
 */

const openFrontDoor = async (page: Page): Promise<void> => {
  await page.goto('/preview.html?team-start=picker')
  await expect(page.getByRole('dialog', { name: 'New Team', exact: true })).toBeVisible()
}

const openBrokenFixture = async (page: Page): Promise<void> => {
  await page.goto('/preview.html')
  const dialogSelect = page.locator('select', { has: page.locator('option', { hasText: 'new session' }) }).first()
  await dialogSelect.selectOption('new session')
  await page.getByRole('radio', { name: 'Team' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
}

test('a chosen Flow shows its seats in the same task dialog before Start Team', async ({ page }) => {
  await openFrontDoor(page)

  const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
  const original = await dialog.elementHandle()
  const task = page.getByLabel('What should they do?')
  await expect(task).toBeVisible()
  await expect(page.getByRole('button', { name: 'Write and review', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()
  await task.fill('Fix the cart total')
  await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeDisabled()

  await page.getByRole('button', { name: 'Write and review', exact: true }).click()

  expect(await dialog.evaluate((node, opened) => node === opened, original)).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByLabel('Search Flows')).toBeVisible()
  await expect(task).toHaveValue('Fix the cart total')
  await expect(page.getByRole('button', { name: 'Agent for Writes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Agent for Reviews' })).toBeVisible()
  await expect(page.getByLabel('Done when · optional')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
  await expect(page.getByText('It opens 2 seats')).toBeHidden()
  await page.getByText('Details', { exact: true }).click()
  await expect(page.getByText('It opens 2 seats')).toBeVisible()
})

test('a broken shape stays visible with its own reason, never silently dropped from the list', async ({ page }) => {
  await openBrokenFixture(page)
  const broken = page.getByRole('button', { name: 'Broken flow', exact: true })
  await expect(broken).toBeVisible()
  await expect(broken).toContainText('there is no usable Agent called "ghost"')
})

test('keyboard moves from the task to Flow search, picks a card and Escape closes the dialog', async ({ page }) => {
  await openFrontDoor(page)

  await expect(page.getByLabel('What should they do?')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Build your own', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Search Flows')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'Write and review', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Write and review', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Done when · optional')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('fits light, dark and a narrow width with no clipped row', async ({ page }) => {
  for (const width of [1280, 680]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await openFrontDoor(page)

      const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
      await expect(dialog).toBeVisible()
      const overflow = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        const widest = [...node.querySelectorAll<HTMLElement>('*')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
        return widest - rect.right
      })
      expect(overflow, `front door at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
    }
  }
})
