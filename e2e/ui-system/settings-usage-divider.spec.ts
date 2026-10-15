import { expect, test } from '@playwright/test'

/**
 * UsageSection's meters and Credits share the canonical Rows card. The
 * section's jsdom test covers that anatomy, but cannot see the separator:
 * Row draws it with ::after, rather than a border (#854). Measure the real
 * production section already mounted by the account-usage preview frame.
 */
for (const foundation of ['desk', 'studio'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Usage meters stay separated from Credits in ${foundation} ${theme}`, async ({ page }, testInfo) => {
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'interface', exact: true }).selectOption(foundation)
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      await expect.poll(() => page.locator('body').getAttribute('data-hd-interface')).toBe(foundation === 'desk' ? null : foundation)
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')

      const frame = page.locator('[data-frame-id="settings-account-usage"]')
      const rows = frame.locator('[data-slot="row"]')
      await expect(rows).toHaveCount(3)
      await expect(rows.nth(0).getByRole('progressbar', { name: '5-hour remaining', exact: true })).toBeVisible()
      await expect(rows.nth(1).getByRole('progressbar', { name: 'Weekly remaining', exact: true })).toBeVisible()
      await expect(rows.nth(2)).toContainText('Credits')
      await expect(rows.nth(2)).toContainText('5 credits')
      await frame.scrollIntoViewIfNeeded()
      await page.evaluate(async () => { await document.fonts.ready })

      const reading = await rows.nth(1).evaluate((meterRow, foundation) => {
        const credits = meterRow.nextElementSibling!
        const card = meterRow.parentElement!
        const rowCss = getComputedStyle(meterRow)
        const separator = getComputedStyle(meterRow, '::after')
        const rect = meterRow.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        const creditsRect = credits.getBoundingClientRect()

        // Resolve the foundation's intended color in the browser as well:
        // Desk uses the border fallback; Studio supplies its stronger divider.
        const probe = document.createElement('span')
        probe.style.backgroundColor = `var(${foundation === 'desk' ? '--hd-border' : '--hd-card-divider'})`
        meterRow.append(probe)
        const expectedColor = getComputedStyle(probe).backgroundColor
        probe.remove()

        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = separator.backgroundColor
        context.fillRect(0, 0, 1, 1)
        const alpha = context.getImageData(0, 0, 1, 1).data[3]!
        let opacity = Number(separator.opacity)
        for (let ancestor: Element | null = meterRow; ancestor; ancestor = ancestor.parentElement) {
          opacity *= Number(getComputedStyle(ancestor).opacity)
        }

        return {
          color: separator.backgroundColor,
          expectedColor,
          alpha,
          opacity,
          content: separator.content,
          display: separator.display,
          visibility: separator.visibility,
          position: separator.position,
          left: separator.left,
          right: separator.right,
          bottom: separator.bottom,
          width: parseFloat(separator.width),
          height: parseFloat(separator.height),
          expectedHeight: parseFloat(rowCss.getPropertyValue('--hd-border-width')),
          rowWidth: rect.width,
          boundaryGap: creditsRect.top - rect.bottom,
          sameCard: credits.parentElement === card,
          insideCard: rect.left >= cardRect.left && rect.right <= cardRect.right && rect.bottom < cardRect.bottom,
          insideViewport: rect.bottom > 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
          creditsSeparator: getComputedStyle(credits, '::after').display,
        }
      }, foundation)

      await testInfo.attach('separator-reading', { body: JSON.stringify(reading, null, 2), contentType: 'application/json' })
      console.log(`${foundation} ${theme}: ${JSON.stringify(reading)}`)
      expect(reading.color, 'the separator uses its foundation color').toBe(reading.expectedColor)
      expect(reading.alpha, 'the separator paints visible ink').toBeGreaterThan(0)
      expect(reading.opacity, 'the separator and its ancestors are visible').toBeGreaterThan(0)
      expect(reading.content).toBe('""')
      expect(reading.display).not.toBe('none')
      expect(reading.visibility).toBe('visible')
      expect(reading.position).toBe('absolute')
      expect([reading.left, reading.right, reading.bottom]).toEqual(['0px', '0px', '0px'])
      expect(reading.expectedHeight).toBeGreaterThan(0)
      expect(reading.height).toBe(reading.expectedHeight)
      expect(reading.width).toBeCloseTo(reading.rowWidth, 1)
      expect(reading.boundaryGap).toBeCloseTo(0, 1)
      expect(reading.sameCard).toBe(true)
      expect(reading.insideCard).toBe(true)
      expect(reading.insideViewport).toBe(true)
      expect(reading.creditsSeparator, 'Credits is the last row, with no trailing separator').toBe('none')
      await frame.screenshot({ path: testInfo.outputPath(`usage-divider-${foundation}-${theme}.png`) })
    })
  }
}
