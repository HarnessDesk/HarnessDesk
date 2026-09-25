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
 * The second half is the narrow row (#885): a control that holds a sentence
 * used to keep its whole width and squeeze the title to one letter per line.
 * The title keeps a readable width now, and the control drops under it when
 * the two cannot share a line.
 *
 * Measured in the real engine, because jsdom lays nothing out and compiles no
 * utilities, so neither defect can be seen there.
 */

const SENTENCE = 'Runs after every round, and stops the flow when a reviewer asks for changes twice in a row.'

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
          h(Rows, { 'data-testid': 'rowfx-narrow' },
            h(Row, { 'data-testid': 'rowfx-sentence', title: 'Round one', control: h(RowValue, null, ${JSON.stringify(SENTENCE)}) }),
            h(RowButton, { 'data-testid': 'rowfx-sentence-button', title: 'Round two', control: h(RowValue, null, ${JSON.stringify(SENTENCE)}), onClick: () => {} }),
            h(Row, { 'data-testid': 'rowfx-short', title: 'Round three', control: h(RowValue, null, 'Twice') }),
            h(RowButton, { 'data-testid': 'rowfx-medium', title: 'Checkout hardening', desc: 'Goal', control: h(RowValue, null, '$12.34 · 3 seats'), onClick: () => {} }),
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

/**
 * Where a row button's chevron sits: on its control's line, and how far its
 * right edge is from the row's content edge (the padding's inner side).
 */
const chevronOf = (page: Page, id: string) => page.evaluate(id => {
  const row = document.querySelector(`[data-testid="rowfx-${id}"]`) as HTMLElement
  const c = row.querySelector('[class*="rowCtl"]')!.getBoundingClientRect()
  const v = row.querySelector('[class*="rowChev"]')!.getBoundingClientRect()
  const inner = row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight)
  return { sameLine: v.top < c.bottom && v.bottom > c.top, end: Math.round(inner - v.right) }
}, id)

test('a sentence in a narrow row wraps under a title that keeps its words', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await mount(page, 400)
  const readings = await page.evaluate(() => ['sentence', 'sentence-button', 'short'].map(id => {
    const row = document.querySelector(`[data-testid="rowfx-${id}"]`) as HTMLElement
    const title = row.querySelector('[class*="rowTitle"]') as HTMLElement
    const control = row.querySelector('[class*="rowCtl"]') as HTMLElement
    const line = parseFloat(getComputedStyle(title).lineHeight)
    const t = title.getBoundingClientRect(), c = control.getBoundingClientRect(), r = row.getBoundingClientRect()
    return {
      id,
      titleLines: Math.round(t.height / line),
      controlBelow: c.top >= t.bottom - 1,
      controlInside: c.left >= r.left - 1 && c.right <= r.right + 1,
      overflow: row.scrollWidth - row.clientWidth,
    }
  }))
  for (const reading of readings) {
    expect(reading.titleLines, `${reading.id}: the title broke over lines`).toBe(1)
    expect(reading.controlInside, `${reading.id}: the control left the row`).toBe(true)
    expect(reading.overflow, `${reading.id}: the row overflows`).toBeLessThanOrEqual(0)
  }
  // A row button's chevron stays on the control's line, at the row's end.
  const chevron = await chevronOf(page, 'sentence-button')
  expect(chevron.sameLine).toBe(true)
  expect(Math.abs(chevron.end), 'the chevron left the row end').toBeLessThanOrEqual(1)
  await page.getByRole('region', { name: 'Row fixture' }).screenshot({ path: test.info().outputPath('narrow-rows.png') })
  // The sentence drops under its title; a word stays on the title's line.
  expect(readings.find(r => r.id === 'sentence')?.controlBelow).toBe(true)
  expect(readings.find(r => r.id === 'sentence-button')?.controlBelow).toBe(true)
  expect(readings.find(r => r.id === 'short')?.controlBelow).toBe(false)
})

test('at a normal width a short control keeps its place beside the title', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 })
  await mount(page, 720)
  const same = await page.evaluate(() => {
    const row = document.querySelector('[data-testid="rowfx-short"]') as HTMLElement
    const title = row.querySelector('[class*="rowTitle"]')!.getBoundingClientRect()
    const control = row.querySelector('[class*="rowCtl"]')!.getBoundingClientRect()
    return { row: Math.round(row.getBoundingClientRect().right), control: Math.round(control.right), below: control.top >= title.bottom - 1 }
  })
  expect(same.below).toBe(false)
  // The control still ends at the row's inset, not wherever the words stop.
  expect(same.row - same.control).toBeGreaterThan(0)
  expect(same.row - same.control).toBeLessThan(40)
})

/*
 * A control of a few words — a cost, a count — meets the title's floor at some
 * width in every card. Across that band the control and the chevron wrap as
 * one: both stay on one line, and the chevron stays at the row's end, whether
 * they sit beside the title or under it.
 */
test('a medium control and its chevron wrap together and keep the row end', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await mount(page, 380)
  const frame = page.getByRole('region', { name: 'Row fixture' })
  const faults: string[] = []
  for (let width = 300; width <= 380; width += 10) {
    await frame.evaluate((node, width) => { (node as HTMLElement).style.width = `${width}px` }, width)
    const chevron = await chevronOf(page, 'medium')
    const titleLines = await page.evaluate(() => {
      const title = document.querySelector('[data-testid="rowfx-medium"] [class*="rowTitle"]') as HTMLElement
      return Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight))
    })
    if (!chevron.sameLine) faults.push(`${width}px: the chevron left its control's line`)
    if (Math.abs(chevron.end) > 1) faults.push(`${width}px: the chevron sits ${chevron.end}px from the row end`)
    if (titleLines !== 1) faults.push(`${width}px: the title broke over ${titleLines} lines`)
  }
  expect(faults.join('\n') || 'the chevron holds the row end').toBe('the chevron holds the row end')
})
