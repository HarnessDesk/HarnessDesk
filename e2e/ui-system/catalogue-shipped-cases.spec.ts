import { expect, test } from '@playwright/test'

const caseLabel = (page: import('@playwright/test').Page, label: string) =>
  page.getByText(label, { exact: true }).locator('..')

test('approval titles and body copy share their leading edge', async ({ page }) => {
  await page.goto('/design.html?view=room-side-by-side')
  const waiting = caseLabel(page, 'room — Side by side · two members, waiting for you')
  const dialog = waiting.getByRole('dialog', { name: 'Run this command?' })
  await expect(dialog).toBeVisible()
  const offset = await dialog.evaluate(surface => {
    const title = surface.querySelector('h2')!.getBoundingClientRect()
    const body = surface.querySelector('[data-slot="approval-reason"]')!.getBoundingClientRect()
    return Math.abs(title.left - body.left)
  })
  expect(offset).toBeLessThan(1)

  await page.goto('/preview.html?board-tool-approvals')
  const docked = page.locator('[data-frame-id="board-tool-approval-always"] [data-slot="approval-card"]')
  await expect(docked).toBeVisible()
  const dockedOffset = await docked.evaluate(surface => Math.abs(
    surface.querySelector('h2')!.getBoundingClientRect().left -
    surface.querySelector('[data-slot="approval-reason"]')!.getBoundingClientRect().left,
  ))
  expect(dockedOffset).toBeLessThan(1)
})

for (const width of [256, 320]) test(`a ${width}px waiting tile keeps its member name on one line`, async ({ page }) => {
  await page.goto('/design.html?view=room-side-by-side')
  const narrow = caseLabel(page, 'room — Side by side · narrow tabs with a waiting mark')
  const tile = narrow.locator('[data-slot="side-by-side-tile"][aria-label="Beta"]')
  await expect(tile).toBeVisible()
  if (width === 256) await tile.evaluate(element => {
    (element.parentElement!.parentElement as HTMLElement).style.width = '256px'
  })
  await page.evaluate(async () => { await document.fonts.ready })
  await expect.poll(() => tile.evaluate(element => element.getBoundingClientRect().width)).toBe(width)
  const lines = await tile.locator('header').getByText('Beta', { exact: true }).evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return new Set([...range.getClientRects()].map(rect => rect.top)).size
  })
  expect(lines).toBe(1)
  const header = tile.locator('header')
  expect(await header.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('the catalogue renders shipped composer slots and Side by side cases', async ({ page }) => {
  await page.goto('/design.html?view=composer-fixed-slots')
  await expect(page.locator('[data-composer-layout="live"] [data-composer-track="model"]').first()).toBeVisible()

  await page.goto('/design.html?view=room-side-by-side')
  const rail = caseLabel(page, 'room rail — Side by side · disabled with its reason')
  await expect(rail).toBeVisible()
  await expect(rail.locator('[aria-disabled="true"]')).toContainText('Side by side')
  await expect(rail.locator('[aria-disabled="true"]')).not.toHaveAttribute('data-refused')
  const label = rail.locator('[data-slot="list-row-title"] > span')
  await expect(label).toHaveText('Side by side')
  await expect(label).toHaveAttribute('title', 'Watch a member to put it here')
  await expect(rail.locator('[data-slot="list-row-subtitle"]')).toHaveCount(0)

  const two = caseLabel(page, 'room — Side by side · two members, grid without a composer')
  await expect(two.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(two.locator('[data-slot="composer"]')).toHaveCount(0)
  await expect(two.getByRole('dialog')).toHaveCount(0)

  const four = caseLabel(page, 'room — Side by side · four members, tile states and ceiling')
  await expect(four.locator('[data-slot="side-by-side-tile"]')).toHaveCount(4)
  const tile = (nickname: string) => four.locator(`[data-slot="side-by-side-tile"][aria-label="${nickname}"]`)
  await expect(tile('Alpha').getByText('Working', { exact: true })).toBeVisible()
  await expect(tile('Alpha').getByText('Edit', { exact: true })).toBeVisible()
  await expect(four.getByRole('dialog')).toHaveCount(0)
  await expect(tile('Beta').getByText('Done', { exact: true })).toBeVisible()
  await expect(tile('Gamma').getByText('Stopped', { exact: true })).toBeVisible()
  await expect(tile('Delta').getByText(/Working|Waiting for you|Done|Stopped/)).toHaveCount(0)
  // A ready member is a conversation nobody has used yet, not one whose messages failed to restore.
  await expect(tile('Delta').getByText('Nothing to show')).toHaveCount(0)
  await expect(tile('Delta').getByText('What should we build?')).toBeVisible()

  const narrow = caseLabel(page, 'room — Side by side · narrow tabs')
  await expect(narrow.getByRole('tablist', { name: 'Side by side tiles' })).toBeVisible()
  await expect(narrow.getByRole('tab')).toHaveCount(4)
  await expect(narrow.getByRole('dialog')).toHaveCount(0)
})

test('the waiting grid case renders the shipped dialog and badge', async ({ page }) => {
  await page.goto('/design.html?view=room-side-by-side')
  const waiting = caseLabel(page, 'room — Side by side · two members, waiting for you')
  await expect(waiting.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(waiting.getByRole('dialog', { name: 'Run this command?' })).toBeVisible()
  await expect(waiting.locator('[data-slot="side-by-side-tile"][aria-label="Beta"]').getByText('Waiting for you', { exact: true })).toBeVisible()
})

test('the waiting tab case renders the shipped mark and dialog', async ({ page }) => {
  await page.goto('/design.html?view=room-side-by-side')
  const waitingTabs = caseLabel(page, 'room — Side by side · narrow tabs with a waiting mark')
  await expect(waitingTabs.getByRole('tab', { name: 'Beta waiting for you' }).getByLabel('waiting for you')).toBeVisible()
  await expect(waitingTabs.getByRole('dialog', { name: 'Run this command?' })).toBeVisible()
})

test('the catalogue renders refused and partial TurnFiles states', async ({ page }) => {
  await page.goto('/design.html?view=code')
  const refused = caseLabel(page, 'Undo refused: the unrecoverable file is named and the rest can be put back')
  await expect(refused).toBeVisible()
  await expect(refused.getByRole('button', { name: 'Undo the rest' })).toBeVisible()
  await expect(refused.getByRole('button', { name: /empty\.tsdeleted/ })).toBeVisible()
  await expect(page.getByText('Cannot put back /workspace/src/empty.ts: the agent recorded no content for it. Nothing was changed.')).toBeVisible()

  const partial = caseLabel(page, 'partial Undo: Close stays greyed until the half changed turn is resolved')
  await expect(partial).toBeVisible()
  await expect(partial.getByRole('button', { name: 'Undo' })).toBeVisible()
  await expect(partial.getByRole('button', { name: 'Close' })).toBeDisabled()
})
