import { expect, test, type Page } from '@playwright/test'

/**
 * The page grammar, measured in the real engine.
 *
 * `Section` owns a page's rhythm — its label 8px over its card, 32px between
 * sections, the same 32px after the page's head — and a `SummaryList` is one
 * card of facts whose key, value and action columns line up across its rows
 * and fold, when narrow, into a key over its value. jsdom lays nothing out, so
 * the unit tests can only hold the classes that promise this; here the
 * numbers are read off the page, through the app's own cascade.
 */

const FILE = '~/work/storefront/.harnessdesk/agents/code-reviewer/AGENT.md'

const mount = async (page: Page, width: number) => {
  // Supply only the content; the components, buttons and cascade are real.
  await page.route('**/src/design/explorer/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from ['"]([^'"\n]*\/react\.js[^'"\n]*)['"]/.exec(source)?.[1]
    if (!reactUrl) throw new Error('explorer React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import fixtureReact from ${JSON.stringify(reactUrl)};
        import { Button, DetailHead, DetailMark, Note, PageHead, Row, Rows, Section, SummaryItem, SummaryList } from '/src/design/index.ts';
        document.getElementById('root').hidden = true;
        const frame = document.createElement('div');
        frame.setAttribute('data-testid', 'grammar');
        frame.style.cssText = 'width: ${width}px; margin: 24px; background: var(--hd-background)';
        document.body.append(frame);
        const h = fixtureReact.createElement;
        createRoot(frame).render(h('div', null,
          h(PageHead, { title: 'Permissions', blurb: 'Ceilings set the most a seat may do.' }),
          h(Section, { title: 'Agent', description: 'Read from its file.', 'data-testid': 'first' },
            h(SummaryList, { 'data-testid': 'summary' },
              h(SummaryItem, { label: 'File', kind: 'path', note: 'Comes first over the one that ships', action: h(Button, { size: 'sm', variant: 'secondary' }, 'Open file') }, ${JSON.stringify(FILE)}),
              h(SummaryItem, { label: 'Ceiling', note: 'May change files and commit in its own checkout, and never push.', action: h(Button, { size: 'sm', variant: 'secondary' }, 'Update…') }, 'Edit'),
              h(SummaryItem, { label: 'Seats', numeric: true }, '3'),
            ),
          ),
          h(Section, { title: 'Rules', action: h(Button, { size: 'sm', variant: 'outline' }, 'Add rule'), 'data-testid': 'second' },
            h(Rows, { 'data-testid': 'rows' }, h(Row, { title: 'Never push' })),
            h(Note, { 'data-testid': 'note' }, 'Requests it used to answer will reach you again.'),
            h(Button, { variant: 'secondary', 'data-testid': 'lone-button' }, 'Retry'),
          ),
          h('div', { style: { marginTop: '48px' } },
            h(DetailHead, { mark: h(DetailMark, null, 'C'), name: 'Code reviewer', owner: 'In storefront', blurb: 'Reads a change before anyone merges it.' }),
          ),
        ));
      `,
    })
  })
  await page.goto('/design.html')
  await expect(page.getByTestId('summary')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

const rect = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(node => node.getBoundingClientRect().toJSON() as DOMRect)

test('a Section owns its rhythm: 8px from label to card, 32px between sections and after the head', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const readings = await page.evaluate(() => {
    const box = (node: Element | null) => node!.getBoundingClientRect()
    const first = document.querySelector('[data-testid="first"]')!
    const second = document.querySelector('[data-testid="second"]')!
    const head = document.querySelector('[data-slot="page-title"]')!.closest('div')!.parentElement!
    const style = (node: Element) => getComputedStyle(node)
    const label = first.querySelector('[data-slot="group-label"]')!
    return {
      afterHead: Math.round(box(first).top - box(head).bottom),
      headToCard: Math.round(box(first.querySelector('[data-slot="summary-list"]')).top - box(first.querySelector('[data-slot="section-head"]')).bottom),
      betweenSections: Math.round(box(second).top - box(first).bottom),
      secondHeadToCard: Math.round(box(second.querySelector('[data-testid="rows"]')).top - box(second.querySelector('[data-slot="section-head"]')).bottom),
      // The label sits on its card even when an action beside it is taller.
      labelToCard: Math.round(box(second.querySelector('[data-testid="rows"]')).top - box(second.querySelector('[data-slot="group-label"]')).bottom),
      rowsMargin: style(second.querySelector('[data-testid="rows"]')!).marginBottom,
      noteMargin: `${style(second.querySelector('[data-testid="note"]')!).marginTop} ${style(second.querySelector('[data-testid="note"]')!).marginBottom}`,
      buttonWidth: Math.round(box(second.querySelector('[data-testid="lone-button"]')).width),
      sectionWidth: Math.round(box(second).width),
      label: { size: style(label).fontSize, weight: style(label).fontWeight, transform: style(label).textTransform },
    }
  })
  expect(readings.afterHead).toBe(32)
  expect(readings.headToCard).toBe(8)
  expect(readings.betweenSections).toBe(32)
  expect(readings.secondHeadToCard).toBe(8)
  expect(readings.labelToCard).toBe(8)
  expect(readings.rowsMargin).toBe('0px')
  expect(readings.noteMargin).toBe('0px 0px')
  expect(readings.buttonWidth).toBeLessThan(readings.sectionWidth / 2)
  expect(readings.label).toEqual({ size: '13px', weight: '400', transform: 'none' })
  await page.getByTestId('grammar').screenshot({ path: test.info().outputPath('page-grammar.png') })
})

test('a detail head names its page in the page title type', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const type = (selector: string) => page.locator(selector).first().evaluate(node => {
    const style = getComputedStyle(node)
    return `${style.fontSize}/${style.lineHeight} ${style.fontWeight} ${style.letterSpacing}`
  })
  expect(await type('[class*="detailName"]')).toBe(await type('[data-slot="page-title"]'))
  expect(await type('[data-slot="page-title"]')).toMatch(/^20px\/28px 600 /)
})

test('a SummaryList lines its key, value and action columns up across rows', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="summary"] [data-slot="summary-item"]')].map(item => {
    const box = (node: Element | null) => node?.getBoundingClientRect() ?? null
    const card = item.closest('dl')!.getBoundingClientRect()
    const key = box(item.querySelector('dt'))!
    const value = box(item.querySelector('[data-slot="summary-value"]'))!
    const action = box(item.querySelector('[data-slot="summary-action"] button'))
    const inner = item.getBoundingClientRect().right - parseFloat(getComputedStyle(item).paddingRight)
    return {
      keyLeft: Math.round(key.left - card.left),
      valueLeft: Math.round(value.left - card.left),
      keyTop: Math.round(key.top),
      valueTop: Math.round(value.top),
      actionEnd: action ? Math.round(inner - action.right) : null,
      valueEnd: Math.round(inner - value.right),
      overflow: item.scrollWidth - item.clientWidth,
      height: Math.round(item.getBoundingClientRect().height),
      align: getComputedStyle(item.querySelector('[data-slot="summary-value"]')!).textAlign,
    }
  }))
  expect(rows).toHaveLength(3)
  // One key column and one value column for the whole card.
  expect(new Set(rows.map(row => row.keyLeft)).size).toBe(1)
  expect(new Set(rows.map(row => row.valueLeft)).size).toBe(1)
  expect(rows[0]!.valueLeft).toBeGreaterThan(rows[0]!.keyLeft + 60)
  for (const row of rows) {
    // The key sits on the value's first line, and nothing runs past the card.
    expect(row.keyTop).toBe(row.valueTop)
    expect(row.overflow).toBeLessThanOrEqual(0)
  }
  // The actions keep the row's end.
  expect(rows[0]!.actionEnd).toBe(0)
  expect(rows[1]!.actionEnd).toBe(0)
  // A row with no action stands as tall as one with an action and no note.
  expect(rows[2]!.height).toBeGreaterThanOrEqual(52)
  expect(rows[2]!.align).toBe('right')
  // A figure with no action of its own lines up with the actions' ends.
  expect(rows[2]!.valueEnd).toBe(0)
  expect(rows[0]!.align).toBe('left')
  // The path gave up its middle rather than its file name.
  await expect(page.locator('[data-testid="summary"] [data-part="tail"]').first()).toHaveText('/AGENT.md')
})

test('a narrow SummaryList puts each key over its value, and keeps the action at the row end', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await mount(page, 360)
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="summary"] [data-slot="summary-item"]')].map(item => {
    const key = item.querySelector('dt')!.getBoundingClientRect()
    const value = item.querySelector('[data-slot="summary-value"]')!.getBoundingClientRect()
    const action = item.querySelector('[data-slot="summary-action"] button')?.getBoundingClientRect() ?? null
    const inner = item.getBoundingClientRect().right - parseFloat(getComputedStyle(item).paddingRight)
    const left = item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft)
    return {
      keyAbove: key.bottom <= value.top + 1,
      valueStart: Math.round(value.left - left),
      actionEnd: action ? Math.round(inner - action.right) : null,
      actionBesideValue: action ? action.top < value.bottom && action.bottom > value.top : null,
      overflow: item.scrollWidth - item.clientWidth,
    }
  }))
  for (const row of rows) {
    expect(row.keyAbove).toBe(true)
    expect(row.valueStart).toBe(0)
    expect(row.overflow).toBeLessThanOrEqual(0)
  }
  expect(rows[0]!.actionEnd).toBe(0)
  expect(rows[0]!.actionBesideValue).toBe(true)
  await page.getByTestId('grammar').screenshot({ path: test.info().outputPath('page-grammar-narrow.png') })
})

test('the rhythm holds in the dark theme too', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  await page.evaluate(() => document.body.toggleAttribute('data-hd-dark-theme', true))
  const first = await rect(page, '[data-testid="first"]')
  const second = await rect(page, '[data-testid="second"]')
  expect(Math.round(second.top - first.bottom)).toBe(32)
  await page.getByTestId('grammar').screenshot({ path: test.info().outputPath('page-grammar-dark.png') })
})
