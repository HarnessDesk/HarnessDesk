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
