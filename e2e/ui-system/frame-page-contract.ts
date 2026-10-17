import { expect, type Locator, type Page } from '@playwright/test'
import { installFramePreviewFixture } from './frame-preview-fixture'
import { FRAME } from '../../packages/ui/src/design/frame'
import { applyPageFrameActions, type PageFrameActions } from './frame-page-actions'
import { pageChoiceFor } from './frame-actions'
export const expectSettingsChrome = async (page: Page, width: number): Promise<void> => {
  const bar = page.locator('[data-slot="top-bar"]:visible')
  await expect(bar).toHaveCount(1)
  await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
  await expect(page.locator('[data-page-destination="settings"]:visible h1')).toHaveText(/\S/)
  await expect(bar.locator('..')).toHaveJSProperty('clientHeight', FRAME.bar.height)
  if (width >= FRAME.fold.sidebarFloats) {
    await expect(bar.locator('[data-topbar="lead"] button')).toHaveCount(0)
    const top = page.locator('[data-left-top]:visible')
    await expect(top).toBeVisible()
    expect((await top.boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(top.locator('button:visible')).toHaveCount(1)
    await expect(top.locator('button:visible')).toHaveAccessibleName(/^(Hide|Show) sidebar$/)
    await expect(top.locator('[data-left-history], [aria-label="Search everything"]')).toHaveCount(0)
  } else {
    await expect(bar.locator('[data-topbar="lead"] button')).toHaveCount(1)
    await expect(bar.locator('[data-topbar="lead"] button')).toHaveAccessibleName('Show sidebar')
  }
  await expect(bar.locator('[data-topbar="place"] button')).toHaveCount(0)
  await expect(bar.getByRole('button', { name: 'Search everything', exact: true })).toHaveCount(0)
  await expect(bar.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
  await expect(bar.getByRole('button', { name: 'Forward', exact: true })).toHaveCount(0)
}
/**
 * The title of a page that opens with it centres in a bar-tall row at the
 * body's top, and, while the sidebar shows, its top is the wordmark's top.
 */
export const expectTitleOnWordmarkLine = async (page: Page, column: Locator): Promise<void> => {
  const title = column.locator('[data-page-head] h1').first()
  const head = column.locator('[data-page-head]').first()
  const [titleBox, headBox, columnBox] = [(await title.boundingBox())!, (await head.boundingBox())!, (await column.boundingBox())!]
  expect(headBox.height, 'the title row is one bar tall').toBeGreaterThanOrEqual(FRAME.bar.height)
  expect(Math.abs(headBox.y - columnBox.y), 'the title row starts at the body top').toBeLessThanOrEqual(1)
  expect(Math.abs(titleBox.y + titleBox.height / 2 - (headBox.y + headBox.height / 2)), 'the title centres in its row').toBeLessThanOrEqual(1)
  const wordmark = page.locator('[data-left-brand] [data-role="wordmark"]:visible')
  if (await wordmark.count()) {
    const mark = (await wordmark.first().boundingBox())!
    expect(Math.abs(titleBox.y - mark.y), 'the title stands on the wordmark line').toBeLessThanOrEqual(0.5)
    expect(titleBox.height).toBeCloseTo(mark.height, 0)
  }
}
export const measureDestination = async (page: Page, query: string, widthKind: 'reading' | 'wide' | 'canvas', theme: 'light' | 'dark', width: number, actions: PageFrameActions = {}): Promise<void> => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(() => document.fonts.ready)
  await applyPageFrameActions(page, actions)
  const params = new URLSearchParams(query)
  const settings = params.get('frame-wall') === 'settings' && params.get('frame-section') !== 'library'
  const bar = page.locator('[data-slot="top-bar"]:visible')
  if (settings) await expectSettingsChrome(page, width)
  else {
    await expect(bar).toHaveCount(1)
    expect((await bar.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(0)
    await expect(bar.locator('[data-topbar="view"] button')).toHaveCount(0)
    const more = bar.locator('[data-topbar="more"] button')
    if (actions.more === 'absent') await expect(more).toHaveCount(0)
    else await expect(more).toBeVisible()
    await expect(bar.locator('[data-topbar-title]')).toHaveCount(0)
    if (actions.more !== 'absent') {
      const moreBox = (await more.boundingBox())!
      expect(Math.abs(moreBox.x + moreBox.width - (width - FRAME.bar.pad))).toBeLessThanOrEqual(1)
    }
  }
  const leftTop = page.locator('[data-left-top]:visible')
  if (!settings && await leftTop.count()) {
    const topBox = (await leftTop.boundingBox())!, barBox = (await bar.locator('..').boundingBox())!
    expect(topBox.height).toBe(FRAME.bar.height)
    expect(Math.abs(topBox.y + topBox.height - barBox.y - barBox.height)).toBeLessThanOrEqual(1)
  }
  const column = page.locator(`[data-page-destination]:visible [data-slot="page"][data-width="${widthKind}"]`).first()
  await expect(column).toBeVisible()
  if (widthKind !== 'canvas') {
    const title = column.getByRole('heading', { level: 1 })
    await expect(title).toHaveCount(1)
    await expect(title).toHaveAttribute('data-role', 'page')
    const edge = await column.evaluate(node => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft))
    expect((await title.boundingBox())!.x, 'the content column anchors the page title').toBeCloseTo(edge, 1)
  }
  const value = await column.evaluate(element => {
    const css = getComputedStyle(element), box = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    const left = parseFloat(css.paddingLeft), right = parseFloat(css.paddingRight)
    const contentLeft=box.left+left,contentRight=box.right-right
    return { width: box.width - left - right, available: parent.width, left, right,
      top: parseFloat(css.paddingTop), centre: (box.left + box.right) / 2 - (parent.left + parent.right) / 2,
      edges: [...element.children].filter(child => getComputedStyle(child).display !== 'none' && child.getClientRects().length > 0)
        .map(child => {
          const childBox=child.getBoundingClientRect()
          return {offset:childBox.left-contentLeft,empty:child.matches('[data-slot="empty-state"]'),centre:(childBox.left+childBox.right)/2-(contentLeft+contentRight)/2}
        }) }
  })
  const gutter = widthKind === 'canvas' ? FRAME.page.canvasGutter : FRAME.page.gutter
  // A page that opens with its title starts at the body's top, its title row
  // one bar tall, so the title stands on the sidebar wordmark's line
  // (docs/decisions.md, "A page title stands on the wordmark's line").
  const opensWithTitle = await column.evaluate(node => {
    const lead = (element: Element | null) => element?.matches('[data-slot="page-options"]') && !!element.querySelector(':scope > [data-page-head]')
    const first = node.firstElementChild
    return !!lead(first) || !!lead(first?.firstElementChild ?? null)
  })
  const topInset = opensWithTitle ? 0
    : actions.expectedTopInset === 'page' ? FRAME.page.gutter - FRAME.page.canvasGutter + 1
    : gutter
  expect([value.left, value.right, value.top]).toEqual([gutter, gutter, topInset])
  if (opensWithTitle) await expectTitleOnWordmarkLine(page, column)
  const expected = widthKind === 'canvas' ? value.available - 2 * gutter
    : Math.min(FRAME.page[widthKind], value.available - 2 * gutter)
  expect(value.width).toBeCloseTo(expected, 0)
  expect(Math.abs(value.centre)).toBeLessThanOrEqual(1)
  expect(value.edges.length).toBeGreaterThan(0)
  for (const edge of value.edges) {
    if (edge.empty) expect(Math.abs(edge.centre), 'an empty state is centred in the page column').toBeLessThanOrEqual(1)
    else expect(Math.abs(edge.offset), 'every top-level block starts on the column edge').toBeLessThanOrEqual(1)
  }
  const textEdges = await column.evaluate(root => [...root.querySelectorAll('[data-slot="rows"], [data-slot="summary-list"], [data-slot="section"]')].flatMap(surface => {
    const leaves = [...surface.querySelectorAll('[data-slot="row-title"], [data-slot="section-head"] [data-slot="group-label"], [data-slot="summary-key"], [data-slot="section-footer"] [data-slot="text"]')]
      .filter(element => element.getClientRects().length > 0 && element.closest('[data-slot="rows"], [data-slot="summary-list"], [data-slot="section"]') === surface)
    return leaves.length > 1 ? [leaves.map(element => element.getBoundingClientRect().left)] : []
  }))
  for (const edges of textEdges) for (const edge of edges) expect(Math.abs(edge - edges[0]!), 'head, row and footer text keep one left edge').toBeLessThanOrEqual(1)
  await expect(page.locator('[data-frame-region="right"]:visible [data-slot="tool-body"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="status-bar"]')).toHaveCount(0)
  await expect(page.locator('[data-frame-region="right"]:visible')).toHaveCount(0)
  for (const control of await bar.locator('button:visible, a:visible, input:visible, select:visible, textarea:visible, [role="tab"]:visible, [role="button"]:visible').all()) {
    expect(await control.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
export const expectDestinationTab = async (page: Page, value: string): Promise<void> => {
  const tab = page.locator(`[data-team-page="${value}"]:visible`)
  if (await tab.count()) { await expect(tab).toHaveAttribute('aria-selected', 'true'); return }
  const choice = pageChoiceFor(value)
  await page.locator('[data-slot="page-options"]:visible').getByTitle(choice.title, { exact: true }).click()
  const item = page.getByRole('menuitemradio').filter({ has: page.getByText(choice.label, { exact: true }) })
  await expect(item).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}

export const expectPageJourney = async (page: Page, label: string, kind: string, width = 1440, options: { readonly opener?: 'review' } = {}): Promise<void> => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({width,height:900})
  await page.goto(`/preview.html?frame-wall=navigation${options.opener==='review'?'&frame-review=1':''}&theme=light`)
  const reveal = async () => { if(width < FRAME.fold.sidebarFloats) await page.getByRole('button',{name:'Show sidebar',exact:true}).click() }
  if (options.opener !== 'review') await reveal()
  const column = page.locator('[data-left-column]:visible')
  const columnChrome = async () => {
    expect((await column.boundingBox())!.y).toBe(0)
    expect((await column.locator('[data-left-top]').boundingBox())!.height).toBe(FRAME.bar.height)
    const colors = await column.evaluate(node => {
      const paint = (element:Element):string => {
        const color=getComputedStyle(element).backgroundColor
        return color==='rgba(0, 0, 0, 0)' || color==='transparent' ? element.parentElement ? paint(element.parentElement) : color : color
      }
      const expected=document.createElement('div');expected.style.background='var(--hd-sidebar)';node.append(expected)
      const result=[paint(node),paint(node.querySelector('[data-left-top]')!),getComputedStyle(expected).backgroundColor]
      expected.remove();return result
    })
    expect(colors[0]).toBe(colors[2]);expect(colors[1]).toBe(colors[2])
    expect(await column.locator('[data-left-top] button').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))))
      .toEqual(['Hide sidebar','Search everything','Back','Forward','Conversation mode','Editor mode'])
    await expect(column.getByText('Back to app',{exact:true})).toHaveCount(0)
    if(options.opener==='review')await expect(column.locator('[data-left-settings]:visible')).toHaveCount(0)
  }
  if (options.opener !== 'review') await columnChrome()
  const remembered = page.locator('[data-slot="retained-work"] [data-pane-id]').first()
  await remembered.evaluate(node => { node.setAttribute('data-page-journey','remembered') })
  const door = label === 'Settings'
    ? column.locator('[data-left-seat]').getByRole('button',{name:label,exact:true})
    : column.locator('[aria-label="Main sections"]').getByRole('button',{name:label,exact:true})
  const composer = page.locator('[data-slot="composer-text"]:visible')
  if (options.opener === 'review') {
    await composer.fill('Keep this review draft')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
  } else await door.click()
  await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  await expect(page.locator('[data-slot="app-window"]:visible')).toHaveCount(0)
  await reveal();await columnChrome()
  await expect(column.locator('[data-left-settings]:visible')).toHaveCount(kind === 'settings' ? 1 : 0)
  if (kind !== 'settings' && options.opener!=='review') await expect(door).toHaveAttribute('aria-current','page')
  const back = column.locator('[data-left-top]').getByRole('button',{name:'Back',exact:true})
  const forward = column.locator('[data-left-top]').getByRole('button',{name:'Forward',exact:true})
  await expect(back).toBeEnabled();await back.click()
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await expect(remembered).toHaveAttribute('data-page-journey','remembered')
  if (options.opener==='review') await expect(composer).toHaveValue('Keep this review draft')
  await reveal();await columnChrome()
  await expect(forward).toBeEnabled();await forward.click()
  await expect(page.locator(`[data-page-destination="${kind}"]:visible`)).toHaveCount(1)
  await reveal();await columnChrome()
  if (options.opener === 'review') {
    await column.getByRole('button', {name:'New session',exact:true}).click()
    await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
    await reveal()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
    await expect(page.locator('[data-page-destination="changes-review"]:visible')).toHaveCount(1)
    if (width < FRAME.fold.sidebarFloats && await column.count() === 0) await reveal()
    await column.locator('[data-region="session-row"] [data-slot="sidebar-menu-button"]').first().click()
    await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  }

}
