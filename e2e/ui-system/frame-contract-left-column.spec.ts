import { applyLeftColumnActions } from './left-column-actions'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { openFrame, resolvedPx } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


for (const theme of WALL_THEMES) {
  for (const width of WALL_WIDTHS) {
    for (const foundation of ['desk', 'studio'] as const) {
      test(`D7 group names sit with icons and following groups use the spacing token at ${width} in ${theme}/${foundation}`, async ({ page }, testInfo) => {
        await openFrame(page, 'frame-wall=left-work', theme, width)
        await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
        const column = page.locator('[data-left-column]:visible')
        if (!await column.count()) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
        const token = await resolvedPx(page, '--hd-space-4')
        const sessions = await column.evaluate(column => {
          const inkX = (element: Element) => {
            const range = document.createRange()
            range.selectNodeContents(element)
            return range.getBoundingClientRect().x
          }
          const firstIcon = column.querySelector('[data-left-row] [data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x
          const dashboard = column.querySelector('[aria-label="Dashboard"]')!.getBoundingClientRect()
          const projects = column.querySelector('[data-left-projects-head] [data-slot="navigation-group-label"]')!
          const names = [...column.querySelectorAll('[data-left-group-text], [data-draggable] [data-slot="sidebar-menu-label-content"]')]
            .map(label => ({ label: label.textContent, x: inkX(label), size: parseFloat(getComputedStyle(label).fontSize), weight: parseInt(getComputedStyle(label).fontWeight, 10) }))
          const gaps = [{ label: 'Projects', gap: projects.getBoundingClientRect().top - dashboard.bottom }]
          const allRows = [...column.querySelectorAll('[data-left-row]')]
          for (const project of column.querySelectorAll('[data-project-root]')) {
            const label = project.querySelector('[data-draggable] [data-slot="sidebar-menu-label-content"]')!
            const heading = label.closest('[data-left-row]')!
            const previousRow = allRows[allRows.indexOf(heading) - 1]
            if (previousRow) gaps.push({ label: label.textContent!, gap: label.getBoundingClientRect().top - previousRow.getBoundingClientRect().bottom })
          }
          const rows = [...column.querySelectorAll('[data-left-row] [data-slot="sidebar-menu-button"]:not([aria-expanded])')].map(row => {
            const style = getComputedStyle(row)
            return { height: row.getBoundingClientRect().height, icon: row.querySelector('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().width, gap: parseFloat(style.gap) }
          })
          const disclosures = [...column.querySelectorAll('[data-draggable]')].map(row => ({
            arrowX: row.querySelector('[data-slot="disclosure-chevron"]')!.getBoundingClientRect().x,
            nameRight: row.querySelector('[data-left-fold-name]')!.getBoundingClientRect().right,
          }))
          return { firstIcon, names, gaps, rows, disclosures }
        })
        const modes = []
        for (const query of ['frame-wall=settings', 'frame-wall=settings-middle']) {
          await openFrame(page, query, theme, width)
          if (query === 'frame-wall=settings' && width === 720) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
          await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
          const navigation = page.locator(query === 'frame-wall=settings' ? '[aria-label="Settings navigation"]' : '[data-left-settings]')
          const groups = await navigation.locator('[data-left-group]').evaluateAll(groups => groups.map(group => {
            const previousRow = group.previousElementSibling?.querySelector('[data-left-row]:last-child')
            const label = group.querySelector(':scope > [data-slot="group-label"]')!
            const name = label.querySelector('[data-left-group-text]')!
            const range = document.createRange()
            range.selectNodeContents(name)
            const icon = group.querySelector('[data-left-row] [data-slot="sidebar-menu-icon"]')!
            return { label: name.textContent, x: range.getBoundingClientRect().x, iconX: icon.getBoundingClientRect().x,
              gap: previousRow ? label.getBoundingClientRect().top - previousRow.getBoundingClientRect().bottom : null,
              inset: label.getBoundingClientRect().top - group.getBoundingClientRect().top }
          }))
          expect(groups.length).toBeGreaterThan(1)
          modes.push({ query, groups })
        }
        await testInfo.attach('group-labels', { body: JSON.stringify({ width, theme, foundation, token, sessions, modes }, null, 2), contentType: 'application/json' })
        expect(sessions.names.length).toBeGreaterThan(2)
        for (const name of sessions.names) {
          expect(name.x, `Sessions: ${name.label}`).toBe(sessions.firstIcon)
          expect(name.size).toBe(FRAME.rail.label)
          expect(name.weight).toBe(FRAME.rail.groupWeight)
        }
        for (const group of sessions.gaps) expect(group.gap, `Sessions: ${group.label}`).toBe(token)
        for (const disclosure of sessions.disclosures) expect(disclosure.arrowX - disclosure.nameRight, 'disclosure follows the name by the spacing token').toBe(6)
        for (const row of sessions.rows) {
          expect(row.height).toBe(FRAME.rail.rowHeight)
          expect(row.icon).toBe(FRAME.rail.icon)
          expect(row.gap).toBe(FRAME.rail.gap)
        }
        for (const mode of modes) for (const group of mode.groups) {
          expect(group.x, `${mode.query}: ${group.label}`).toBe(group.iconX)
          if (group.gap !== null) expect(group.gap, `${mode.query}: ${group.label}`).toBe(token)
          else expect(group.inset, 'the first group keeps its existing spacing').toBe(0)
        }
      })
    }
  }
}

for (const theme of WALL_THEMES) {
  for (const foundation of ['desk', 'studio'] as const) {
  test(`D1 row anatomy in ${theme}/${foundation}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-column', theme)
    await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
    const rows = page.locator('[data-left-row]')
    await expect(rows).toHaveCount(4)
    const values = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!
      const label = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
      const css = getComputedStyle(button)
      return { h: button.getBoundingClientRect().height, inset: parseFloat(css.paddingLeft), gap: parseFloat(css.gap),
        size: parseFloat(css.fontSize), weight: parseFloat(css.fontWeight), line: parseFloat(css.lineHeight), family: css.fontFamily, smoothing: css.getPropertyValue("-webkit-font-smoothing"), icon: icon.getBoundingClientRect().width,
        iconX: icon.getBoundingClientRect().x, textX: label.getBoundingClientRect().x,
        slots: node.querySelectorAll('[data-left-trailing]').length }
    }))
    for (const value of values) {
      expect(value.h).toBe(FRAME.rail.rowHeight)
      expect(value.inset).toBe(FRAME.rail.inset)
      expect(value.gap).toBe(FRAME.rail.gap)
      expect(value.icon).toBe(FRAME.rail.icon)
      expect(value.size).toBe(FRAME.rail.label)
      expect(value.weight).toBe(400)
      expect(value.line).toBe(FRAME.rail.line)
      expect(value.family).toContain('Geist')
      expect(value.smoothing).not.toBe('antialiased')
      expect(value.slots).toBe(1)
    }
    const group = await page.locator('[data-left-group-text]').evaluate(el => ({
      x: el.getBoundingClientRect().x,
      size: parseFloat(getComputedStyle(el).fontSize),
      weight: parseFloat(getComputedStyle(el).fontWeight),
    }))
    expect(group.size).toBe(FRAME.rail.label)
    expect(group.weight).toBe(FRAME.rail.groupWeight)
    expect(Math.abs(group.x - values[0]!.iconX)).toBeLessThanOrEqual(1)
    const controls = await page.locator('[data-left-top] button').evaluateAll(nodes => nodes.map(el => ({
      width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
    })))
    expect(controls).toHaveLength(4)
    for (const control of controls) {
      expect(control.width).toBe(FRAME.bar.iconButton)
      expect(control.height).toBe(FRAME.bar.iconButton)
    }
    const selected = page.locator('[data-left-row] [data-active="true"]')
    const fill = await selected.evaluate(el => {
      const expected = document.createElement('div')
      expected.style.background = 'var(--hd-selected)'
      el.append(expected)
      const result = [getComputedStyle(el).backgroundColor, getComputedStyle(expected).backgroundColor]
      expected.remove()
      return result
    })
    expect(fill[0]).toBe(fill[1])
    expect((await page.locator('[data-left-top]').boundingBox())!.height).toBe(FRAME.bar.height)
    expect((await page.locator('[data-left-seat]').locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    const seatTextX = await page.locator('[data-left-seat]').evaluate(seat => {
      const walker = document.createTreeWalker(seat, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (node.textContent?.trim() === 'Jane Doe') {
          const range = document.createRange()
          range.selectNodeContents(node)
          return range.getBoundingClientRect().x
        }
      }
      throw new Error('Missing synthetic seat name')
    })
    expect(Math.abs(seatTextX - values[0]!.textX), 'seat and row ink share an edge').toBeLessThanOrEqual(1)
    for (const field of ['iconX', 'textX'] as const) {
      const xs = values.map(value => value[field])
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
    }
  })
  }
}

// D2's standalone column proof; the shell-bottom/fold integration waits for B.
for (const theme of WALL_THEMES) {
  test(`D2 left header, page doors and seat in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible')
    const top = column.locator('[data-left-top]')
    await expect(top.locator('[data-slot="bar"]')).toHaveCount(1)
    expect((await top.boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(top.locator('[data-role="wordmark"]')).toHaveCount(0)
    await expect(top.locator('[data-work-panel-toggle]')).toHaveCount(0)
    const rows = column.locator('[aria-label="Main sections"] [data-left-row]')
    await expect(rows).toHaveCount(5)
    const anatomy = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const css = getComputedStyle(button)
      return { name: button.getAttribute('aria-label'), height: button.getBoundingClientRect().height,
        size: parseFloat(css.fontSize), slots: node.querySelectorAll('[data-left-trailing]').length }
    }))
    expect(anatomy.map(row => row.name)).toEqual(['Teams', 'Agents', 'Library', 'Plugins', 'Dashboard'])
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.size).toBe(FRAME.rail.label)
      expect(row.slots).toBe(1)
    }
    const seat = column.locator('[data-left-seat]')
    expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
    await expect(seat.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-pressed', 'false')
    const start = column.getByRole('button', { name: 'New session', exact: true })
    await expect(start.locator('..').locator('[data-left-trailing] button')).toHaveCount(1)
  })
}


for (const theme of WALL_THEMES) {
  test(`D2 existing Settings rail shares row and group anatomy in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings', theme)
    const nav = page.getByRole('navigation', { name: 'Settings navigation' })
    const group = nav.locator('[data-left-group]').first()
    const rows = group.locator('[data-left-row]')
    await expect(rows).toHaveCount(4)
    const anatomy = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector('[data-slot="sidebar-menu-icon"]')!
      const css = getComputedStyle(button)
      return { height: button.getBoundingClientRect().height, icon: icon.getBoundingClientRect().width,
        iconX: icon.getBoundingClientRect().x, size: parseFloat(css.fontSize) }
    }))
    for (const row of anatomy) {
      expect(row.height).toBe(FRAME.rail.rowHeight)
      expect(row.icon).toBe(FRAME.rail.icon)
      expect(row.size).toBe(FRAME.rail.label)
    }
    const ink = await group.locator('[data-left-group-text]').boundingBox()
    expect(ink!.x).toBe(anatomy[0]!.iconX)
    const general = rows.first().getByRole('button')
    await expect(general).toHaveAttribute('aria-current', 'page')
    await general.focus()
    await page.keyboard.press('ArrowDown')
    await expect(rows.nth(1).getByRole('button')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(rows.nth(1).getByRole('button')).toHaveAttribute('aria-current', 'page')
    await nav.getByRole('searchbox', { name: 'Search settings' }).fill('keyboard')
    await expect(nav.locator('[data-left-group] [data-left-row]')).toHaveCount(1)
    await expect(nav.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  })
}

for (const theme of WALL_THEMES) {
  test(`D3 Teams are single rows in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const team = page.getByRole('button', { name: 'Room Ship checkout retry', exact: true })
    await expect(team).toBeVisible()
    expect((await team.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await expect(team.locator('..').locator('[data-left-trailing]')).toHaveCount(1)
    await expect(page.locator('[data-left-column] [data-nested="true"]')).toHaveCount(0)
    await expect(page.locator('[data-left-column] [aria-label*="agents in"]')).toHaveCount(0)
    await team.click()
    await expect(team).toHaveAttribute('aria-current', 'page')
  })
}

for (const theme of WALL_THEMES) {
  test(`D4 all work rows share the same text and icon edges in ${theme}`, async ({ page }) => {
    await openFrame(page, 'sidebar-structure', theme)
    const column = page.locator('#sidebar-structure')
    const rows = column.locator('[data-left-row]:visible:not(:has([data-draggable]))')
    expect(await rows.count()).toBeGreaterThan(3)
    const values = await rows.evaluateAll(nodes => nodes.map(node => {
      const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
      const icon = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!
      const text = button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
      return { h: button.getBoundingClientRect().height, text: text.getBoundingClientRect().x, icon: icon.getBoundingClientRect().x }
    }))
    for (const row of values) expect(row.h).toBe(FRAME.rail.rowHeight)
    for (const field of ['text', 'icon'] as const) {
      const xs = values.map(row => row[field])
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
    }
    const labels = await column.locator('[data-left-group] > [data-slot="group-label"] [data-left-group-text]:visible')
      .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x))
    for (const x of labels) expect(Math.abs(x - values[0].icon)).toBeLessThanOrEqual(1)
    const groupType = await column.locator('[data-left-group] > [data-slot="group-label"] [data-left-group-text]:visible')
      .evaluateAll(nodes => nodes.map(node => ({ size: parseFloat(getComputedStyle(node).fontSize), weight: parseInt(getComputedStyle(node).fontWeight, 10) })))
    for (const group of groupType) { expect(group.size).toBe(FRAME.rail.label); expect(group.weight).toBe(FRAME.rail.groupWeight) }
    await expect(column.locator('[data-nested="true"]')).toHaveCount(0)
    await expect(column.locator('[aria-label*="agents in"]')).toHaveCount(0)
  })
}

for (const theme of WALL_THEMES) {
  test(`D4 trailing substitution and keyboard menus in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const column = page.locator('[data-left-column]:visible')
    const project = column.getByRole('button', { name: 'atlas', exact: true })
    const projectRow = project.locator('..')
    await page.mouse.move(0, 0)
    await expect(projectRow.locator('[data-left-mark]')).toBeVisible()
    await project.hover()
    await expect(projectRow.getByRole('button', { name: 'New session in atlas', exact: true })).toBeVisible()
    await expect(projectRow.locator('[data-left-mark]')).toBeHidden()
    await expect(projectRow.getByRole('button', { name: 'Actions for atlas', exact: true })).toHaveCount(0)
    await project.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    await project.focus()
    await project.dispatchEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    const session = column.getByRole('button', { name: 'Release notes', exact: true })
    expect((await session.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await session.hover()
    const more = session.locator('..').getByRole('button', { name: 'Actions for Release notes', exact: true })
    await expect(more).toBeVisible()
    await session.focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    await session.focus()
    await session.dispatchEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })
    await expect(page.getByRole('menu').last()).toBeVisible()
    await page.keyboard.press('Escape')
    await session.hover()
    await more.click()
    await page.getByRole('menuitem', { name: /^Rename/ }).click()
    const rename = column.locator('[data-left-rename]')
    expect((await rename.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await rename.locator('input').press('Escape')
    expect((await session.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
  })
}


for (const theme of WALL_THEMES) {
  test(`D4 work catalogue uses the same regions and fixed rename in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work-pattern', theme)
    const column = page.locator('[data-left-column]')
    const rows = column.locator('[data-left-row]')
    await expect(rows).toHaveCount(2)
    const ordinary = rows.filter({ hasNot: page.locator('[data-draggable]') })
    const project = rows.filter({ has: page.locator('[data-draggable]') })
    const iconX = (await ordinary.locator('[data-slot="sidebar-menu-icon"]').boundingBox())!.x
    expect((await project.locator('[data-slot="sidebar-menu-label-content"]').boundingBox())!.x,
      'project name starts at the ordinary icon edge').toBe(iconX)
    expect((await ordinary.locator('[data-slot="sidebar-menu-label-content"]').boundingBox())!.x - iconX,
      'ordinary row text keeps its icon and gap').toBe(FRAME.rail.icon + FRAME.rail.gap)
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    expect((await column.locator('[data-left-rename]').boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    expect((await column.getByRole('textbox', { name: 'Rename example' }).boundingBox())!.height).toBe(FRAME.rail.rowHeight)
    await expect(column).toContainText('No conversations yet')
  })
}

for (const theme of WALL_THEMES) {
  for (const foundation of ['desk', 'studio'] as const) {
  for (const destination of ['conversation', 'settings-navigation']) {
    for (const width of [200, 239, 240, FRAME.sidebar.width, 360]) {
      test(`D7 ${destination} left width ${width} in ${theme}/${foundation}`, async ({ page }) => {
        await openFrame(page, `frame-wall=${destination}`, theme)
        await page.locator('body').evaluate((body, value) => { body.dataset.hdInterface = value }, foundation)
        await page.evaluate(value => {
          (window as Window & { __hdFrameWall: { resizeLeft: (width: number) => void } }).__hdFrameWall.resizeLeft(value)
        }, width)
        const column = page.locator('[data-left-column]:visible')
        await expect(column).toHaveCount(1)
        const region = destination === 'settings-navigation' ? page.locator('[data-app-window-left]:visible') : column
        await expect.poll(async () => Math.abs((await region.boundingBox())!.width - width)).toBeLessThanOrEqual(1)
        const history = column.locator('[data-left-history]')
        if (width < 240) await expect(history).toBeHidden()
        else await expect(history).toBeVisible()
        const top = (await column.locator('[data-left-top] [data-slot="bar"]').boundingBox())!
        expect(top.height).toBe(FRAME.bar.height)
        const geometry = await column.locator('[data-left-row]:not([data-left-project]):visible').evaluateAll(nodes => nodes.map(node => {
          const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
          return { height: button.getBoundingClientRect().height,
            text: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!.getBoundingClientRect().x,
            icon: button.querySelector<HTMLElement>('[data-slot="sidebar-menu-icon"]')!.getBoundingClientRect().x }
        }))
        expect(geometry.length).toBeGreaterThan(2)
        for (const row of geometry) expect(row.height).toBe(FRAME.rail.rowHeight)
        for (const field of ['text', 'icon'] as const) {
          const xs = geometry.map(row => row[field])
          expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(1)
        }
        const seat = column.locator('[data-left-seat]')
        expect((await seat.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
        await expect(seat.getByRole('button', { name: 'Settings', exact: true }))
          .toHaveAttribute('aria-pressed', destination === 'settings-navigation' ? 'true' : 'false')
      })
    }
  }
  }
}

for (const theme of WALL_THEMES) {
  test(`D7 Settings opened from the work float restores its own lead in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, 720)
    await page.locator('[data-slot="top-bar"]').getByRole('button', { name: 'Show sidebar', exact: true }).click()
    await page.locator('[data-left-column]:visible [data-left-seat]').getByRole('button', { name: 'Settings', exact: true }).click()
    const modal = page.locator('[data-slot="app-window"]:visible')
    const column = modal.locator('[data-left-column]:visible')
    await expect(column).toBeVisible()
    await column.locator('[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))').click()
    await page.keyboard.press('Escape')
    await expect(column).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(column).toBeHidden()
    await expect(modal.getByRole('button', { name: 'Show sidebar', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
  })
}

// D8 is the app-frame left-column repair lane. These cases use the assembled
// Sidebar and synthetic preview stores, including Settings mode.
for (const theme of WALL_THEMES) {
  for (const mode of ['conversation', 'settings-navigation'] as const) {
    test(`D8 column brand row stays between the top row and navigation in ${mode} in ${theme}`, async ({ page }) => {
      await openFrame(page, `frame-wall=${mode}`, theme)
      const column = page.locator('[data-left-column]:visible').first()
      const top = column.locator('[data-left-top]')
      const brand = column.locator('[data-left-brand]')
      await expect(brand).toContainText('HarnessDesk')
      expect(await top.evaluate((node, next) => node.nextElementSibling === next, await brand.elementHandle())).toBe(true)
      expect(await brand.locator('svg').getAttribute('height')).toBe('14')
      await expect(brand).toHaveClass(/hd-drag/)
      const nextRow = mode === 'conversation'
        ? column.getByRole('button', { name: 'New session', exact: true })
        : column.locator('[data-left-settings]').getByRole('button', { name: 'Back', exact: true })
      expect(await brand.evaluate((node, next) => Boolean(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING), await nextRow.elementHandle())).toBe(true)
    })
  }

  test(`D8 column bars meet without hairlines in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible').first()
    await expect(column.locator('[data-left-top] [data-slot="bar"]')).not.toHaveAttribute('data-rule', 'bottom')
    await expect(column.locator('[data-left-seat]').locator('..')).not.toHaveAttribute('data-rule', 'top')
  })

  test(`D8 column scrolling has no permanent scrollbar in normal and Settings mode in ${theme}`, async ({ page }) => {
    for (const mode of ['conversation', 'settings-navigation'] as const) {
      await openFrame(page, `frame-wall=${mode}`, theme)
      const body = page.locator('[data-left-column]:visible [data-region="sidebar-content"]:visible').first()
      await expect(body).toBeVisible()
      expect(await body.evaluate(node => getComputedStyle(node).scrollbarWidth)).toBe('none')
    }
  })

  test(`D8 project heading controls share the rows trailing edge in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=left-work', theme)
    const column = page.locator('[data-left-column]:visible').first()
    const headerAction = column.locator('[data-left-projects-head] button[aria-label="Open a project folder"]')
    const projectSlot = column.locator('[data-left-row][data-left-project] [data-left-trailing]').first()
    const sessionSlot = column.locator('[data-region="session-tree"] [data-left-trailing]').first()
    const newSessionMenu = column.locator('button[title="More ways to start"]')
    await expect(headerAction).toBeVisible()
    await expect(projectSlot).toBeVisible()
    await expect(sessionSlot).toBeVisible()
    const edges = await Promise.all([headerAction, projectSlot, sessionSlot, newSessionMenu].map(async node => {
      const box = await node.boundingBox()
      return box!.x + box!.width
    }))
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThanOrEqual(1)
  })

  test(`D8 the seat name truncates with an ellipsis in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme)
    const column = page.locator('[data-left-column]:visible').first()
    const name = column.locator('[data-left-seat] [data-role="subject"] span')
    await expect(name).toHaveText('HarnessDesk')
    expect(await name.evaluate(node => getComputedStyle(node).textOverflow)).toBe('ellipsis')
  })

  test(`D8 only the current destination stays selected in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=agents', theme)
    const column = page.locator('[data-left-column]:visible').first()
    const current = column.locator('[data-left-row] [aria-current="page"]')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('aria-label', 'Agents')
    await expect(column.locator('[data-region="session-tree"] [aria-current="page"]')).toHaveCount(0)
  })

  test(`D8 the first Settings group has breathing room below search in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-navigation', theme)
    const column = page.locator('[data-left-column]:visible').first()
    const search = column.getByRole('searchbox', { name: 'Search settings' })
    const general = column.locator('[data-left-settings] [data-left-group-text]').first()
    const searchBox = (await search.boundingBox())!
    const generalBox = (await general.boundingBox())!
    expect(generalBox.y - searchBox.y - searchBox.height).toBeGreaterThanOrEqual(12)
  })

  test(`D8 Settings notices leave the Access rows clear in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=settings-navigation&frame-sidebar-notice=1', theme)
    const column = page.locator('[data-left-column]:visible').first()
    await expect(column.locator('[data-slot="notice-card"]')).toHaveCount(0)
    const body = column.locator('[data-region="sidebar-content"]:visible').first()
    await body.evaluate(node => { node.scrollTop = node.scrollHeight })
    const browser = column.locator('[data-left-settings]').getByRole('button', { name: 'Browser', exact: true })
    await expect(browser).toBeVisible()
    const rowBox = (await browser.boundingBox())!
    const footerBox = (await column.locator('[data-region="sidebar-footer"]').boundingBox())!
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(footerBox.y + 1)
  })

}

test('D8 Search stays in the window top row when the column is hidden', async ({ page }) => {
  await openFrame(page, 'frame-wall=conversation&frame-sidebar-hidden=1', 'light')
  await expect(page.locator('[data-left-column]:visible')).toHaveCount(0)
  const top = page.locator('[data-slot="top-bar"]:visible').first()
  await expect(top.getByRole('button', { name: 'Search everything', exact: true })).toBeVisible()
})

// D7a is additive. Measure painted list content, rather than the containing
// backgrounds and hit targets, whose inset deliberately precedes their ink.
const d7a = test.extend({})
d7a.use({ screenshot: 'off', trace: 'off' })
d7a.describe('D7a heading disclosure', () => {
  for (const theme of WALL_THEMES) for (const width of WALL_WIDTHS) {
    for (const mode of ['left-work', 'settings-navigation'] as const) {
      d7a(`D7a ${mode} list ink respects the gutter and disclosures follow names at ${width} in ${theme}`, async ({ page }) => {
        await openFrame(page, `frame-wall=${mode}`, theme, width)
        await applyLeftColumnActions(page, { leftOpen: true })
        const column = page.locator('[data-left-column]:visible')
        // Include the default and both clamp endpoints in standing and floating modes.
        for (const leftWidth of [256, 200, 360]) {
          await applyLeftColumnActions(page, { leftOpen: true, leftWidth })
          await column.evaluate(node => { if (node.contains(document.activeElement)) (document.activeElement as HTMLElement).blur() })
          await page.mouse.move(width - 1, 899)
          const gutter = await column.evaluate(node => node.getBoundingClientRect().left) + 16
          const escaped = await column.evaluate((column, gutter) => {
            const visible = (node: Element) => {
              for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
                const css = getComputedStyle(ancestor)
                if (css.display === 'none' || css.visibility !== 'visible' || css.opacity === '0') return false
              }
              return node.getBoundingClientRect().width > 0
            }
            const failures: { text: string; x: number }[] = []
            for (const root of column.querySelectorAll('[data-region="sidebar-content"], nav[aria-label="Workspace actions"], [data-left-head]')) {
              for (const node of root.querySelectorAll('svg, img')) {
                if (visible(node) && node.getBoundingClientRect().left < gutter) failures.push({ text: node.getAttribute('data-slot') ?? node.tagName, x: node.getBoundingClientRect().left })
              }
              const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
              while (walker.nextNode()) {
                const text = walker.currentNode
                if (!text.textContent?.trim() || !text.parentElement || !visible(text.parentElement) || text.parentElement.closest('svg')) continue
                const range = document.createRange(); range.selectNodeContents(text)
                const box = range.getBoundingClientRect()
                if (box.width && box.left < gutter) failures.push({ text: text.textContent, x: box.left })
              }
            }
            return failures
          }, gutter)
          expect(escaped, `${mode}/${leftWidth}: every visible list glyph and text starts at the gutter or later`).toEqual([])
          if (mode === 'settings-navigation') continue
          const headings = column.locator('[data-slot="sidebar-menu-button"][aria-expanded]')
          expect(await headings.count()).toBeGreaterThan(2)
          for (const heading of await headings.all()) {
            const arrow = heading.locator('[data-slot="disclosure-chevron"]')
            const name = heading.locator('[data-left-fold-name]')
            const row = heading.locator('..')
            const action = row.locator('[data-slot="sidebar-menu-action"]')
            const open = await heading.getAttribute('aria-expanded') === 'true'
            if (open) await expect(arrow).toBeHidden()
            else await expect(arrow).toBeVisible()
            await row.hover()
            await expect(arrow).toBeVisible()
            if (await action.count()) await expect(action).toBeVisible()
            const measured = await heading.evaluate(heading => {
              const name = heading.querySelector('[data-left-fold-name]')!
              const range = document.createRange(); range.selectNodeContents(name)
              const arrow = heading.querySelector('[data-slot="disclosure-chevron"]')!.getBoundingClientRect()
              const box = name.getBoundingClientRect()
              return { name: box.left, arrow: arrow.left, end: Math.min(range.getBoundingClientRect().right, box.right), right: arrow.right }
            })
            expect(measured.name).toBe(gutter)
            expect(measured.arrow - measured.end).toBeGreaterThanOrEqual(0)
            expect(measured.arrow - measured.end).toBeLessThanOrEqual(10)
            if (await action.count()) expect(measured.right).toBeLessThanOrEqual((await action.boundingBox())!.x)
            if (leftWidth === 256) console.log(`D7a ${width}/${theme} ${await name.textContent()}: gutter=${gutter}, name=${measured.name}, arrow=${measured.arrow}`)
            // Traverse the real tree with arrow keys to return keyboard focus
            // to this heading, including headings outside the sole Tab stop.
            await page.mouse.move(width - 1, 899)
            await heading.focus()
            await page.keyboard.press('ArrowUp')
            await page.keyboard.press('ArrowDown')
            await expect(heading).toBeFocused()
            expect(await heading.evaluate(node => node.matches(':focus-visible'))).toBe(true)
            await expect(arrow).toBeVisible()
            if (await action.count()) await expect(action).toBeVisible()
            // End keyboard focus before testing a fresh pointer focus. A click
            // on the already keyboard-focused button retains focus-visible.
            await heading.evaluate(node => (node as HTMLElement).blur())
            await name.click()
            await expect(heading).toHaveAttribute('aria-expanded', String(!open))
            await arrow.click()
            await expect(heading).toHaveAttribute('aria-expanded', String(open))
            await page.mouse.move(width - 1, 899)
            if (open) await expect(arrow).toBeHidden()
            else await expect(arrow).toBeVisible()
            if (await action.count()) await expect(action).toBeHidden()
            await heading.evaluate(node => (node as HTMLElement).blur())
          }
          // Truncate an actual project label in-place without changing its action or semantics.
          const project = column.locator('[data-project-root] button[data-draggable]').first()
          const name = project.locator('[data-left-fold-name]')
          const original = await name.textContent()
          await name.evaluate(node => { node.textContent = 'A deliberately long project name · 長い名前'.repeat(4) })
          await project.hover()
          await expect(project.locator('[data-slot="disclosure-chevron"]')).toBeVisible()
          const long = await project.evaluate(node => {
            const name = node.querySelector<HTMLElement>('[data-left-fold-name]')!
            const arrow = node.querySelector('[data-slot="disclosure-chevron"]')!.getBoundingClientRect()
            const action = node.parentElement!.querySelector('[data-slot="sidebar-menu-action"]')!.getBoundingClientRect()
            return { truncated: name.scrollWidth > name.clientWidth, end: name.getBoundingClientRect().right, arrow: arrow.left, right: arrow.right, action: action.left }
          })
          expect(long.truncated).toBe(true)
          expect(long.arrow - long.end).toBeGreaterThanOrEqual(0)
          expect(long.arrow - long.end).toBeLessThanOrEqual(10)
          expect(long.right).toBeLessThanOrEqual(long.action)
          await name.evaluate((node, value) => { node.textContent = value }, original!)
          await project.click({ button: 'right' })
          await expect(page.getByRole('menu')).toBeVisible()
          await expect(page.getByRole('menuitem', { name: /^(Pin|Unpin)$/ })).toBeVisible()
          await page.keyboard.press('Escape')
        }
        if (mode === 'left-work') {
          const project = column.locator('[data-project-root] button[data-draggable]').first()
          const action = project.locator('..').locator('[data-slot="sidebar-menu-action"]')
          await applyLeftColumnActions(page, { leftOpen: true, leftWidth: 256, leftHeading: 'hover-open' })
          await expect(action).toBeVisible()
          await applyLeftColumnActions(page, { leftOpen: true, leftHeading: 'folded' })
          await expect(action).toBeHidden()
        }
      })
    }
  }
})
