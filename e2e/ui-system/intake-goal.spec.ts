import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeTeamDetails, selectTeamPage, teamDetails } from './team-frame-actions'

/**
 * The machine-wide controls in Settings › Workspaces, and a trigger Goal's
 * own page — both mounted from the real preview harness, against the real
 * `TriggerSettings` and `TeamRoomPane` modules the app renders.
 *
 * A trigger Team opens Work. Chat carries its live wait or stop reason and
 * keeps the budget beside the persistent composer. A member's approval is an
 * attributable request in the stream, with the same request in its session;
 * the Chat badge keeps it discoverable while another page is selected.
 */

const triggerFrame = (page: Page): Locator => page.locator('section', { has: page.locator('h2', { hasText: 'Goal — opened by a trigger' }) })
const plainFrame = (page: Page): Locator => page.locator('section', { has: page.locator('h2', { hasText: 'Goal — state, roster and channel' }) })
const scene = async (page: Page, name: string): Promise<void> => {
  await page.locator('select', { has: page.locator('option', { hasText: 'held-message' }) }).first().selectOption(name)
}
/** Chat remains reachable at every pane width. */
const showChat = async (frame: Locator): Promise<void> => {
 await selectTeamPage(frame, 'room')
}
const stateChip = (frame: Locator): Locator => frame.locator('[data-topbar="state"] [data-slot="dot"]')
const liveLine = (frame: Locator): Locator => frame.locator('[data-slot="room-live-line"]')
const budget = (frame: Locator): Locator => frame.locator('[data-slot="room-budget"]')

/**
 * A person's own front-door start: Details names what the run
 * reviews (a pinned revision, or a diff/working tree's own label alone), and
 * the thread's live line carries a person's own stop, exactly as
 * `TeamRoomPane`'s target/stop computations claim but nothing here
 * had shown before this spec — the fixture drives `flowExecutions` directly
 * (`packages/ui/src/preview/flow-fixture.ts`), the only way to reach that
 * state without a real host's `flow/start-goal`.
 */
const flowFrame = (page: Page): Locator =>
  page.locator('section', { has: page.locator('h2', { hasText: "Goal — a front-door start's pinned revision or stop line" }) })
const flowScene = async (page: Page, name: string): Promise<void> => {
  await page.locator('select', { has: page.locator('option', { hasText: 'working-diff' }) }).first().selectOption(name)
}

const runFact = (details: Locator, label: string): Locator => details.locator('[aria-label="Team Run facts"] [data-slot="summary-item"]')
  .filter({ has: details.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) })
/** A path has one accessible full value and two painted truncation pieces.
 * Check both representations; their combined textContent repeats the value. */
const expectAt = async (frame: Locator, expected: string): Promise<void> => {
  const value = runFact(await teamDetails(frame), 'At').locator('[data-slot="middle-truncate"]')
  await expect(value.locator(':scope > .sr-only')).toHaveText(expected)
  expect((await value.locator('[data-part]').allTextContents()).join('').replace(/\u00a0/g, ' ')).toBe(expected)
}

test('a front-door start pins its revision in Details, names a diff or working tree by its label alone, and a person’s own stop shows as its live line', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = flowFrame(page)
  await showChat(frame)
  await flowScene(page, 'pinned')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Running')
  await expectAt(frame, 'a1b2c3d4e5f678901234567890abcdef12345678 on branch feature')
  await expect(frame.locator('[data-slot="top-bar"]')).not.toContainText('a1b2c3d')

  await flowScene(page, 'diff')
  // A diff's own label already carries both ends of the range, so no head is
  // repeated beside it.
  // Exact Details text also refuses a repeated head.
  await expectAt(frame, 'changes from abc123 to def456')

  await flowScene(page, 'working-diff')
  // A working tree has no committed head to pin — its label stands alone too.
  await expectAt(frame, 'the working tree')

  await flowScene(page, 'stopped')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Stopped')
  await expect(liveLine(frame)).toContainText('The person stopped this flow')
  // The pinned revision from the same target still names what was reviewed.
  await expectAt(frame, 'a1b2c3d4e5f678901234567890abcdef12345678 on branch feature')
})

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

test('a Goal a trigger opened names its source in Details, with no Intake data for a plain Goal beside it', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  const origin = runFact(await teamDetails(frame), 'Trigger')
  await expect(origin).toBeVisible()
  await expect(origin).toContainText('Pull request #12')
  await expect(origin).toContainText(/started this Goal/i)
  await expect(origin.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  // The title never repeats the trigger's own id or source facts.
  await expect(frame.locator('[data-slot="top-bar"]')).not.toContainText('from trigger')
  await expect(frame.locator('[data-slot="top-bar"]')).not.toContainText('#12')
  await closeTeamDetails(frame)

  const plain = plainFrame(page)
  await expect(plain.locator('[data-slot="top-bar"] [data-slot="hover-card-trigger"]')).toHaveCount(0)
  await expect(runFact(await teamDetails(plain), 'Trigger')).toHaveCount(0)
  await expect(budget(plain)).toHaveCount(0)
})

test('a held message and a held action each read Needs you, and the live line names what is held', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  await scene(page, 'held-message')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Needs you')
  await expect(liveLine(frame)).toContainText('held for your review')

  await scene(page, 'held-action')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Needs you')
  await expect(liveLine(frame)).toContainText('An action is held for your approval.')
})

test('an agent approval shares its session request, keeps the Chat draft, and answers exactly once from the card', async ({ page }) => {
  // Observe the synthetic frame's real responder, without changing its kept
  // request or the production Approvals handler.
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const responder = /respondToApproval:\s*async\s*\(key,\s*id\)\s*=>\s*\{/g
    expect([...source.matchAll(responder)]).toHaveLength(1)
    await route.fulfill({ response, body: source.replace(responder, `respondToApproval: async (key, id, answer) => {
      window.__intakeAnswers ??= [];
      window.__intakeAnswers.push({ key, id, answer });`) })
  })
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  await scene(page, 'approval')
  const chat = frame.locator('[data-team-page="room"]')
  await expect(chat).toHaveAttribute('title', '1 pending reply')
  await expect(chat.locator('[data-slot="dot"][data-pulse]')).toHaveCount(1)
  await showChat(frame)
  const card = frame.locator('[data-slot="approval-card"]')
  await expect(card).toBeVisible()
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Needs you')
  await expect(card.locator('[data-slot="approval-meta"][data-kind="person"]')).toContainText('From')
  await expect(card.locator('[data-slot="approval-code"]')).toHaveText('pnpm test')
  // Inline requests preserve the visible composer; the request itself names
  // its source, so another paragraph saying it is waiting is unnecessary.
  await expect(frame.locator('[role="dialog"], [data-slot="dialog-overlay"]')).toHaveCount(0)
  const composer = frame.locator('[data-slot="composer"] textarea')
  await expect(composer).toBeVisible()
  await composer.fill('Keep this draft ')
  await card.hover()
  await expect(composer).toBeFocused()
  await page.keyboard.press('1')
  await expect(composer).toHaveValue('Keep this draft 1')
  await expect(card).toBeVisible()
  await expect(budget(frame)).toContainText('left')
  const answers = () => page.evaluate(() => (window as unknown as { __intakeAnswers?: unknown[] }).__intakeAnswers ?? [])
  expect(await answers()).toEqual([])

  await card.getByRole('button', { name: 'Open conversation', exact: true }).click()
  const sessionRequest = frame.locator('[data-slot="approval-dialog-scope"] [role="dialog"]')
  await expect(sessionRequest).toBeVisible()
  await expect(sessionRequest.locator('[data-slot="approval-code"]')).toHaveText('pnpm test')
  expect(await answers()).toEqual([])
  await showChat(frame)
  await expect(card).toBeVisible()
  await expect(composer).toHaveValue('Keep this draft 1')

  // A 1 typed in another field is that field's.
  const filter = page.getByRole('searchbox', { name: 'Filter this list', exact: true }).first()
  await filter.focus()
  await page.keyboard.press('1')
  await expect(filter).toHaveValue('1')
  await expect(card).toBeVisible()
  await filter.fill('')
  // The same digit is an answer only after deliberately focusing the card.
  await card.focus()
  await expect(card).toBeFocused()
  await page.keyboard.press('1')
  await expect(card).toHaveCount(0)
  await expect.poll(answers).toEqual([{ key: 'codex\u0000c1', id: 'preview-approval', answer: { type: 'option', optionId: 'yes' } }])
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue('Keep this draft 1')
  await expect(chat).toHaveText('Chat')
  await expect(chat.locator('[data-slot="dot"][data-pulse]')).toHaveCount(0)
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Running')
  await composer.focus()
  await page.keyboard.press('1')
  await expect(composer).toHaveValue('Keep this draft 11')
  expect(await answers()).toHaveLength(1)
})

test('a question that timed out and a budget stop each name their exact reason, with partial work kept', async ({ page }) => {
  await page.goto('/preview.html')
  const frame = triggerFrame(page)
  await scene(page, 'question')
  await showChat(frame)
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Needs you')
  await expect(liveLine(frame)).toContainText('nobody answered in time')

  await scene(page, 'stopped')
  await showChat(frame)
  // A real host pairs every budget stop with a person-kind wait of its own,
  // so the header reads Needs you and the live line shows that wait's
  // sentence — the stop's own detail appears exactly once inside it, never
  // a second time behind a generic "Out of budget." fallback label (#917).
  await expect(stateChip(frame)).toHaveAttribute('aria-label', 'Needs you')
  await expect(liveLine(frame)).toContainText('Out of budget: the daily cap was reached before this round closed.')
  const lineText = await liveLine(frame).innerText()
  expect(lineText.match(/Out of budget/g)).toHaveLength(1)
  // What the stopped run already spent is kept and said.
  await expect(budget(frame)).toContainText('left')

  await scene(page, 'unknown-budget')
  await showChat(frame)
  await expect(budget(frame)).toContainText('Spend unknown')
  await expect(budget(frame)).not.toContainText('left')
})

const overflow = (node: Locator) => node.evaluate((root) => {
  const rect = root.getBoundingClientRect()
  const widest = [...root.querySelectorAll<HTMLElement>('*')]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .reduce((max, el) => Math.max(max, el.getBoundingClientRect().right), 0)
  return widest - rect.right
})
/* A sentence arrives whole: nothing on the line is cut by its own box. */
const clipped = (node: Locator) => node.evaluate((root) =>
  [root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) =>
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !el.closest('.sr-only, [hidden]')
    && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? ''))

/**
 * One test per layout, so each has a time budget of its own. They were a
 * single test of four page loads and eight scenes, which took 31.0–31.6 s
 * against Playwright's 30 s test timeout on a loaded CI runner, in pull
 * requests that touched no UI (#1140). A loop inside one test would put the
 * four loads back under one timeout.
 */
for (const width of [1280, 640]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`machine settings and a trigger Goal fit with no clipped sentence at ${width}px in ${colorScheme}`, async ({ page }) => {
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
        const header = frame.locator('[data-slot="top-bar"]')
        await expect(header).toBeVisible()
        expect(await overflow(header), `header at ${width}px, ${colorScheme}, ${name}`).toBeLessThanOrEqual(1)
        if (name === 'stopped') {
          await expect(liveLine(frame)).toBeVisible()
          expect(await clipped(liveLine(frame)), `live line at ${width}px, ${colorScheme}, ${name}`).toEqual([])
        }
        expect(await clipped(budget(frame)), `budget at ${width}px, ${colorScheme}, ${name}`).toEqual([])
        if (name === 'approval') {
          const card = frame.locator('[data-slot="approval-card"]')
          await expect(card).toBeVisible()
          await expect(frame.locator('[data-slot="composer"] textarea')).toBeVisible()
          expect(await overflow(card), `approval at ${width}px, ${colorScheme}`).toBeLessThanOrEqual(1)
        }
      }
    })
  }
}
