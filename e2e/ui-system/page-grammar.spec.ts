import { expect, test, type Page } from '@playwright/test'

/**
 * The page grammar, measured in the real engine.
 *
 * `Section` owns a page's rhythm — its label 12px over its card, 32px between
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
        import { Button, Chip, IconTile, Note, Page, PageExplanation, TopBar, Row, Rows, Section, SectionHead, SummaryItem, SummaryList } from '/src/design/index.ts';
        document.getElementById('root').hidden = true;
        const frame = document.createElement('div');
        frame.setAttribute('data-testid', 'grammar');
        frame.style.cssText = 'width: ${width}px; margin: 24px; background: var(--hd-background)';
        document.body.append(frame);
        const h = fixtureReact.createElement;
        createRoot(frame).render(h('div', null,
          h(TopBar, { place: 'Permissions', more: () => null }),
          h(PageExplanation, null, 'Ceilings set the most a seat may do.'),
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
          h('div', { style: { marginTop: '412px' } },
            h(TopBar, { mark: h(IconTile, {size: 'sm'}, 'C'), place: 'Code reviewer', parents: [{label: 'storefront', run: () => {}}], more: () => null }),
          ),
          h('div', { style: { marginTop: '412px' }, 'data-testid': 'goal-head' },
            h(TopBar, { place: 'Make checkout retries survive a gateway restart without charging twice', state: h(Chip, { tone: 'warning' }, 'Needs you'), more: () => null }),
          ),
          h('div', { style: { marginTop: '412px' }, 'data-testid': 'path-head' },
            h(TopBar, { place: 'Checkout payments and retries', parents: [{label: '~/work/storefront/packages/checkout-service/src/payments/retry/gateway', run: () => {}}], more: () => null }),
          ),
          h(Section, { title: 'Triggers', action: h(Button, { size: 'sm', variant: 'outline' }, 'New trigger…'), 'data-testid': 'note-first' },
            // ProjectTriggers.tsx's own shape: a Note, not a Rows card, is
            // the body's first (and only) child.
            h(Note, null, 'Read from the committed file. Nothing here runs until you arm it on this machine.'),
          ),
          h(Section, { title: 'Approvals', description: 'What a new session starts with.', 'data-testid': 'approvals' },
            h(SectionHead, { level: 'label', name: 'Alpha' }),
            h(Rows, { 'data-testid': 'alpha' }, h(Row, { title: 'Sandbox' })),
            h(SectionHead, { level: 'label', name: 'Beta' }),
            h(Rows, { 'data-testid': 'beta' }, h(Row, { title: 'Decided when a session starts' })),
          ),
          h(Page, { width: 'reading', gutter: 'none', 'data-testid': 'app-page' },
            h(Rows, { 'data-testid': 'legacy-above' }, h(Row, { title: 'Everything stays on this Mac' })),
            h(SectionHead, { level: 'label', name: 'Backup', action: h(Button, { size: 'sm', variant: 'outline' }, 'Export…') }),
            h(Rows, { 'data-testid': 'legacy-card' }, h(Row, { title: 'Back up this Mac' })),
            h(Section, { title: 'Support', 'data-testid': 'app-section' }, h(Rows, null, h(Row, { title: 'Diagnostics' }))),
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

test('a Section owns its rhythm: 12px from label to card, 32px between sections and after the head', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const readings = await page.evaluate(() => {
    const box = (node: Element | null) => node!.getBoundingClientRect()
    const first = document.querySelector('[data-testid="first"]')!
    const second = document.querySelector('[data-testid="second"]')!
    const head = document.querySelector('[data-slot="top-bar"]')!.closest('header')!.nextElementSibling!
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
  expect(readings.headToCard).toBe(12)
  expect(readings.betweenSections).toBe(32)
  expect(readings.secondHeadToCard).toBe(12)
  expect(readings.labelToCard).toBe(12)
  expect(readings.rowsMargin).toBe('0px')
  expect(readings.noteMargin).toBe('0px 0px')
  expect(readings.buttonWidth).toBeLessThan(readings.sectionWidth / 2)
  expect(readings.label).toEqual({ size: '13px', weight: '400', transform: 'none' })
  await page.getByTestId('grammar').screenshot({ path: test.info().outputPath('page-grammar.png') })
})

test('page and detail names share the fixed bar type and height', async ({ page }) => {
  await mount(page, 640)
  const readings = await page.locator('[data-topbar-title] > [data-slot="text"]').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node)
    return { type: `${style.fontSize}/${style.lineHeight} ${style.fontWeight}`, height: node.closest('header')!.getBoundingClientRect().height }
  }))
  expect(readings).toHaveLength(4)
  expect(new Set(readings.map(one => one.type))).toEqual(new Set(['14px/20px 400']))
  for (const one of readings) expect(one.height).toBe(40)
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

/* The fixed bar keeps a state whole where it fits, then folds the state
   before the name loses its minimum room. It never grows a second line. */
for (const width of [720, 420]) {
  test(`a long destination name keeps a whole state or folds it at ${width}px`, async ({ page }) => {
    await mount(page, width)
    const head = page.getByTestId('goal-head')
    const reading = await head.evaluate(node => {
      const title = node.querySelector('[data-topbar-title] > [data-slot="text"]')!
      const chip = node.querySelector('[data-slot="chip-words"]')
      return { height: node.querySelector('header')!.getBoundingClientRect().height,
        lines: title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight),
        overflow: node.scrollWidth - node.clientWidth,
        cut: chip ? chip.scrollWidth > chip.clientWidth + 1 : false }
    })
    expect(reading.height).toBe(40)
    expect(reading.lines).toBe(1)
    expect(reading.cut).toBe(false)
    expect(reading.overflow).toBeLessThanOrEqual(0)
    await head.screenshot({ path: test.info().outputPath(`goal-head-${width}.png`) })
  })
}

test('a long parent path keeps the destination readable and its full name available', async ({ page }) => {
  await mount(page, 720)
  const head = page.getByTestId('path-head')
  await expect(head.locator('[data-topbar-title]')).toContainText('Checkout payments and retries')
  await head.getByRole('button', { name: 'More', exact: true }).click()
  const parent = page.getByRole('menuitem', { name: '~/work/storefront/packages/checkout-service/src/payments/retry/gateway', exact: true })
  await expect(parent).toBeVisible()
  expect(await head.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0)
  expect(await head.locator('header').evaluate(node => node.getBoundingClientRect().height)).toBe(40)
})

test('section and subgroup headings retain their semantic outline beside the fixed bars', async ({ page }) => {
  await mount(page, 640)
  const tags = await page.getByTestId('grammar').evaluate(node => ({
    sectionLabels: [...node.querySelectorAll('section[data-variant="page"] > [data-slot="section-head"] [data-slot="group-label"]')].map(one => one.tagName),
    groupLabels: [...node.querySelectorAll('section[data-variant="page"] [data-section-head] [data-slot="section-name"]')].map(one => one.tagName),
    pageLabels: [...node.querySelectorAll('[data-testid="app-page"] > [data-section-head] [data-slot="section-name"]')].map(one => one.tagName),
  }))
  expect(tags.sectionLabels.length).toBeGreaterThan(0)
  expect(new Set(tags.sectionLabels)).toEqual(new Set(['H2']))
  expect(tags.groupLabels).toEqual(['H3', 'H3'])
  expect(tags.pageLabels).toEqual(['H2'])
})

/* Inside a Section, a SectionHead is a sub-head: 24px above it, 12px to its
   card — tighter than the 32px between sections, so Permissions' runtimes
   read as groups of Approvals. */
test('a section head inside a Section is a sub-head a step tighter than a section', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const gaps = await page.getByTestId('approvals').evaluate(node => {
    const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect()
    const [alpha, beta] = [...node.querySelectorAll('[data-section-head]')].map(one => one.getBoundingClientRect())
    const betaLabel = node.querySelectorAll('[data-section-head] [data-slot="section-name"]')[1]!.getBoundingClientRect()
    return {
      aboveFirst: Math.round(alpha!.top - box('[data-slot="section-head"]').bottom),
      betweenGroups: Math.round(beta!.top - box('[data-testid="alpha"]').bottom),
      labelToCard: Math.round(box('[data-testid="beta"]').top - betaLabel.bottom),
    }
  })
  expect(gaps).toEqual({ aboveFirst: 24, betweenGroups: 24, labelToCard: 12 })
})

/* On an app-window page a SectionHead keeps the Section rhythm: 32px from the
   card above, and its label 12px over its own card even with an action beside
   it — the same two numbers a Section gives. */
test('on a page a section head sits 32px under the card above and 12px over its own', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const gaps = await page.getByTestId('app-page').evaluate(node => {
    const box = (selector: string) => node.querySelector(selector)!.getBoundingClientRect()
    return {
      headMargin: getComputedStyle(node.querySelector('[data-section-head]')!).marginTop,
      aboveHead: Math.round(box('[data-section-head]').top - box('[data-testid="legacy-above"]').bottom),
      labelToCard: Math.round(box('[data-testid="legacy-card"]').top - box('[data-section-head] [data-slot="section-name"]').bottom),
      sectionLabelToCard: Math.round(box('[data-testid="app-section"] [data-slot="section-head"] ~ *').top - box('[data-testid="app-section"] [data-slot="group-label"]').bottom),
      aboveSection: Math.round(box('[data-testid="app-section"]').top - box('[data-testid="legacy-card"]').bottom),
    }
  })
  expect(gaps).toEqual({ headMargin: '16px', aboveHead: 32, labelToCard: 12, sectionLabelToCard: 12, aboveSection: 32 })
})

test('section furniture keeps the page edge while each body owns its inset', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  const offsets = await page.evaluate(() => {
    const rowsSection = document.querySelector('[data-testid="second"]')!
    const noteSection = document.querySelector('[data-testid="note-first"]')!
    return {
      // The body owns its row inset; page furniture stays on the page edge.
      rows: Math.round(
        rowsSection.querySelector('[data-slot="group-label"]')!.getBoundingClientRect().left -
        rowsSection.getBoundingClientRect().left,
      ),
      // A body that is a Note, not a Rows card: nothing to answer to, so
      // the head sits flush with the section's own edge, the same column
      // the Note itself starts on.
      note: Math.round(
        noteSection.querySelector('[data-slot="group-label"]')!.getBoundingClientRect().left -
        noteSection.getBoundingClientRect().left,
      ),
    }
  })
  expect(offsets.rows, 'the page heading keeps its own edge').toBeLessThanOrEqual(1)
  expect(offsets.note, 'the Note-bodied head should sit flush, not 17px in').toBeLessThanOrEqual(1)
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
