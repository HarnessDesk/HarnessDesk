import { expectTitleRoom } from './title-contract'
import { runBar, selectRunView, stopRun } from './run-frame-actions'
import { expect, test } from '@playwright/test'
import { selectTeamPage, teamBar, teamSeats } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`Run timeline ordering, selection fill and narrow geometry in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
    else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme', '')
    const running = page.locator('#run-view-running [data-slot="run-view"]')
    await expect(running).toBeVisible()
    expect(await running.locator('[data-kind]').evaluateAll(rows => rows.map(row => row.getAttribute('data-kind')))).toEqual(['card', 'check', 'card', 'card'])
    await expect(running.locator('[data-row="start"], [data-row="brief"], [data-kind="round"]')).toHaveCount(0)
    const selected = running.locator('[data-row="card-3-3"]')
    await selected.click()
    await expect(selected).toHaveAttribute('aria-current', 'true')
    const colors = await selected.evaluate(el => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--hd-selected)'
      el.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { fill: getComputedStyle(el.querySelector('[data-slot="timeline-summary"]')!).backgroundColor, expected }
    })
    expect(colors.fill).toBe(colors.expected)
    const narrow = page.locator('#run-view-narrow [data-slot="run-view"]')
    const geometry = await narrow.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, overflowing: [...el.querySelectorAll('[data-row]')].some(row => row.scrollWidth > row.clientWidth + 1) }))
    expect(geometry.width).toBeLessThan(400)
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1)
    expect(geometry.overflowing).toBe(false)
    // The flat Timeline's indicator shares the first title line's centre.
    const leadDeltas = await narrow.locator('[data-step-row]').evaluateAll(rows => rows.map(row => {
      const lead = row.querySelector('[data-slot="timeline-indicator"]')!.getBoundingClientRect()
      const title = row.querySelector('[data-slot="timeline-heading"] button [data-slot="text"]')!
      const range = document.createRange(); range.selectNodeContents(title)
      const line = [...range.getClientRects()].find(rect => rect.height > 0)!
      return Math.abs((lead.top + lead.bottom - line.top - line.bottom) / 2)
    }))
    expect(leadDeltas.length).toBe(5)
    expect(leadDeltas.every(delta => delta < 1.5)).toBe(true)
    await narrow.locator('[data-row="card-4-4"] button').click()
    await expect(page.locator('#run-view-narrow [data-slot="run-inspector"]')).toContainText('Editing src/checkout/retry.ts')
    await expect(page.locator('#run-view-settled')).toContainText('Ended without a next step')
    await expect(stopRun(page.locator('#run-view-stopped'))).toBeDisabled()
    await expect(stopRun(page.locator('#run-view-stopped'))).toHaveAttribute('title', 'This Run is not running')
    await expect(page.locator('#run-view-stopped [data-slot="run-ending"]')).toContainText('By you')
    await expect(page.locator('#run-view-stalled')).toContainText('The desk stopped while the check ran')
    await expect(page.locator('#run-view-person [data-slot="run-need"]')).toContainText('Answer the review')
    await expect(page.locator('#run-view-pending')).toContainText('Reading checks and findings')
    await expect(page.locator('#run-view-failed')).toContainText('Some Run details could not be read')
    await expect(page.locator('#run-view-empty')).toContainText('No rounds have opened yet')
    const findingsFrame = page.locator('#run-view-findings')
    await findingsFrame.locator('[data-row="card-3-3"] button').click()
    const findings = findingsFrame.locator('[data-slot="run-inspector"] [aria-label="Findings"]')
    await expect(findings.getByText('The retry loop needs a ceiling', { exact: true })).toHaveCount(1)
    await expect(findings.getByText('Keep the last failure visible', { exact: true })).toHaveCount(1)
    await expect(findings).toContainText('Repair accepted by reviewer')
    await expect(findingsFrame.locator('[data-slot="run-inspector"] [aria-label="Round 3"]')).toContainText('1 of 1 answered')
    const many = page.locator('#run-view-many [data-slot="run-scroll"]')
    await expect(many).toContainText('Taken 20')
    await page.locator('#run-view-many').evaluate(node => { (node as HTMLElement).style.height = '160px' })
    expect(await many.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    const rig = page.locator('#run-view-team')
    await selectTeamPage(rig,'run')
    await expect(rig.locator('[data-slot="run-view"]')).toBeVisible()
    await expect(rig.locator('[data-slot="run-need"]')).toContainText('Ended without a next step')
  })

  test(`Team body tab names and counts survive narrow and wide windows in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const frame=page.locator('#run-view-team')
    const header = teamBar(frame)
    const tabs = [
      ['overview','Overview','1'], ['run','Run','1'], ['board','Board','4'], ['room','Chat',null], ['findings','Findings',null],
    ] as const
    for (const width of [1440, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expectTitleRoom(header.locator('[data-topbar-title]'))
      await expect(header.getByRole('tab')).toHaveCount(0)
      for (const [value,label,count] of tabs) {
        const tab = frame.locator(`[data-team-page="${value}"]`)
        await expect(tab).toHaveAccessibleName(new RegExp(`^${label}${count===null?'':`\\s*${count}`}$`))
        await expect(tab).toHaveAttribute('data-team-page',value)
      }
      await expect(header.getByRole('tab',{name:'Side by side',exact:true})).toHaveCount(0)
    }
    await selectTeamPage(frame,'run')
    await expect(page.locator('#run-view-team [data-slot="run-view"]')).toBeVisible()
  })

  test(`Run findings keep damaged history visible at narrow width in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const frame = page.locator('#run-view-damaged-findings')
    await frame.locator('[data-row="card-3-3"] button').click()
    const findings = frame.locator('[data-slot="run-inspector"] [aria-label="Findings"]')
    await expect(findings).toContainText('Unreadable')
    await expect(findings).toContainText('The finding history has a missing sequence.')
    await expect(findings).toContainText('Repair claimed · awaiting review')
    await expect(findings).toContainText('Repair accepted by reviewer')
    const detail = findings
    expect(await detail.evaluate(el => ({ clipped: el.scrollHeight > el.clientHeight + 1,
      overflow: el.scrollWidth > el.clientWidth + 1 }))).toEqual({ clipped: false, overflow: false })
  })

  test(`selected Run chips retain readable ink and a visible boundary in ${theme}`, async ({ page }, testInfo) => {
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
      const rowFill = ground(row.querySelector('[data-slot="timeline-summary"]') ?? row)
      const edgeColor = style.boxShadow.match(/(?:rgba?|color)\([^)]*\)/)?.[0]
      return { color: style.color, background: style.backgroundColor, shadow: style.boxShadow, fill, rowFill, ink: contrast(over(rgba(style.color), fill), fill),
        boundary: Math.max(contrast(fill, rowFill), edgeColor ? contrast(over(rgba(edgeColor), rowFill), rowFill) : 1) }
    })
    await testInfo.attach('selected chip contrast', { body: JSON.stringify(ratios), contentType: 'application/json' })
    expect(ratios.ink).toBeGreaterThanOrEqual(4.5)
    expect(ratios.boundary).toBeGreaterThanOrEqual(3)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Run reading measure, state rail and stable page header in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const running = page.locator('#run-view-running')
    const measure = await running.locator('[data-slot="run-reading"]').evaluate(el => {
      const box = el.getBoundingClientRect()
      const scroll = el.closest('[data-slot="run-scroll"]')!.getBoundingClientRect()
      const rowElement = el.querySelector('[data-step-row]')!
      const row = rowElement.getBoundingClientRect()
      const meta = rowElement.querySelector('[data-slot="timeline-detail"]')!.getBoundingClientRect()
      const title = rowElement.querySelector('[data-slot="timeline-heading"]')!.getBoundingClientRect()
      return { width: box.width, column: Number.parseFloat(getComputedStyle(el).getPropertyValue('--hd-column')),
        gutter: title.left - box.left, centre: (box.left + box.right - scroll.left - scroll.right) / 2,
        metaBelowTitle: meta.top >= title.bottom }
    })
    expect(measure.width).toBe(measure.column)
    expect(measure.gutter).toBe(32)
    expect(Math.abs(measure.centre)).toBeLessThan(1)
    expect(measure.metaBelowTitle).toBe(true)
    await expect(running.locator('[data-row="card-4-4"] [data-slot="run-time"]')).toContainText('so far')
    await expect(running.locator('[data-row="check-2-2"] [data-slot="run-time"]')).not.toContainText('so far')
    const stalled = page.locator('#run-view-stalled')
    const needBox = await stalled.locator('[data-slot="run-need"]').boundingBox()
    const readingBox = await stalled.locator('[data-slot="run-reading"]').boundingBox()
    expect(needBox!.x).toBe(readingBox!.x)
    expect(needBox!.width).toBe(readingBox!.width)
    await expect(stalled.locator('[data-slot="run-need"] button')).toHaveCount(1)
    await expect(stalled.locator('[data-slot="run-ending"]')).toHaveCount(0)
    const workspace = page.locator('#run-view-flow')
    await selectRunView(workspace, 'Timeline')
    const header = runBar(workspace)
    const actions = workspace.locator('[data-slot="workbench-main"]').getByRole('button', { name: 'Stop run…', exact: true })
    const before = { header: await header.boundingBox(), actions: await actions.boundingBox() }
    await selectRunView(workspace, 'Flow')
    expect(await header.boundingBox()).toEqual(before.header)
    expect(await actions.boundingBox()).toEqual(before.actions)
    for (const width of [848, 768, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const geometry = await running.locator('[data-slot="run-scroll"]').evaluate(el => {
        const bounds = el.getBoundingClientRect()
        const reading = el.querySelector('[data-slot="run-reading"]')!.getBoundingClientRect()
        return { overflow: el.scrollWidth > el.clientWidth + 1, left: reading.left - bounds.left,
          right: bounds.right - reading.right, rowOverflow: [...el.querySelectorAll('[data-row]')].some(row => row.scrollWidth > row.clientWidth + 1),
          timeInset: [...el.querySelectorAll('[data-slot="run-time"]')].every(time => {
            const range = document.createRange()
            range.selectNodeContents(time)
            return !time.textContent || range.getBoundingClientRect().left >= reading.left
          }) }
      })
      expect(geometry.overflow).toBe(false)
      expect(geometry.rowOverflow).toBe(false)
      expect(geometry.left).toBeGreaterThanOrEqual(24)
      expect(geometry.right).toBeCloseTo(geometry.left, 1)
      expect(geometry.timeInset).toBe(true)
    }
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
    await selectRunView(flow, 'Timeline')
    const check = flow.locator('[data-row="check-2-2"]')
    await expect(check).toContainText('Verify')
    await expect(check).toHaveAttribute('data-step-row', 'verify')
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
    const team = page.locator('#run-view-live-polish-team')
    const members = await teamSeats(team)
    await expect(members.locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})})).toContainText('Edit · asked, not enforced')
    await expect(members.locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Beta',exact:true})})).toContainText('Read only')
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Timeline rings align with the first title line and motion respects the person in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?run-view&theme=${theme}`)
    const timeline = page.locator('#run-view-running [data-slot="timeline"]')
    await expect(timeline.locator(':scope > [data-slot="timeline-item"]')).toHaveCount(5)
    expect(await timeline.evaluate(el => [...el.children].every(child => child.tagName === 'LI'))).toBe(true)
    await expect(timeline.locator(':scope > [data-slot="timeline-section"]')).toHaveCount(2)
    for (const row of ['card-1-1', 'check-2-2', 'card-3-3', 'card-4-4']) {
      await expect(timeline.locator(`:scope > [data-slot="timeline-item"][data-row="${row}"]`)).toHaveCount(1)
    }
    const alignment = await timeline.locator('[data-slot="timeline-item"]').evaluateAll(items => items.map(item => {
      const ring = item.querySelector('[data-slot="timeline-indicator"]')!.getBoundingClientRect()
      const title = item.querySelector('[data-slot="timeline-heading"] button [data-slot="text"]')!
      const line = document.createRange()
      line.selectNodeContents(title)
      const first = line.getClientRects()[0]!
      return Math.abs((ring.top + ring.bottom - first.top - first.bottom) / 2)
    }))
    expect(alignment.every(delta => delta < 2)).toBe(true)
    const rails = await timeline.evaluate(el => {
      const children = [...el.children]
      const items = children.filter(child => child.getAttribute('data-slot') === 'timeline-item')
      return items.slice(0, -1).flatMap(item => {
        const rail = item.querySelector(':scope > [data-slot="timeline-rail"]')!
        if (getComputedStyle(rail).display === 'none') return []
        const line = rail.getBoundingClientRect(), box = item.getBoundingClientRect()
        const indicator = item.querySelector('[data-slot="timeline-indicator"]')!.getBoundingClientRect()
        return [Math.abs(line.bottom - box.bottom), Math.abs(line.top - indicator.bottom - 2)]
      })
    })
    expect(rails.every(delta => delta < 1)).toBe(true)
    const active = timeline.locator('[data-state="active"] > [data-slot="timeline-indicator"]')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await active.evaluate(el => getComputedStyle(el).animationName)).not.toBe('none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await active.evaluate(el => getComputedStyle(el).animationName)).toBe('none')
    await expect(page.locator('#run-view-stalled [data-row="check-4-4"]')).toHaveAttribute('data-state', 'warning')
    await expect(page.locator('#run-view-failed-check [data-row="check-4-4"]')).toHaveAttribute('data-state', 'danger')
    const retried = page.locator('#run-view-attempts [data-row="check-2-2"]')
    await expect(retried).toHaveAttribute('data-state', 'done')
    await expect(retried.locator('[data-slot="chip"][data-tone="success"]')).toHaveText('Pass')
    await retried.locator('button').click()
    await expect(page.locator('#run-view-attempts [data-slot="run-inspector"] [data-attempt="1"]')).toContainText('Failed')
    const stopped = page.locator('#run-view-stopped-mid-round [data-row="card-4-4"]')
    await expect(stopped).toHaveAttribute('data-state', 'pending')
    await expect(stopped).toContainText('Stopped')
    await stopped.locator('button').click()
    await expect(page.locator('#run-view-stopped-mid-round [data-slot="run-inspector"] [aria-label="Round 4"]')).toContainText('0 of 1 answered')
    const waiting = page.locator('#run-view-waiting-evidence [data-row="card-4-4"]')
    await expect(waiting).toHaveAttribute('data-state', 'warning')
    await expect(page.locator('#run-view-waiting-evidence [data-slot="run-need"]')).toContainText('Waiting for 2 open blocking findings')
    const borders = await timeline.locator(':scope > li').evaluateAll(items => items.map(item => getComputedStyle(item).borderTopWidth))
    expect(borders.every(width => width === '0px')).toBe(true)
  })
}
