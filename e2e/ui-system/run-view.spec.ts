import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`Run timeline ordering, selection fill and narrow geometry in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const running = page.locator('#run-view-running [data-slot="run-view"]')
    await expect(running).toBeVisible()
    expect(await running.locator('[data-kind]').evaluateAll(rows => rows.map(row => row.getAttribute('data-kind')))).toEqual(['start', 'brief', 'round', 'card', 'round', 'check', 'round', 'card', 'findings', 'round', 'card'])
    const selected = running.locator('[data-row="card-3-3"]')
    await selected.click()
    await expect(selected).toHaveAttribute('aria-current', 'true')
    const colors = await selected.evaluate(el => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--hd-selected)'
      el.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { fill: getComputedStyle(el).backgroundColor, expected }
    })
    expect(colors.fill).toBe(colors.expected)
    const narrow = page.locator('#run-view-narrow [data-slot="run-view"]')
    const geometry = await narrow.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, overflowing: [...el.querySelectorAll('[data-row]')].some(row => row.scrollWidth > row.clientWidth + 1) }))
    expect(geometry.width).toBeLessThan(400)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1)
    expect(geometry.overflowing).toBe(false)
    const leadDeltas = await narrow.locator('[data-row]:has([data-slot="list-row-lead"])').evaluateAll(rows => rows.map(row => {
      const lead = row.querySelector('[data-slot="list-row-lead"]')!.getBoundingClientRect()
      const walker = document.createTreeWalker(row.querySelector('[data-slot="list-row-title"]')!, NodeFilter.SHOW_TEXT)
      walker.nextNode()
      const range = document.createRange()
      range.selectNodeContents(walker.currentNode)
      const line = range.getClientRects()[0]!
      return Math.abs((lead.top + lead.bottom - line.top - line.bottom) / 2)
    }))
    expect(leadDeltas.every(delta => delta < 1.5)).toBe(true)
    await expect(narrow.getByText('Editing src/checkout/retry.ts')).toBeVisible()
    await expect(page.locator('#run-view-settled')).toContainText('Ended without a next step')
    await expect(page.locator('#run-view-stopped [data-slot="run-header"]')).toContainText('Stopped')
    await expect(page.locator('#run-view-stopped [data-slot="run-ending"]')).toContainText('By you')
    await expect(page.locator('#run-view-stalled')).toContainText('The desk stopped while the check ran')
    await expect(page.locator('#run-view-person')).toContainText('Needs you')
    await expect(page.locator('#run-view-pending')).toContainText('Reading checks and findings')
    await expect(page.locator('#run-view-failed')).toContainText('Some Run details could not be read')
    await expect(page.locator('#run-view-empty')).toContainText('No rounds have opened yet')
    await expect(page.locator('#run-view-findings [data-kind="findings"]')).toContainText('2 findings')
    await expect(page.locator('#run-view-findings [data-kind="findings"]')).toContainText('Repair accepted by reviewer')
    await expect(page.locator('#run-view-findings [data-row="round-3"]')).toContainText('1 of 1 answered')
    const many = page.locator('#run-view-many [data-slot="run-scroll"]')
    expect(await many.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const rig = page.locator('#run-view-team')
    await rig.getByRole('button', { name: 'Run 1', exact: true }).click()
    await expect(rig.locator('[data-slot="run-view"]')).toBeVisible()
    await expect(rig.locator('[data-slot="run-ending"]')).toContainText('Ended without a next step')
  })

  test(`Run findings keep damaged history visible at narrow width in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const findings = page.locator('#run-view-damaged-findings [data-kind="findings"]')
    await expect(findings).toContainText('Unreadable · The finding history has a missing sequence.')
    await expect(findings).toContainText('Repair claimed · awaiting review')
    await expect(findings).toContainText('Repair accepted by reviewer')
    const detail = findings.locator('[data-slot="run-detail"]')
    expect(await detail.evaluate(el => ({ clipped: el.scrollHeight > el.clientHeight + 1,
      overflow: el.scrollWidth > el.clientWidth + 1 }))).toEqual({ clipped: false, overflow: false })
  })

  test(`selected Run chips retain readable ink and a visible boundary in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const selected = page.locator('#run-view-many [data-row="card-3-3"]')
    await selected.click()
    const ratios = await selected.evaluate(row => {
      const chip = row.querySelector('[data-slot="chip"]')!
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')!
      const rgba = (color: string) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        return Array.from(ctx.getImageData(0, 0, 1, 1).data)
      }
      const over = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * front[3]! / 255 + back[i]! * (1 - front[3]! / 255))
      const ground = (el: Element) => {
        const chain: Element[] = []
        for (let parent: Element | null = el; parent; parent = parent.parentElement) chain.unshift(parent)
        return chain.reduce((bg, one) => over(rgba(getComputedStyle(one).backgroundColor), bg), [255, 255, 255])
      }
      const luminance = (rgb: number[]) => rgb.map(v => {
        v /= 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
      const contrast = (a: number[], b: number[]) => {
        const high = Math.max(luminance(a), luminance(b))
        const low = Math.min(luminance(a), luminance(b))
        return (high + 0.05) / (low + 0.05)
      }
      const style = getComputedStyle(chip)
      const fill = ground(chip)
      const rowFill = ground(row)
      const edgeColor = style.boxShadow.match(/(?:rgba?|color)\([^)]*\)/)?.[0]
      return { ink: contrast(over(rgba(style.color), fill), fill),
        boundary: Math.max(contrast(fill, rowFill), edgeColor ? contrast(over(rgba(edgeColor), rowFill), rowFill) : 1) }
    })
    expect(ratios.ink).toBeGreaterThanOrEqual(4.5)
    expect(ratios.boundary).toBeGreaterThanOrEqual(3)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Run commands shorten home paths across Flow, Steps, Timeline and inspector in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const flow = page.locator('#run-view-live-polish-flow')
    const raw = 'PATH=/usr/bin:/home/dev/bin node /home/dev/tools/land.mjs --check'
    const shown = 'PATH=/usr/bin:~/bin node ~/tools/land.mjs --check'
    for (const selector of ['[data-step="verify"]', '[data-step-row="verify"]']) {
      await expect(flow.locator(selector)).toContainText(shown)
      await expect(flow.locator(selector).locator('[title]').filter({ hasText: shown })).toHaveAttribute('title', raw)
    }
    await flow.getByRole('radio', { name: 'Timeline', exact: true }).click()
    const check = flow.locator('[data-row="check-2-2"]')
    await expect(check).toContainText(shown)
    await expect(check.locator('[title]').filter({ hasText: shown })).toHaveAttribute('title', raw)
    await check.click()
    await expect(flow.locator('[data-slot="run-inspector"]')).toContainText(shown)
    await expect(flow.locator('[data-slot="run-inspector"] [title]').filter({ hasText: shown })).toHaveAttribute('title', raw)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`seat ceiling words appear in the Team rail and Flow step in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const flow = page.locator('#run-view-live-polish-flow')
    await expect(flow.locator('[data-step-row="writer"]')).toContainText('Edit · asked, not enforced')
    const ceiling = flow.locator('[data-step="writer"] [data-role="meta"]')
    expect(await ceiling.evaluate(el => ({ clipped: el.scrollWidth > el.clientWidth + 1,
      outside: el.getBoundingClientRect().bottom > el.closest('[data-slot="flow-step"]')!.getBoundingClientRect().bottom })))
      .toEqual({ clipped: false, outside: false })
    await expect(flow.locator('[data-step="reviewer"]')).toContainText('Read only')
    await expect(flow.locator('[data-step="reviewer"] [title]').filter({ hasText: 'Read only' }))
      .toHaveAttribute('title', 'Changes nothing: it reads, searches and reports.')
    const rail = page.locator('#run-view-live-polish-team')
    await expect(rail.locator('[data-ceiling="edit"]')).toHaveText('Edit · asked, not enforced')
    await expect(rail.locator('[data-ceiling="read"]')).toHaveText('Read only')
  })
}
