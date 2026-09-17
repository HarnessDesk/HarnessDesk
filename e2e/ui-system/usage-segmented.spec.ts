import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 980]) {
    test(`dashboard account rows keep their padding and contents at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
      const accounts = dashboard.locator('nav button[class*="acct_"]')
      await expect(accounts.first()).toBeVisible()
      expect(await accounts.count()).toBeGreaterThan(3)
      await accounts.first().scrollIntoViewIfNeeded()
      const measurements = await accounts.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect()
        const css = getComputedStyle(node)
        const name = node.querySelector('[class*="acctName"]')!.getBoundingClientRect()
        const meter = node.querySelector('[class*="acctTrack"]')?.getBoundingClientRect()
        return {
          label: node.textContent,
          height: box.height,
          paddingTop: parseFloat(css.paddingTop),
          paddingBottom: parseFloat(css.paddingBottom),
          fontSize: css.fontSize,
          meter: meter ? { width: meter.width, rowWidth: box.width, gap: meter.top - name.bottom } : null,
          contents: [...node.children].map(child => {
            const rect = child.getBoundingClientRect()
            return { top: rect.top - box.top, bottom: box.bottom - rect.bottom }
          }),
        }
      }))
      await testInfo.attach('account-layout', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await dashboard.locator('nav').screenshot({ path: testInfo.outputPath('accounts.png') })
      for (const row of measurements) {
        expect.soft(row.paddingTop, row.label ?? '').toBeGreaterThanOrEqual(4)
        expect.soft(row.paddingBottom, row.label ?? '').toBeGreaterThanOrEqual(4)
        expect.soft(row.height, row.label ?? '').toBeGreaterThanOrEqual(26)
        if (row.meter) {
          expect.soft(row.meter.width).toBeGreaterThan(row.meter.rowWidth / 2)
          expect.soft(row.meter.gap).toBeGreaterThanOrEqual(3)
        }
        for (const content of row.contents) {
          expect.soft(content.top).toBeGreaterThanOrEqual(4)
          expect.soft(content.bottom).toBeGreaterThanOrEqual(4)
        }
      }
      await accounts.nth(1).click()
      await expect(accounts.nth(1)).toHaveAttribute('data-selected', '')
      await expect.poll(() => accounts.nth(1).evaluate(node => getComputedStyle(node).backgroundColor))
        .not.toBe('rgba(0, 0, 0, 0)')
      await expect(accounts.first()).not.toHaveAttribute('data-selected')
    })

    test(`permission segments contain unequal labels at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/preview.html')
      await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
      await page.getByRole('combobox', { name: 'settings page', exact: true }).selectOption('permissions')
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      const reviewers = settings.getByRole('radiogroup', { name: 'Reviewed by', exact: true })
      await expect(reviewers.getByRole('radio')).toHaveCount(3)
      await reviewers.scrollIntoViewIfNeeded()
      const measurements = await settings.locator('[data-slot="toggle-group-item"]').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(node)
        const text = range.getBoundingClientRect()
        const css = getComputedStyle(node)
        return {
          label: node.textContent,
          width: box.width,
          height: box.height,
          fontSize: css.fontSize,
          paddingLeft: parseFloat(css.paddingLeft),
          paddingRight: parseFloat(css.paddingRight),
          textLeft: text.left - box.left,
          textRight: box.right - text.right,
        }
      }))
      await testInfo.attach('segment-layout', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await settings.screenshot({ path: testInfo.outputPath('permissions.png') })
      for (const option of measurements) {
        expect.soft(option.textLeft, option.label ?? '').toBeGreaterThanOrEqual(option.paddingLeft - 1)
        expect.soft(option.textRight, option.label ?? '').toBeGreaterThanOrEqual(option.paddingRight - 1)
      }
      await expect(reviewers.getByRole('radio', { name: 'You', exact: true })).toBeChecked()
    })
  }
}

for (const [look, theme] of [
  ['desk', 'light'], ['desk', 'dark'], ['studio', 'light'], ['studio', 'dark'],
] as const) {
  test(`${look} selected account text meets AA in ${theme}`, async ({ page }, testInfo) => {
    // Override fixture data at its module boundary; Usage still renders the
    // real accounts, selection state, tones and no-meter subline.
    await page.route('**/src/preview/sidebar-fixture.ts*', async route => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: `${await response.text()}\n{
          const templates = [...previewUsage];
          previewUsage.splice(0, previewUsage.length, ...[
            ['normal', 22], ['warning', 90], ['bad', 100], ['no-meter', null]
          ].map(([state, usedPercent], index) => ({
            ...templates[index],
            account: state + '@example.com',
            credits: null,
            reached: null,
            lanes: usedPercent === null ? [] : [{ ...templates[index].lanes[0], usedPercent }],
          })));
        }`,
      })
    })
    await page.goto('/preview.html')
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    await page.getByRole('combobox', { name: 'interface', exact: true }).selectOption(look)
    const dashboard = page.getByRole('dialog', { name: 'Dashboard', exact: true })
    for (const state of ['normal', 'warning', 'bad', 'no-meter']) {
      const account = dashboard.locator(`nav button[title$="${state}@example.com"]`)
      await account.click()
      await expect(account).toHaveAttribute('data-selected', '')
      // Wait for the canonical selection-color transition before measuring.
      await account.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
      const measurements = await account.evaluate(node => {
        const context = document.createElement('canvas').getContext('2d')!
        const stack: Element[] = []
        for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) stack.unshift(ancestor)
        const paint = (color: string) => {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
        }
        const luminance = (rgb: Uint8ClampedArray) => {
          const channels = [...rgb].slice(0, 3).map(channel => {
            const value = channel / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
        }
        return [...node.querySelectorAll('[class*="acctMark"], [class*="acctName"], [class*="acctFigure"], [class*="acctSub"]')].map(child => {
          context.clearRect(0, 0, 1, 1)
          for (const ancestor of stack) paint(getComputedStyle(ancestor).backgroundColor)
          const background = luminance(context.getImageData(0, 0, 1, 1).data)
          const color = getComputedStyle(child).color
          paint(color)
          const foreground = luminance(context.getImageData(0, 0, 1, 1).data)
          return {
            part: child.className,
            text: child.textContent,
            color,
            ratio: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
          }
        })
      })
      await testInfo.attach(`selected-${state}`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
      await account.screenshot({ path: testInfo.outputPath(`selected-${state}.png`) })
      for (const measurement of measurements) {
        const minimum = measurement.part.includes('acctMark') ? 3 : 4.5
        expect.soft(measurement.ratio, `${state}: ${measurement.text || 'mark'}`).toBeGreaterThanOrEqual(minimum)
      }
    }
  })
}
