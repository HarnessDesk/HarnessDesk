import { applyLeftColumnActions } from './left-column-actions'
import { expect, test } from '@playwright/test'
import { WALL_THEMES, WALL_WIDTHS } from './frame-wall-destinations'
import { openFrame } from './frame-contract-helpers'
import { useFrameContractEvidence } from './frame-contract-split-setup'

useFrameContractEvidence()


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
