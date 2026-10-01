import { expect, test } from '@playwright/test'

/**
 * The terminal's bottom edge carries nothing off the theme's background
 * (#1169). xterm lays out whole rows, so a dock height that is not a multiple
 * of the row height leaves a strip under the last row; xterm 6's stylesheet
 * painted that strip black, a bar under the prompt in either theme. Measured,
 * not looked at: every point of the strip, at several heights, must land on
 * paint the colour of the theme's background.
 */
for (const scheme of ['light', 'dark'] as const) {
  test(`the terminal's bottom edge is the theme's background in ${scheme}, at any dock height`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/preview.html')
    const terminal = page.locator('.xterm').first()
    await terminal.waitFor()
    await terminal.scrollIntoViewIfNeeded()

    const strips: number[] = []
    for (const height of [201, 263, 300]) {
      const before = await terminal.evaluate((xterm) => xterm.querySelector('.xterm-scrollable-element')!.getBoundingClientRect().height)
      // The pane's own host decides the height xterm fits itself into.
      await terminal.evaluate((xterm, px) => {
        const host = xterm.parentElement!
        host.style.flex = 'none'
        host.style.height = `${px}px`
      }, height)
      // Wait for xterm's own refit: its rows have moved off the last height, fit inside the new one, and leave less
      // than one row over. Each step changes the height by more than a row, so stale geometry cannot pass.
      await expect.poll(() => terminal.evaluate((xterm, previous) => {
        const rows = xterm.querySelector('.xterm-scrollable-element')!.getBoundingClientRect()
        const count = xterm.querySelectorAll('.xterm-rows > div').length
        const row = count > 0 ? rows.height / count : Infinity
        const box = xterm.getBoundingClientRect()
        return rows.height !== previous && rows.height <= box.height && box.height - rows.height < row
      }, before)).toBe(true)
      const found = await terminal.evaluate((xterm) => {
        const themed = xterm.querySelector('.xterm-scrollable-element')!
        const expected = getComputedStyle(themed).backgroundColor
        const box = xterm.getBoundingClientRect()
        const rows = themed.getBoundingClientRect()
        const paintAt = (x: number, y: number): string => {
          for (const element of document.elementsFromPoint(x, y)) {
            const colour = getComputedStyle(element).backgroundColor
            if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') return colour
          }
          return 'none'
        }
        const off: string[] = []
        // The strip between the last row and the pane's bottom, clear of the vertical scrollbar on the right.
        for (let y = Math.ceil(rows.bottom); y < Math.floor(box.bottom); y += 1) {
          for (let x = box.left + 2; x < box.right - 16; x += 40) {
            const colour = paintAt(x, y)
            if (colour !== expected) off.push(`${Math.round(x)},${y}: ${colour}`)
          }
        }
        return { expected, strip: Math.floor(box.bottom) - Math.ceil(rows.bottom), off: off.slice(0, 5) }
      })
      expect(found.off, `at ${height}px the ${found.strip}px strip under the last row is not ${found.expected}`).toEqual([])
      strips.push(found.strip)
    }
    // An empty strip at every height would measure nothing: at least one height must leave one to check.
    expect(Math.max(...strips), `no dock height left a strip to measure: ${strips.join(', ')}`).toBeGreaterThan(0)

    // A palette switch with the terminal open: xterm's rows and the viewport under them move together.
    await page.evaluate(() => document.body.setAttribute('data-hd-palette', 'editorial'))
    await expect.poll(() => terminal.evaluate((xterm) => {
      const rows = getComputedStyle(xterm.querySelector('.xterm-scrollable-element')!).backgroundColor
      const viewport = getComputedStyle(xterm.querySelector('.xterm-viewport')!).backgroundColor
      const surface = getComputedStyle(document.body).getPropertyValue('--hd-surface-fill').trim()
      return { same: rows === viewport, moved: surface !== '' }
    })).toEqual({ same: true, moved: true })
  })
}
