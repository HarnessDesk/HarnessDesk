import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * An approval's answers take a click.
 *
 * The approval dialog draws its scrim and its surface side by side inside one
 * scope. The scrim wears `DialogOverlay`'s `z-index: 100`; the surface's
 * viewport was `position: absolute` with no z-index, which is `auto`. A
 * positioned box at 100 paints over a positioned sibling at `auto` whatever
 * their order in the tree, so the scrim covered the viewport and every button
 * in it. In the app a pointer at Allow, Allow for this session or Deny landed
 * on `[data-slot="dialog-overlay"]`, and the only way to answer was a digit.
 *
 * Nothing saw it for the two days it shipped: `ApprovalDialog.test.tsx` runs in
 * jsdom, which does no hit-testing, and the screenshot rig answers approvals
 * through the store. This asks a browser what is under the pointer, which is
 * the only thing that can say.
 *
 * The check is every answer rather than one, and it is read from the dialog
 * rather than listed here, so an answer added tomorrow is measured by the same
 * rule on the day it is written.
 */

/** Opens the catalog's approval dialog, the same component the app mounts over a conversation. */
async function openApproval(page: Page): Promise<Locator> {
  await page.goto('/design.html?view=dialog')
  await page.getByRole('button', { name: 'Approval', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Run a command?' })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * The element a pointer at the middle of `target` would land on, named the way
 * a failure should read: the slot it carries, else its tag.
 */
async function struckAtCentre(target: Locator) {
  await target.scrollIntoViewIfNeeded()
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const hit = document.elementFromPoint(x, y)
    const name = hit ? (hit.getAttribute('data-slot') ?? hit.tagName.toLowerCase()) : 'nothing'
    // A button holds a glyph, a label and a shortcut: the innermost of them is
    // what a pointer lands on, and all of them are the button.
    return { x, y, name, isTarget: hit !== null && node.contains(hit) }
  })
}

test.describe('the approval dialog', () => {
  test('holds its answers, and keeps the pane behind them from taking a pointer', async ({ page }) => {
    // The control. It passes with the layering fix and without it, so a red
    // run of the test below cannot be a dialog that never opened.
    const dialog = await openApproval(page)
    await expect(dialog.getByRole('button')).toHaveText([/Keep waiting/, /Run once/])

    // The dialog answers its pane's question, so nothing behind it may be
    // clicked meanwhile. A point of the scope away from the dialog must land
    // inside the scope, on the scrim or the viewport laid over it.
    const behind = await page.locator('[data-slot="approval-dialog-scope"]').evaluate((scope) => {
      const box = scope.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + 4, Math.max(box.top, 0) + 4)
      return hit !== null && scope.contains(hit)
    })
    expect(behind).toBe(true)
  })

  test('takes a pointer on each of its answers', async ({ page }) => {
    const answers = (await openApproval(page)).getByRole('button')
    const count = await answers.count()
    // A dialog with nothing to answer with would pass a loop of none.
    expect(count).toBeGreaterThanOrEqual(2)

    for (let index = 0; index < count; index += 1) {
      // Each in a dialog of its own: the catalog closes it on any answer.
      const dialog = await openApproval(page)
      const answer = dialog.getByRole('button').nth(index)
      const label = (await answer.innerText()).replace(/\s+/g, ' ').trim()

      const struck = await struckAtCentre(answer)
      expect(struck.isTarget, `a pointer at the middle of "${label}" lands on ${struck.name}`).toBe(true)

      // Then trusted input at that point, which is what a person's hand is.
      // Both answers close the catalog's dialog, so a click that reached the
      // scrim instead leaves it open.
      await page.mouse.click(struck.x, struck.y)
      await expect(dialog, `a click on "${label}" left the dialog open`).toHaveCount(0)
    }
  })
})
