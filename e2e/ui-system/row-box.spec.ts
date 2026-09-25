import { expect, test, type Page } from '@playwright/test'

/**
 * A settings row is one box, whichever element draws it.
 *
 * `Row` is a div, `RowButton` and `RowChoice` are the same row drawn on the
 * canonical `Button`. They sit side by side in one `Rows` card, so they have
 * to agree about the box: the inset, the gap, the corner, the divider. The
 * button's `content` size used to carry a `p-0` utility, and in this app a
 * utility wins its tie with a stylesheet class by order — so every row button
 * lost the card's inset and set its words against the card's edge (#866).
 *
 * Measured in the real engine, because jsdom compiles no utilities, so the
 * tie cannot be seen there.
 */

const mount = async (page: Page, width: number) => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import rowReact from ${JSON.stringify(reactUrl)};
        import { Rows, Row, RowButton, RowChoice, RowValue } from '/src/design/patterns/Settings.tsx';
        const h = rowReact.createElement;
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Row fixture');
        frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;background:var(--hd-background);padding:16px;width:${width}px;box-sizing:border-box';
        document.body.append(frame);
        createRoot(frame).render(h('div', null,
          h(Rows, { 'data-testid': 'rowfx-card' },
            h(Row, { 'data-testid': 'rowfx-plain', title: 'Plain row', desc: 'A description', control: h(RowValue, null, 'On') }),
            h(RowButton, { 'data-testid': 'rowfx-button', title: 'Button row', desc: 'A description', control: h(RowValue, null, 'On'), onClick: () => {} }),
            h('div', { role: 'radiogroup' },
              h(RowChoice, { title: 'Choice row', desc: 'A description', selected: true, onClick: () => {} }),
              h(RowChoice, { title: 'Another answer', selected: false, onClick: () => {} })),
            h(Row, { 'data-testid': 'rowfx-last', title: 'Last row' }),
          ),
        ));
      `,
    })
  })
  await page.goto('/preview.html')
  await expect(page.getByRole('region', { name: 'Row fixture' })).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
}

const box = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => {
  const css = getComputedStyle(node)
  return {
    padding: css.padding,
    gap: css.columnGap,
    radius: css.borderRadius,
    divider: `${css.borderBottomWidth} ${css.borderBottomStyle} ${css.borderBottomColor}`,
    sides: `${css.borderTopWidth} ${css.borderLeftWidth} ${css.borderRightWidth}`,
    font: `${css.fontSize}/${css.lineHeight} ${css.fontWeight}`,
  }
})

test('a row button and a row choice draw the same box as the plain row beside them', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await mount(page, 640)
  const plain = await box(page, '[data-testid="rowfx-plain"]')
  // The guard on the guard: a plain row with no inset would make every
  // comparison below trivially true.
  expect(parseFloat(plain.padding.split(' ')[1] ?? plain.padding)).toBeGreaterThan(0)
  expect(await box(page, '[data-testid="rowfx-button"]')).toEqual(plain)
  expect(await box(page, '[aria-label="Row fixture"] [role="radio"]')).toEqual(plain)

  // The words start at the same inset in all three.
  const lefts = await page.evaluate(() => ['[data-testid="rowfx-plain"]', '[data-testid="rowfx-button"]', '[aria-label="Row fixture"] [role="radio"]']
    .map(selector => {
      const row = document.querySelector(selector) as HTMLElement
      const title = row.querySelector('[class*="rowTitle"]') as HTMLElement
      return Math.round(title.getBoundingClientRect().left - row.getBoundingClientRect().left)
    }))
  expect(lefts[1]).toBe(lefts[0])
})
