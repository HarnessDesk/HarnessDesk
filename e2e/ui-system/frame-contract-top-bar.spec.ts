import { expectTitleRoom } from './title-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { applyFrameActions, selectFrameTab, settleFrameBar } from './frame-actions'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


{
  const cases = [
    { query: 'frame-wall=agents&frame-detail=agent&frame-agent-case=release-checker', title: 'Release checker', state: 'Edit' },
    { query: 'frame-wall=conversation&frame-short-title=1', title: 'Extract the address form', state: 'Idle' },
  ] as const
  for (const [item0, one] of (cases).entries()) test(`R10.11 short title keeps its state chip at the text gap [item ${[item0].join('-')}]`, async ({ page }) => {

    await openFrame(page, one.query, 'light', 1440)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    const title = bar.locator('[data-topbar-title] [data-slot="text"]').last()
    const state = bar.locator('[data-topbar="state"]')
    await expect(title).toContainText(one.title)
    await expect(state).toContainText(one.state)
    const geometry = await title.evaluate(node => {
      const titleSlot = node.closest<HTMLElement>('[data-topbar-title]')!
      const stateSlot = titleSlot.parentElement?.parentElement?.querySelector<HTMLElement>('[data-topbar="state"]')
      const range = document.createRange()
      range.selectNodeContents(node)
      const ink = range.getBoundingClientRect()
      return {
        titleWidth: titleSlot.getBoundingClientRect().width,
        inkRight: ink.right,
        stateLeft: stateSlot?.getBoundingClientRect().left ?? null,
      }
    })
    await expectTitleRoom(bar.locator('[data-topbar-title]'))
    expect(geometry.stateLeft, `${one.title} exposes a state chip`).not.toBeNull()
    expect(geometry.stateLeft! - geometry.inkRight, `${one.title} state gap`).toBeCloseTo(FRAME.bar.gap, 0)


  })
}

for (const theme of WALL_THEMES) test(`a short Library title keeps its tabs and verb in ${theme}`, async ({ page }) => {
  await openFrame(page, 'frame-wall=library', theme)
  const bar = page.locator('[data-slot="top-bar"]:visible')
  await settleFrameBar(bar)
  await expectTitleRoom(bar.locator('[data-topbar-title]'))
  expect((await bar.locator('[data-topbar-title]').boundingBox())!.width).toBeLessThan(FRAME.bar.titleMin)
  await expect(bar).toHaveAttribute('data-fold', '0')
  await expect(bar.locator('[role="tab"][data-team-page="skill"]')).toBeVisible()
  await expect(bar.getByRole('button', { name: 'New skill', exact: true })).toBeVisible()
})

for (const theme of WALL_THEMES) for (const filter of ['All', 'Open', 'Blocking']) {
  test(`B11 native-width lead folds the Findings ${filter} verb last in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme, 720)
    await applyFrameActions(page, { tab: 'findings', viewChoice: filter })
    const bar = page.locator('[data-slot="top-bar"]:visible').first()
    const verb = bar.locator('[data-topbar="verb"] button')
    await expect(verb).toHaveText('Decide this run')
    const refusal = await verb.getAttribute('title')
    const fixed = bar.locator('[data-topbar="view"] button, [data-work-tool], [data-topbar="more"] button')
    const positions = await fixed.evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })))
    // Match the measured native traffic-light reserve, without changing app
    // tokens or the browser preview's ordinary corner policy.
    await bar.evaluate(node => { node.closest('header')!.style.paddingLeft = '78px' })
    await expectTitleRoom(bar.locator('[data-topbar-title]'))
    await expect(bar).toHaveAttribute('data-fold', '3')
    const textEdge = await bar.evaluate(node => node.querySelector('[data-topbar="lead"]')!.getBoundingClientRect().right + parseFloat(getComputedStyle(node).columnGap))
    expect((await bar.locator('[data-topbar="place"]').boundingBox())!.x).toBe(textEdge)
    await expect(bar.locator('[data-topbar="lead"] button')).toHaveCount(2)
    expect(await bar.locator('[data-topbar="lead"] button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['Show sidebar', 'Search everything'])
    await expect(verb).toHaveCount(0)
    await expect(bar.locator('[data-work-tool]')).toHaveCount(4)
    expect(await fixed.evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })))).toEqual(positions)
    await bar.getByRole('button', { name: 'More', exact: true }).click()
    const first = page.getByRole('menu').getByRole('menuitem').first()
    await expect(first.getByText('Decide this run', { exact: true })).toBeVisible()
    await expect(first).toHaveAttribute('aria-disabled', 'true')
    expect(await first.evaluate(node => node.nextElementSibling?.getAttribute('role'))).toBe('separator')
    expect(await first.evaluate(node => document.getElementById(node.getAttribute('aria-describedby')!)?.textContent)).toBe(refusal)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(verb).toHaveText('Decide this run')
    await expect(bar.getByRole('button', { name: 'Destination views', exact: true })).toHaveCount(0)
  })
}
test.describe('B11a owner corrections', () => {
  for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
    test(`Owner fix 2 Activity tasks close from either control at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=conversation&frame-status=tasks', theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      const panel = page.locator('[data-slot="work-tools"]:visible')
      const tasks = bar.getByRole('button', { name: 'Activity', exact: true })
      await expect(tasks.locator('[data-slot="tool-dot"]')).toHaveCount(1)
      for (const closer of ['Toggle right panel', 'Activity']) {
        await tasks.click()
        await expect(panel).toBeVisible()
        await expect(bar.getByRole('button', { name: 'Activity', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await bar.getByRole('button', { name: closer, exact: true }).click()
        await expect(panel).toHaveCount(0)
        await expect(bar.getByRole('button', { name: 'Toggle right panel', exact: true })).toHaveAttribute('aria-pressed', 'false')
      }
    })
    {

      for (const [item0, foundation] of (['desk', 'studio'] as const).entries()) test(`B11a owner bar edge and retained control geometry at ${width} in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {

        await openFrame(page, 'frame-wall=conversation', theme, width)
        await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
        const bar = page.locator('[data-slot="top-bar"]:visible')
        const header = bar.locator('..')
        await expect(header).not.toHaveAttribute('data-rule', 'bottom')
        expect(await header.evaluate(node => getComputedStyle(node).borderBottomWidth)).toBe('0px')
        expect((await header.boundingBox())!.height).toBe(FRAME.bar.height)
        const toggle = bar.getByRole('button', { name: 'Toggle right panel', exact: true })
        for (const open of [false, true, false]) {
          if (open || await toggle.getAttribute('aria-pressed') === 'true') await toggle.click()
          await expect(toggle).toHaveAttribute('aria-pressed', String(open))
          await settleFrameBar(bar)
          const box = (await toggle.boundingBox())!, head = (await header.boundingBox())!
          // The former border occupied the final pixel of the 40px bar.
          expect(box.y + box.height / 2 - head.y).toBe((FRAME.bar.height - 1) / 2)
          const tools = bar.locator('[data-topbar="tools"]')
          if (open && width >= FRAME.fold.panelFloats) {
            const column = (await tools.boundingBox())!
            expect(column.y).toBe(head.y)
            expect(column.height).toBe(FRAME.bar.height)
            expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
          } else expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
        }


      })
    }
  }
})

for (const theme of WALL_THEMES) {
  for (const width of WALL_WIDTHS) {
    test(`Owner fix 2 frame reaches bottom and More retains Terminal at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team&frame-terminal=1', theme, width)
      await expect(page.locator('[data-slot="status-bar"], [data-frame-region="status"]')).toHaveCount(0)
      const main = (await page.locator('[data-frame-region="main"]').boundingBox())!
      const bottom = (await page.locator('[data-frame-region="bottom"]').boundingBox())!
      expect(main.y + main.height).toBe(bottom.y)
      expect(bottom.y + bottom.height).toBe(900)
      if (width >= FRAME.fold.sidebarFloats) {
        const left = (await page.locator('[data-frame-region="left"]').boundingBox())!
        expect(left.y + left.height).toBe(900)
        const seat = (await page.locator('[data-left-seat]').boundingBox())!
        expect(seat.y + seat.height).toBe(900)
      }
      const terminal = page.locator('[data-terminal-id]')
      const id = await terminal.getAttribute('data-terminal-id')
      await selectFrameTab(page, 'findings')
      await expect(terminal).toHaveAttribute('data-terminal-id', id!)
      await expect(terminal).toBeVisible()
      await page.getByRole('button', { name: 'More', exact: true }).click()
      const item = page.getByRole('menuitemradio', { name: /Terminal/ })
      await expect(item).toContainText('⌃`')
      await item.click()
      await expect(terminal).toHaveCount(0)
      await expect(page.getByRole('menu')).toHaveCount(0)
      const work = page.locator('[data-slot="workbench-main"] [data-pane-id]').first()
      await work.focus()
      await expect(work).toBeFocused()
      await page.keyboard.press('Control+Backquote')
      await expect(page.locator('[data-terminal-id]')).toBeVisible()
    })
  }
  test(`Owner fix 2 Activity carries tasks and connection Banner clears in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-status=tasks', theme)
    const activity = page.getByRole('button', { name: 'Activity', exact: true })
    await expect(activity.locator('[data-slot="tool-dot"]')).toHaveCount(1)
    expect((await activity.boundingBox())!.height).toBe(FRAME.bar.iconButton)
    await activity.click()
    const sections = page.locator('[data-slot="work-tools"] [data-slot="tool-section"]:visible')
    await expect(sections.first()).toHaveAttribute('aria-label', 'Background work')
    await expect(sections.first()).toContainText('Review the checkout')
    await openFrame(page, 'frame-wall=team&frame-status=reconnecting', theme, 720)
    await expect(page.locator('[data-shell-host="main-notice"]')).toContainText('Reconnecting to HarnessDesk.')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:preview-connection', { detail: 'open' })))
    await expect(page.locator('[data-shell-host="main-notice"] [role="status"]')).toHaveCount(0)
  })
  test(`Owner fix 2 update row uses column anatomy above seat in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-update=1', theme)
    const update = page.getByRole('button', { name: 'Relaunch to update', exact: true })
    await expect(update).toBeVisible()
    expect((await update.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    const seat = (await page.locator('[data-left-seat]').boundingBox())!
    const row = (await update.boundingBox())!
    expect(row.y + row.height).toBeLessThanOrEqual(seat.y)
    await update.click()
    await expect(update).toHaveCount(0)
  })
}

for (const { label, query } of [
  { label: 'draft', query: 'frame-wall=draft' },
  { label: 'conversation closed', query: 'frame-wall=conversation' },
  { label: 'conversation open', query: 'frame-wall=conversation&frame-tool=details' },
  { label: 'Settings mode', query: 'frame-wall=settings-navigation' },
  { label: 'Team', query: 'frame-wall=team' },
]) for (const width of WALL_WIDTHS) {
  test(`Owner check 1 interactive descendants opt out of the drag region in ${label} at ${width}`, async ({ page }) => {
    await openFrame(page, query, 'light', width)
    const region = label === 'Settings mode' && width >= FRAME.fold.sidebarFloats
      ? page.locator('[data-left-top] .hd-drag:visible')
      : page.locator('[data-frame-region="top"] .hd-drag:visible').filter({ has: page.locator('[data-slot="top-bar"]') }).first()
    await expect(region).toBeVisible()
    const measurements = await region.evaluate(node => {
      const selectors = [
        'button', 'a[href]', 'input', 'select', 'textarea', 'summary', '[contenteditable]',
        '[tabindex]:not([tabindex="-1"])', '[role="button"]', '[role="link"]', '[role="tab"]',
        '[role="menuitem"]', '[role="switch"]', '[role="checkbox"]', '[role="combobox"]', '[role="option"]',
      ].join(',')
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
      }
      const interactive = [...node.querySelectorAll<HTMLElement>(selectors)]
        .filter(element => visible(element) && element.closest('.hd-drag') === node)
        .map(element => ({
          label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
          region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
        }))
      return { region: getComputedStyle(node).getPropertyValue('-webkit-app-region'), interactive }
    })
    expect(measurements.region).toBe('drag')
    expect(measurements.interactive.length).toBeGreaterThan(0)
    expect(measurements.interactive.filter(element => element.region !== 'no-drag'), JSON.stringify(measurements.interactive)).toEqual([])
  })
}
for (const theme of WALL_THEMES) {
  test(`bars stand ${FRAME.bar.height}px in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const rows = page.locator('[data-region="sidebar-header"] [data-slot="bar"]')
    await expect(rows.first()).toBeVisible()
    const heights = await rows.evaluateAll((bars) => bars.map((bar) => Math.round(bar.getBoundingClientRect().height)))
    expect(heights.length).toBeGreaterThan(0)
    for (const height of heights) expect(height).toBe(FRAME.bar.height)
    const header = page.locator('[data-slot="top-bar"]').locator('..')
    await expect(header).toBeVisible()
    expect(Math.round((await header.boundingBox())!.height)).toBe(FRAME.bar.height)
  })

  test(`a menu keeps the contract in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    await page.locator('[data-slot="top-bar"]:visible').first().getByRole('button', { name: 'More', exact: true }).click()
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    const surface = await menu.evaluate((el) => {
      // This Menu borrows Popover's padded panel; the menu role is its unpadded level.
      const panel = el.closest('[data-slot="popover-popup"]')!
      const style = getComputedStyle(panel)
      return {
        width: panel.getBoundingClientRect().width,
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        radius: style.borderTopLeftRadius,
      }
    })
    expect(surface.width).toBeGreaterThanOrEqual(FRAME.menu.min)
    expect(surface.padding).toEqual(Array(4).fill(`${FRAME.menu.padding}px`))
    expect(surface.radius).toBe(`${FRAME.menu.radius}px`)
    const rows = await menu.locator('[role^="menuitem"]').evaluateAll((items) => items.map((item) => {
      const style = getComputedStyle(item)
      return { minHeight: style.minHeight, radius: style.borderTopLeftRadius }
    }))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.minHeight).toBe(`${FRAME.menu.rowHeight}px`)
      expect(row.radius).toBe(`${FRAME.menu.rowRadius}px`)
    }
  })

  for (const width of [1440, 720]) {
    test(`the Findings page keeps the reading measure at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=team', theme, width)
      await selectFrameTab(page, 'findings')
      const column = page.locator('[data-slot="page"][data-width="reading"]').first()
      await expect(column).toBeVisible()
      const measured = await column.evaluate((el) => {
        const style = getComputedStyle(el)
        const box = el.getBoundingClientRect()
        const parent = el.parentElement!.getBoundingClientRect()
        const left = box.left + parseFloat(style.paddingLeft)
        return {
          gutters: [parseFloat(style.paddingLeft), parseFloat(style.paddingRight)],
          measure: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          margins: [box.left - parent.left, parent.right - box.right],
          edges: [...el.children]
            .filter((child) => (child as HTMLElement).offsetParent !== null)
            .map((child) => Math.round(child.getBoundingClientRect().left - left)),
        }
      })
      expect(measured.gutters).toEqual([FRAME.page.gutter, FRAME.page.gutter])
      expect(measured.measure).toBeLessThanOrEqual(FRAME.page.reading)
      expect(Math.abs(measured.margins[0] - measured.margins[1])).toBeLessThanOrEqual(1)
      expect(measured.edges, 'every block starts at the column edge').toEqual(measured.edges.map(() => 0))
    })
  }
}

for (const theme of WALL_THEMES) {
  test(`B1 TopBar is one contract-height row in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=topbar', theme)
    const rows = page.locator('[data-slot="top-bar"]')
    await expect(rows.first()).toBeVisible()
    for (const box of await rows.evaluateAll(nodes => nodes.map(node => node.closest('header')!.getBoundingClientRect().height))) {
      expect(Math.round(box)).toBe(FRAME.bar.height)
    }
    await expect(rows.first().locator('[data-slot="bar-divider"]')).toHaveCount(0)
    await expect(rows.first().locator('[data-topbar="more"] button')).toHaveCount(0)
    await expect(rows.first().locator('[data-team-page="findings"]')).toBeVisible()
    // The empty probe has no subject actions; real work owns Terminal in More.
    await openFrame(page, 'frame-wall=conversation', theme)
    await expect(rows.first().locator('[data-topbar="more"]')).toBeVisible()
    const more = rows.first().getByRole('button', { name: 'More', exact: true })
    await more.click()
    await expect(page.getByRole('menuitemradio', { name: /Terminal/ })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(more).toBeFocused()
    await more.click()
    const popup = page.locator('[data-slot="popover-popup"]:visible')
    await expect(popup).toHaveCSS('-webkit-app-region', 'no-drag')
    await page.getByRole('menuitemradio', { name: /Terminal/ }).click()
    await expect(page.locator('[data-frame-region="bottom"]:visible')).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`B1 probe exercises folded tabs and restores them in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=topbar', theme, 720)
    const row = page.locator('[data-slot="top-bar"]')
    await expect(row).toHaveAttribute('data-fold', '2')
    await expectTitleRoom(row.locator('[data-topbar-title]'))
    await selectFrameTab(page, 'run')
    await expect(page.getByTitle('Destination views', { exact: true })).toContainText('Run')
    await expect(row).toHaveAttribute('data-fold', '2')
    await page.getByTitle('Destination views', { exact: true }).focus()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(row).toHaveAttribute('data-fold', '0')
    await expect(row.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute('data-active', '')
    await expect(row.getByRole('tab', { name: 'Run', exact: true })).toBeFocused()
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(row).toHaveAttribute('data-fold', '2')
    await expect(page.getByTitle('Destination views', { exact: true })).toBeFocused()
  })
}

for (const theme of WALL_THEMES) {
  test(`B1 catalogue preserves words for a verb without an icon in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/design.html?view=top-bar&theme=${theme}`)
    const rows = page.locator('[data-slot="top-bar"]')
    await expect(rows).toHaveCount(4)
    const narrow = rows.nth(2)
    await expect(narrow).toHaveAttribute('data-fold', '2')
    await expect(narrow.getByRole('button', { name: 'Decide this run', exact: true })).toHaveText('Decide this run')
    await expectTitleRoom(narrow.locator('[data-topbar-title]'))
    await expect(rows.nth(3).getByRole('button', { name: 'View', exact: true })).toBeDisabled()
    await page.screenshot({ path: `output/frame-wall/B1-catalogue-${theme}.png`, fullPage: true })
  })
}

for (const theme of WALL_THEMES) {
  {

    for (const [item0, width] of ([1440, 1100, 720]).entries()) test(`B11a bar order, switcher, pressed tools and continuous standing seam in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {

      await openFrame(page, 'frame-wall=team', theme, width)
      const bar = page.locator('[data-slot="top-bar"]:visible')
      await expectTitleRoom(bar.locator('[data-topbar-title]'))
      const order = await bar.evaluate(node => [...node.children].map(one => one.getAttribute('data-topbar')))
      if (order.includes('state')) {
        expect(order.indexOf('place')).toBeLessThan(order.indexOf('state'))
        expect(order.indexOf('state')).toBeLessThan(order.indexOf('tabs'))
      }
      expect(order.indexOf('place')).toBeLessThan(order.indexOf('tabs'))
      expect(order.indexOf('tabs')).toBeLessThan(order.indexOf('spacer'))
      const track = bar.locator('[data-slot="tabs-list"]')
      if (await track.isVisible()) {
        await expect(track).toHaveAttribute('data-look', 'quiet')
        expect(await track.evaluate(node => { const style = getComputedStyle(node); return [style.paddingTop, style.gap, style.borderRadius] })).toEqual(['0px', '2px', '8px'])
        expect(await track.locator('[role="tab"]').first().evaluate(node => { const style = getComputedStyle(node); return [node.getBoundingClientRect().height, style.paddingLeft, style.borderRadius, style.fontSize] })).toEqual([FRAME.bar.tabHeight, `${FRAME.bar.tabPad}px`, `${FRAME.bar.tabRadius}px`, '13px'])
        const selected = track.locator('[aria-selected="true"]')
        await expect(selected).toHaveCSS('box-shadow', 'none')
        const muted = await track.evaluate(node => {
          const probe = document.createElement('span')
          probe.style.background = 'var(--hd-muted)'
          node.append(probe)
          const color = getComputedStyle(probe).backgroundColor
          probe.remove()
          return color
        })
        await expect(selected).toHaveCSS('background-color', muted)
      }
      await bar.getByRole('button', { name: 'Details', exact: true }).click()
      const tools = bar.locator('[data-topbar="tools"]')
      const panel = page.locator('[data-slot="work-tools"]:visible')
      await expect(panel).toBeVisible()
      const pressed = bar.locator('[data-work-tool="details"]')
      await expect(pressed).toHaveAttribute('aria-pressed', 'true')
      await expect(pressed).toHaveCSS('box-shadow', 'none')
      expect(await pressed.evaluate(node => getComputedStyle(node).backgroundColor))
        .not.toBe(await bar.locator('[data-work-tool="changes"]').evaluate(node => getComputedStyle(node).backgroundColor))
      expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
      if (width >= FRAME.fold.panelFloats) {
        const top = (await tools.boundingBox())!, body = (await panel.boundingBox())!
        expect(top.x).toBe(body.x)
        expect(top.width).toBe(body.width)
        expect(top.y).toBe(0)
      }
      await bar.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
      expect(await tools.evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')


    })
  }

  test(`B11a panel facts have one-line row density and Findings agrees with its tab in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=team', theme)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    await bar.getByRole('button', { name: 'Details', exact: true }).click()
    const panel = page.locator('[data-slot="tool-body"]:visible')
    const facts = panel.locator('[data-slot="summary-item"]:not(:has([data-slot="summary-action"]))')
    await expect(panel).toBeVisible()
    await expect(facts.first()).toBeVisible()
    const rows = await facts.evaluateAll(nodes => nodes.filter(node => !node.querySelector('[data-slot="summary-note"]')).map(node => node.getBoundingClientRect().height))
    expect(rows.length).toBeGreaterThan(2)
    expect(rows.every(height => height >= 36 && height <= 38)).toBe(true)
    await bar.getByRole('button', { name: 'Toggle right panel', exact: true }).click()
    await selectFrameTab(page, 'findings')
    await expect(bar.locator('[data-team-page="findings"]')).toContainText('3')
    await expect(page.locator('[aria-label="Findings summary"]')).toBeVisible()
    expect(await page.locator('[aria-label="Findings summary"] [data-slot="summary-item"]').evaluateAll(nodes => nodes.map(node => [node.querySelector('dt')?.textContent, node.querySelector('[data-slot="summary-value"]')?.textContent]))).toEqual([['Open', '3'], ['Blocking', '3'], ['All', '3']])
    await expect(page.locator('[data-slot="workbench-main"]')).not.toContainText('No findings recorded')
  })
}
