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
  await expect(page.getByLabel('Search Flows')).toBeHidden()
  await expect(page.getByRole('region', { name: 'Selected Flow' })).toBeVisible()
  await expect(task).toHaveValue('Fix the cart total')
  await expect(page.getByRole('button', { name: 'Configure Writes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Configure Reviews' })).toBeVisible()
  await expect(page.getByLabel('Done when · optional')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeEnabled()
  await expect(page.getByText('It opens 2 seats')).toBeHidden()
  await page.getByText('Details', { exact: true }).click()
  await expect(page.getByText('It opens 2 seats')).toBeVisible()
  await page.getByRole('button', { name: 'Completion and dry run', exact: true }).click()
  await expect(page.getByLabel('Done when · optional')).toBeVisible()
})

test('a broken shape stays visible with its own reason, never silently dropped from the list', async ({ page }) => {
  await openBrokenFixture(page)
  await page.getByRole('button', { name: 'All Flows', exact: true }).click()
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
  await expect(page.getByRole('region', { name: 'Selected Flow' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change', exact: true })).toBeFocused()
  await expect(page.getByLabel('Done when · optional')).toBeHidden()
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await expect(page.getByLabel('Search Flows')).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('fits light, dark and a narrow width with no clipped row', async ({ page }) => {
  for (const width of [1280, 680]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/preview.html?team-start=picker&theme=${colorScheme}`)
      await page.getByLabel('What should they do?').fill('Fix the cart total')
      await page.getByRole('button', { name: 'Write and review', exact: true }).click()

      const dialog = page.getByRole('dialog', { name: 'New Team', exact: true })
      await expect(dialog).toBeVisible()
      // Measure painted geometry: transformed canvas nodes deliberately pan
      // beyond their overflow-hidden viewport; ordinary controls still must fit.
      const overflow = await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return [...node.querySelectorAll<HTMLElement>('*')].reduce((max, el) => {
          const box = el.getBoundingClientRect()
          if (!box.width || !box.height) return max
          let left = box.left, right = box.right, top = box.top, bottom = box.bottom
          // Only the graph's pan viewport earns clipping. A clipped task,
          // selected-Flow summary or footer control must still fail this check.
          const canvas = el.closest('.react-flow')
          for (let parent = canvas ? el.parentElement : null; parent && parent !== node; parent = parent.parentElement) {
            const clip = parent.getBoundingClientRect(), style = getComputedStyle(parent)
            if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
            if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
          }
          return right > left && bottom > top ? Math.max(max, rect.left - left, right - rect.right) : max
        }, 0)
      })
      expect(overflow, `front door at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
      const task = await page.getByLabel('What should they do?').boundingBox()
      const selected = await page.getByRole('region', { name: 'Selected Flow' }).boundingBox()
      const writes = await dialog.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: 'Configure Writes' }) }).boundingBox()
      const reviews = await dialog.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: 'Configure Reviews' }) }).boundingBox()
      expect(task).not.toBeNull()
      expect(selected).not.toBeNull()
      expect(writes).not.toBeNull()
      expect(reviews).not.toBeNull()
      expect(Math.abs(task!.x - selected!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(task!.width - selected!.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(writes!.y - reviews!.y)).toBeLessThanOrEqual(1)
      expect(Math.abs(writes!.width - reviews!.width)).toBeLessThanOrEqual(1)
      // Role cards share one graph row. Even at its readable minimum scale,
      // every role remains keyboard reachable and opens its own configuration.
      for (const role of ['Writes', 'Reviews']) {
        await page.getByRole('button', { name: `Configure ${role}`, exact: true }).press('Enter')
        await expect(page.getByRole('group', { name: `${role} configuration`, exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('group', { name: `${role} configuration`, exact: true })).toBeHidden()
      }
      await expect(page.getByRole('button', { name: 'Start Team', exact: true })).toBeInViewport()
    }
  }
})
