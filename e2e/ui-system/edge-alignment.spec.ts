import { expect, test, type Page } from '@playwright/test'

/**
 * The spacing/alignment system holds four claims a screenshot cannot check
 * reliably but a rectangle's edges can: a `SectionHead` starts its label on
 * the same column as the card of rows it names, a settings row's mark and
 * trailing control land on the title's own line rather than the row's whole
 * block, a `Banner`'s icon and dismiss centre on the title's first line, and
 * a `Button`'s `edge="end"` pulls an icon-sized box far enough past the
 * inset that the glyph inside it — not the box — sits on the column.
 *
 * Mounted directly, the way `row-box.spec.ts` does: jsdom lays nothing out
 * and compiles no Tailwind, so none of these four defects is visible there,
 * and the census that found them ran against the real engine for the same
 * reason.
 */

const mount = async (page: Page) => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import edgeReact from ${JSON.stringify(reactUrl)};
        import { Section, SectionBody } from '/src/design/ui/section.tsx';
        import { Rows, Row, RowValue } from '/src/design/patterns/Settings.tsx';
        import { Switch } from '/src/design/ui/switch.tsx';
        import { Banner } from '/src/design/primitives/Banner.tsx';
        import { Button } from '/src/design/ui/button.tsx';
        const h = edgeReact.createElement;
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Edge fixture');
        frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;background:var(--hd-background);padding:16px;width:520px;box-sizing:border-box;display:flex;flex-direction:column;gap:24px';
        document.body.append(frame);
        createRoot(frame).render(h('div', null,
          h(Section, { title: 'Backup', description: 'What this section is for.', action: h(Button, { size: 'sm', variant: 'outline' }, 'Export…'), 'data-testid': 'section-fixture' },
            h(Rows, { 'data-testid': 'rows-fixture' },
              h(Row, { title: 'Back up this Mac', desc: 'Everything lives in a single file.', control: h(Button, { size: 'sm', variant: 'outline' }, 'Export…') }),
              h(Row, { title: 'One line', control: h(Switch, { checked: true }) }),
            ),
          ),
          h('div', { 'data-testid': 'banner-fixture' },
            h(Banner, { tone: 'warning', title: 'A newer build is available', onDismiss: () => {} }, 'The description runs long enough to wrap onto a second line under the title, which is exactly the case that used to leave the icon and the dismiss centred low.'),
          ),
          h('div', { 'data-testid': 'edge-fixture', style: { display: 'flex', alignItems: 'center', border: '1px solid #ccc', padding: '0 16px', width: '200px' } },
            h('span', { style: { flex: 1 } }, 'A row'),
            h(Button, { variant: 'ghost', size: 'icon-sm', edge: 'end' }, h('svg', { viewBox: '0 0 16 16', width: 16, height: 16 }, h('rect', { x: 0, y: 0, width: 16, height: 16 }))),
          ),
        ));
      `,
    })
  })
  await page.goto('/preview.html')
  await expect(page.getByRole('region', { name: 'Edge fixture' })).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
}

test.describe('the layout system holds its own claims', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await mount(page)
  })

  test('a SectionHead starts its label on the same column as the rows it names', async ({ page }) => {
    const lefts = await page.evaluate(() => {
      const section = document.querySelector('[data-testid="section-fixture"]') as HTMLElement
      const label = section.querySelector('h2') as HTMLElement
      const row = document.querySelector('[data-testid="rows-fixture"] [class*="row"]') as HTMLElement
      const rowTitle = row.querySelector('[class*="rowTitle"]') as HTMLElement
      return {
        label: Math.round(label.getBoundingClientRect().left),
        row: Math.round(rowTitle.getBoundingClientRect().left),
      }
    })
    expect(Math.abs(lefts.label - lefts.row), `label ${lefts.label} vs row ${lefts.row}`).toBeLessThanOrEqual(1)
  })

  test('a section action ends on the same column a row\'s own control does', async ({ page }) => {
    const rights = await page.evaluate(() => {
      const section = document.querySelector('[data-testid="section-fixture"]') as HTMLElement
      const action = section.querySelector('[data-slot="section-action"]') as HTMLElement
      // The card's outer border sits further out than any row's own content —
      // a row keeps the card's inset on its trailing edge too — so the
      // column the action has to answer to is a row's control, not the box.
      const control = document.querySelector('[data-testid="rows-fixture"] [class*="rowCtl"]') as HTMLElement
      return {
        action: Math.round(action.getBoundingClientRect().right),
        control: Math.round(control.getBoundingClientRect().right),
      }
    })
    expect(Math.abs(rights.action - rights.control), `action ${rights.action} vs row control ${rights.control}`).toBeLessThanOrEqual(1)
  })

  test('a row with a description keeps its trailing control on the title\'s first line, not the block', async ({ page }) => {
    const reading = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="rows-fixture"] [class*="row"]:has([class*="rowDesc"])') as HTMLElement
      const title = row.querySelector('[class*="rowTitle"]') as HTMLElement
      const control = row.querySelector('[class*="rowCtl"]') as HTMLElement
      const t = title.getBoundingClientRect()
      const c = control.getBoundingClientRect()
      return { titleCenter: (t.top + t.bottom) / 2, controlTop: c.top, controlBottom: c.bottom }
    })
    // The control's own box may be taller than the title's line — a button is
    // — so the claim is that the title's line falls inside the control's box
    // near its top, not that the two share a centre.
    expect(reading.titleCenter).toBeGreaterThanOrEqual(reading.controlTop - 1)
    expect(reading.controlTop).toBeLessThanOrEqual(reading.titleCenter)
  })

  test('a banner\'s icon and dismiss centre on the title\'s first line', async ({ page }) => {
    const reading = await page.evaluate(() => {
      const banner = document.querySelector('[data-testid="banner-fixture"]') as HTMLElement
      // Not `[class*="title"]`: the alert root's own class list carries the
      // literal text `[&_[data-slot=alert-title]]:…` from its Tailwind
      // arbitrary-variant selector, which contains the substring "title" and
      // matches first, in tree order, ahead of the title element itself.
      const title = banner.querySelector('[data-slot="alert-title"]') as HTMLElement
      const icon = banner.querySelector('[data-slot="alert"] > span > svg') as HTMLElement
      const dismiss = banner.querySelector('button[aria-label="Dismiss"]') as HTMLElement
      const t = title.getBoundingClientRect()
      const i = icon.getBoundingClientRect()
      const d = dismiss.getBoundingClientRect()
      return {
        titleCenter: (t.top + t.bottom) / 2,
        iconCenter: (i.top + i.bottom) / 2,
        dismissCenter: (d.top + d.bottom) / 2,
      }
    })
    expect(Math.abs(reading.iconCenter - reading.titleCenter), 'icon off the title line').toBeLessThanOrEqual(1.5)
    expect(Math.abs(reading.dismissCenter - reading.titleCenter), 'dismiss off the title line').toBeLessThanOrEqual(1.5)
  })

  test('edge="end" lands the glyph, not the box, on the row\'s inset', async ({ page }) => {
    const reading = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="edge-fixture"]') as HTMLElement
      const button = row.querySelector('button') as HTMLElement
      const glyph = button.querySelector('svg') as SVGElement
      const inner = row.getBoundingClientRect().right - parseFloat(getComputedStyle(row).paddingRight)
      return { glyphRight: glyph.getBoundingClientRect().right, inner }
    })
    expect(Math.abs(reading.glyphRight - reading.inner), `glyph ${reading.glyphRight} vs column ${reading.inner}`).toBeLessThanOrEqual(1)
  })
})
