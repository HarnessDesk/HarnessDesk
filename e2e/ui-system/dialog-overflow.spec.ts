import { expect, test } from '@playwright/test'

/**
 * A dialog holds what it is given, in both directions.
 *
 * The hand-off sheet did neither. Its three choices were drawn at the `sm`
 * control size — a fixed 28px box whose base does not wrap — so the hint under
 * each label ran the row wider than the dialog and the dialog grew a horizontal
 * scrollbar, while the two lines of the choice itself sat outside the 28px they
 * had been given. On screen that reads as the labels being cut off at the left
 * and the descriptions running off to the right, which is what was reported.
 *
 * The check is the class rather than the case: nothing inside a dialog may be
 * wider than the dialog, and a choice's own words may not stand outside it.
 */
test('the hand-off dialog holds its choices', async ({ page }) => {
  // Mount the real sheet in the existing preview. Only the frame is supplied
  // here; the dialog, its controls and its styles are the production modules.
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import sheetReact from ${JSON.stringify(reactUrl)};
        import { HandoffSheet } from '/src/components/ComposerControls.tsx';
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Hand-off sheet fixture');
        document.body.append(frame);
        createRoot(frame).render(sheetReact.createElement(HandoffSheet, {
          to: 'Claude', from: 'Codex', onCancel: () => {}, onConfirm: () => {},
        }));
      `,
    })
  })
  await page.goto('/preview.html')

  const dialog = page.getByRole('dialog', { name: /Hand off to/ })
  await expect(dialog).toBeVisible()

  // Nothing in it is wider than it is.
  const overflow = await dialog.evaluate(node => {
    const widest = [...node.querySelectorAll('*')]
      .map(child => child.scrollWidth - node.clientWidth)
      .reduce((most, over) => Math.max(most, over), 0)
    return { own: node.scrollWidth - node.clientWidth, widest }
  })
  expect(overflow.own).toBeLessThanOrEqual(1)
  expect(overflow.widest).toBeLessThanOrEqual(1)

  // And each choice contains its own words, which a fixed-height row does not.
  const choices = dialog.getByRole('radio')
  await expect(choices).toHaveCount(3)
  const spill = await choices.evaluateAll(nodes =>
    nodes.flatMap(node => {
      const box = node.getBoundingClientRect()
      return [...node.querySelectorAll('div')]
        .filter(child => child.textContent?.trim())
        .map(child => {
          const rect = child.getBoundingClientRect()
          return Math.max(box.top - rect.top, rect.bottom - box.bottom, box.left - rect.left, rect.right - box.right)
        })
    }),
  )
  expect(Math.max(...spill)).toBeLessThanOrEqual(1)
})

/**
 * And the sheet that is a whole screen holds it at both window widths.
 *
 * The sign-in sheet's stylesheet asked for 980px and it was drawn at 448 —
 * `DialogContent`'s base caps a dialog at `sm:max-w-md`, and `app.css` is
 * bundled after the modules, so a `width` in a stylesheet loses to a
 * `max-width` in a utility however specific it is. At 448 the fixed 244px
 * rail left 172 for the pane beside it: the agent's address was cut
 * mid-word, and the closing card's sentence came out one word per line with
 * its button on top of the text. The rows were the hand-off dialog's bug
 * again, a two-line name in a `sm` control's fixed 28px box.
 *
 * Both widths, because each caught something the other did not.
 */
for (const [where, width, height] of [
  ['a narrow window', 520, 820],
  ['a wide one', 1280, 900],
] as const) {
  test(`the sign-in sheet holds its agents at ${where}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/preview.html')
    await page.evaluate(async () => { await document.fonts.ready })
    await page.getByLabel('dialog').selectOption('sign in')
    const dialog = page.getByRole('dialog').first()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Your agents')).toBeVisible()

    const held = await dialog.evaluate(node => {
      const box = node.getBoundingClientRect()
      const rows = [...node.querySelectorAll('[class*="rosterRow"]')]
      return {
        rows: rows.length,
        // A row whose own words stand outside it is a fixed-height control
        // holding two lines, which is what makes the list read as overlapping.
        spill: rows.flatMap(row => {
          const r = row.getBoundingClientRect()
          return [...row.querySelectorAll('span')]
            .filter(child => child.textContent?.trim())
            .map(child => Math.round(child.getBoundingClientRect().bottom - r.bottom))
        }),
        // Nothing crushed to nothing: a flex child with `min-width: 0` and no
        // floor beside two `flex: none` siblings reaches zero.
        narrowest: Math.min(...[...node.querySelectorAll('[class*="nextText"], [class*="rosterText"]')]
          .map(child => Math.round(child.getBoundingClientRect().width))),
        over: [...node.querySelectorAll('*')]
          .map(child => child.scrollWidth - node.clientWidth)
          .reduce((most, past) => Math.max(most, past), 0),
        head: Math.round((node.children[0] as HTMLElement).getBoundingClientRect().height),
        width: Math.round(box.width),
      }
    })
    expect(held.rows).toBeGreaterThan(0)
    expect(Math.max(...held.spill)).toBeLessThanOrEqual(1)
    expect(held.narrowest).toBeGreaterThan(80)
    expect(held.over).toBeLessThanOrEqual(1)
    // The head is a bar, not half the sheet: `DialogContent`'s grid gave its
    // two children a row each until the sheet asked to bleed.
    expect(held.head).toBeLessThan(80)
    expect(held.width).toBeGreaterThan(Math.min(width - 64, 480))
  })
}
