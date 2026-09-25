import { expect, test } from '@playwright/test'

/**
 * A confirm holds what it asks a person to confirm.
 *
 * The attachment review is a confirm whose body is the thing being approved —
 * a skill's whole text, a server's command line — and it was drawn as a plain
 * block in a box that clipped: a long command ran off the right edge unseen,
 * and a large skill pushed the header and the Approve/Keep footer off the
 * window. Approving what you cannot read is not a review. The checks are the
 * class, on the real `ConfirmDialog` in the real engine: nothing wider than
 * the popup, the popup inside the window, the body scrolling, and both
 * buttons on screen and pressable.
 */
test('a confirm with a long line and a tall body wraps the line, scrolls the body, and keeps its buttons on screen', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import confirmReact from ${JSON.stringify(reactUrl)};
        import { ConfirmDialog } from '/src/design/patterns/ConfirmDialog.tsx';
        import { CodeText } from '/src/design/patterns/Settings.tsx';
        const h = confirmReact.createElement;
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Confirm fixture');
        document.body.append(frame);
        const longLine = 'command: /usr/local/bin/node ' + '--an-argument-that-never-ends-'.repeat(40);
        const tall = Array.from({ length: 400 }, (_, i) => 'line ' + i + ' of a large SKILL.md').join('\\n');
        window.__approved = 0;
        createRoot(frame).render(h(ConfirmDialog, {
          title: 'Approve what Rig Agent would load?', confirmLabel: 'Approve', tone: 'default',
          onCancel: () => {}, onConfirm: () => { window.__approved += 1 },
        }, h('div', null,
          h(CodeText, { as: 'pre', 'data-testid': 'long' }, longLine),
          h(CodeText, { as: 'pre', 'data-testid': 'tall' }, tall),
        )));
      `,
    })
  })
  await page.goto('/preview.html')

  const dialog = page.getByRole('alertdialog', { name: /Approve what/ })
  await expect(dialog).toBeVisible()

  const held = await dialog.evaluate(node => {
    const box = node.getBoundingClientRect()
    const body = node.querySelector('[data-slot="confirm-body"]') as HTMLElement
    const long = node.querySelector('[data-testid="long"]') as HTMLElement
    return {
      over: [...node.querySelectorAll('*')]
        .map(child => child.scrollWidth - (child as HTMLElement).clientWidth)
        .reduce((most, past) => Math.max(most, past), 0),
      longLines: Math.round(long.getBoundingClientRect().height / parseFloat(getComputedStyle(long).lineHeight || '16')),
      top: box.top,
      bottom: box.bottom,
      scrolls: body.scrollHeight > body.clientHeight + 1,
      overflowY: getComputedStyle(body).overflowY,
    }
  })
  expect(held.over, 'nothing in the confirm is wider than its own box: a long command line wraps').toBeLessThanOrEqual(1)
  expect(held.longLines).toBeGreaterThan(1)
  expect(held.top).toBeGreaterThanOrEqual(0)
  expect(held.bottom).toBeLessThanOrEqual(600)
  expect(held.scrolls, 'a tall body scrolls inside the confirm').toBe(true)
  expect(held.overflowY).toBe('auto')

  for (const name of ['Approve', 'Keep']) {
    const button = dialog.getByRole('button', { name })
    await expect(button).toBeInViewport()
  }
  await dialog.getByRole('button', { name: 'Approve' }).click()
  expect(await page.evaluate(() => (window as unknown as { __approved: number }).__approved)).toBe(1)
})
