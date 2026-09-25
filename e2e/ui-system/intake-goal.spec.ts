import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * The machine-wide controls in Settings › Workspaces, and a trigger Goal's
 * own page — both mounted from the real preview harness, against the real
 * `TriggerSettings` and `TeamRoomPane` modules the app renders.
 *
 * A trigger Goal's page puts nothing between its one-row header and the
 * conversation. Where it came from is the header's origin chip and its hover
 * card; what the run is doing is the header's one state chip; what it waits
 * on, or why it stopped, is the thread's one live line; a member's approval
 * takes the composer's slot; and the budget is the composer's footer strip.
 */

const triggerFrame = (page: Page): Locator => page.locator('section', { has: page.locator('h2', { hasText: 'Goal — opened by a trigger' }) })
const plainFrame = (page: Page): Locator => page.locator('section', { has: page.locator('h2', { hasText: 'Goal — state, roster and channel' }) })
const scene = async (page: Page, name: string): Promise<void> => {
  await page.locator('select', { has: page.locator('option', { hasText: 'held-message' }) }).first().selectOption(name)
}
/** The room's chat half, which a narrow room shows one at a time with its rail. */
const showChat = async (frame: Locator): Promise<void> => {
  if (await frame.locator('[data-showing="rail"]').count()) {
    await frame.locator('[data-slot="list-row"]', { hasText: 'Chat' }).first().click()
  }
}
const stateChip = (frame: Locator): Locator => frame.locator('header [data-slot="chip"]').first()
const liveLine = (frame: Locator): Locator => frame.locator('[data-slot="room-live-line"]')
const budget = (frame: Locator): Locator => frame.locator('[data-slot="room-budget"]')

test('pausing every trigger is read back before it shows paused, and the daily cap is a labelled currency field', async ({ page }) => {
  await page.goto('/preview.html')
  const section = page.locator('[aria-label="Triggers on this Mac"]').first()
  await expect(section).toBeVisible()

  const pause = section.getByRole('switch', { name: 'Pause every trigger' })
  await expect(pause).toHaveAttribute('aria-checked', 'false')
  await pause.click()
  await expect(pause).toHaveAttribute('aria-checked', 'true')

  const cap = section.locator('input[type="number"]')
  await expect(cap).toHaveValue('20')
  await expect(section).toContainText('Reserved today')
  await expect(section).toContainText('Charged today')
})

test('a Goal a trigger opened shows its origin as a header chip whose card names the source, with no Intake data for a plain Goal beside it', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  const chip = frame.locator('header [data-slot="hover-card-trigger"]', { hasText: '#12' })
  await expect(chip).toBeVisible()
  await chip.hover()
  const card = page.locator('[data-slot="hover-card-content"]', { hasText: 'started this Goal' })
  await expect(card).toContainText('Pull request #12')
  await expect(card.getByRole('button', { name: 'Open' })).toBeVisible()
  // The origin is the chip's; the title never repeats the trigger's own id.
  await expect(frame.locator('header')).not.toContainText('from trigger')

  const plain = plainFrame(page)
  await expect(plain.locator('header [data-slot="hover-card-trigger"]')).toHaveCount(0)
  await expect(budget(plain)).toHaveCount(0)
})

test('a held message and a held action each read Needs you, and the live line names what is held', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  await scene(page, 'held-message')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveText('Needs you')
  await expect(liveLine(frame)).toContainText('held for your review')

  await scene(page, 'held-action')
  await expect(stateChip(frame)).toHaveText('Needs you')
  await expect(liveLine(frame)).toContainText('An action is held for your approval.')
})

test('a member’s approval takes the composer’s slot in flow, answers only from the card, and gives the composer back', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  await scene(page, 'approval')
  await showChat(frame)
  const card = frame.locator('[data-slot="approval-card"]')
  await expect(card).toBeVisible()
  await expect(stateChip(frame)).toHaveText('Needs you')
  await expect(liveLine(frame)).toContainText('is waiting for your approval')
  // Not a dialog, no scrim, and the composer is only hidden under it.
  await expect(frame.locator('[role="dialog"], [data-slot="dialog-overlay"]')).toHaveCount(0)
  await expect(frame.locator('textarea')).toBeHidden()
  // The footer strip stays under the card.
  await expect(budget(frame)).toContainText('left')

  // A 1 typed in another field is that field's.
  const filter = page.locator('input[aria-label="Filter sessions"]').first()
  await filter.focus()
  await page.keyboard.press('1')
  await expect(filter).toHaveValue('1')
  await expect(card).toBeVisible()
  await filter.fill('')
  // In the card, it answers.
  await card.locator('h2').click()
  await page.keyboard.press('1')
  await expect(card).toHaveCount(0)
  await expect(frame.locator('textarea')).toBeVisible()
})

test('a question that timed out and a budget stop each name their exact reason, with partial work kept', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  await scene(page, 'question')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveText('Needs you')
  await expect(liveLine(frame)).toContainText('nobody answered in time')

  await scene(page, 'stopped')
  await expect(stateChip(frame)).toHaveText('Stopped')
  // The host's own detail already carries the label, so it is shown alone
  // rather than after the generic "Out of budget." — which said the same
  // thing twice on a real host (#917).
  await expect(liveLine(frame)).toContainText('The daily cap was reached before this round closed.')
  await expect(liveLine(frame)).not.toContainText('Out of budget.')
  // What the stopped run already spent is kept and said.
  await expect(budget(frame)).toContainText('left')

  await scene(page, 'unknown-budget')
  await expect(budget(frame)).toContainText('Spend unknown')
  await expect(budget(frame)).not.toContainText('left')
})

test('machine settings and a trigger Goal fit light, dark and narrow layouts with no clipped sentence', async ({ page }) => {
  const overflow = (node: Locator) => node.evaluate((root) => {
    const rect = root.getBoundingClientRect()
    const widest = [...root.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
    return widest - rect.right
  })
  /* A sentence arrives whole: nothing on the line is cut by its own box. */
  const clipped = (node: Locator) => node.evaluate((root) =>
    [root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? ''))

  for (const width of [1280, 640]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')

      const settings = page.locator('[aria-label="Triggers on this Mac"]').first()
      await expect(settings).toBeVisible()
      expect(await overflow(settings), `settings at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)

      const frame = triggerFrame(page)
      for (const name of ['stopped', 'approval']) {
        await scene(page, name)
        await showChat(frame)
        const header = frame.locator('header')
        await expect(header).toBeVisible()
        expect(await overflow(header), `header at ${width}px, ${colorScheme}, ${name}`).toBeLessThanOrEqual(1)
        await expect(liveLine(frame)).toBeVisible()
        expect(await clipped(liveLine(frame)), `live line at ${width}px, ${colorScheme}, ${name}`).toEqual([])
        expect(await clipped(budget(frame)), `budget at ${width}px, ${colorScheme}, ${name}`).toEqual([])
        if (name === 'approval') {
          const card = frame.locator('[data-slot="approval-card"]')
          await expect(card).toBeVisible()
          expect(await overflow(card), `approval at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
        }
      }
    }
  }
})
