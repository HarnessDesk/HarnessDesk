import { expect, test, type Page } from '@playwright/test'

/**
 * The page grammar, measured in the real engine.
 *
 * `Section` owns a page's rhythm — its label 8px over its card, 32px between
 * sections, the same 32px after the page's head. jsdom lays nothing out, so
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
        import { Button, DetailHead, DetailMark, Note, PageHead, Row, Rows, Section } from '/src/design/index.ts';
        document.getElementById('root').hidden = true;
        const frame = document.createElement('div');
        frame.setAttribute('data-testid', 'grammar');
        frame.style.cssText = 'width: ${width}px; margin: 24px; background: var(--hd-background)';
        document.body.append(frame);
        const h = fixtureReact.createElement;
        createRoot(frame).render(h('div', null,
          h(PageHead, { title: 'Permissions', blurb: 'Ceilings set the most a seat may do.' }),
          h(Section, { title: 'Agent', description: 'Read from its file.', 'data-testid': 'first' },
            h(Rows, { 'data-testid': 'summary' }, h(Row, { title: 'AGENT.md', desc: 'Comes first over the one that ships' })),
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
      headToCard: Math.round(box(first.querySelector('[data-testid="summary"]')).top - box(first.querySelector('[data-slot="section-head"]')).bottom),
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

test('the rhythm holds in the dark theme too', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await mount(page, 640)
  await page.evaluate(() => document.body.toggleAttribute('data-hd-dark-theme', true))
  const first = await rect(page, '[data-testid="first"]')
  const second = await rect(page, '[data-testid="second"]')
  expect(Math.round(second.top - first.bottom)).toBe(32)
  await page.getByTestId('grammar').screenshot({ path: test.info().outputPath('page-grammar-dark.png') })
})
