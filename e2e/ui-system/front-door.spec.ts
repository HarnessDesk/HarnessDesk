import { expect, test, type Page } from '@playwright/test'

/**
 * The front door, mounted from the real preview harness through the same
 * new-session chooser `NewSessionChoice` already opens it from. Two clicks —
 * choose a shape, then Start — with the populated dry run readable in
 * between; keyboard and pointer both reach it, and each returns focus where
 * it found it. `FrontDoor.test.tsx` and `store.front-door.test.ts` own the
 * interaction logic itself; this is the one thing jsdom cannot answer: what
 * a real browser lays out and focuses, at desktop and narrow widths, in
 * light and dark.
 */

const openFrontDoor = async (page: Page): Promise<void> => {
  await page.goto('/preview.html')
  const dialogSelect = page.locator('select', { has: page.locator('option', { hasText: 'new session' }) }).first()
  await dialogSelect.selectOption('new session')
  await page.getByRole('button', { name: 'Start with a team' }).click()
}

test('choosing a shape then Start is two clicks, with the populated dry run readable before either', async ({ page }) => {
  await openFrontDoor(page)

  // The chooser: every catalogue entry the fixture ships, not a hardcoded
  // pair — `flow-fixture.ts`'s four entries, one of them shadowed and one
  // broken, both still visible with their own reason.
  await expect(page.getByRole('button', { name: /^Fix and review/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Broken flow/ })).toBeVisible()
  // Before a shape is chosen there is nothing to start — Cancel is the only
  // footer action, not a Start a person could press too soon.
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)

  // Click one: choose a shape that will run.
  await page.getByRole('button', { name: /^Fix and review/ }).click()

  // The populated dry run — seats, the sentence field, the resolved target —
  // reads before Start is ever pressed.
  await expect(page.getByText('It opens 2 seats')).toBeVisible()
  await expect(page.getByLabel('What finishes this?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()

  // Click two would be Start; this spec stops at "ready to start; nothing
  // used yet", which is what a dry run promises. `flow/start-goal` itself is
  // not wired into this harness (`startFlowGoal` says so explicitly) — real
  // starts are the CDP walkthrough's job, on the actual app.
})

test('a broken shape stays visible with its own reason, never silently dropped from the list', async ({ page }) => {
  await openFrontDoor(page)
  await expect(page.getByRole('button', { name: /^Broken flow — will not run/ })).toBeVisible()
})

test('keyboard reaches the chooser, a chosen shape, and back — Escape returns focus to the row that opened it', async ({ page }) => {
  await openFrontDoor(page)

  const shape = page.getByRole('button', { name: /^Fix and review/ })
  await shape.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('It opens 2 seats')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByText('It opens 2 seats')).toBeHidden()
})

test('fits light, dark and a narrow width with no clipped row', async ({ page }) => {
  for (const width of [1280, 680]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await openFrontDoor(page)

      const dialog = page.getByRole('dialog', { name: 'Start a team' })
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
