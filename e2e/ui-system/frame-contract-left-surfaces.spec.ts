import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { openFrame, resolvedPx } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()



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
