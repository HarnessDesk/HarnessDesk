import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const capturePhase = process.env.HD_TABLES_FRAMES_PHASE
const captureDirectory = '/tmp/tables-f1/repair-frames'

for (const theme of ['light', 'dark'] as const) {
  test(`long check commands remain fully readable at narrow width in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 412, height: 1000 })
    await page.goto('/preview.html?compact-panels')
    await page.evaluate(() => document.fonts.ready)
    const frame = page.locator('[data-frame-id="project-checks-long-command"]')
    const command = frame.locator('[data-slot="code-text"]').nth(1)
    await expect(command).toContainText('--reporter verbose')
    if (capturePhase) {
      await mkdir(captureDirectory, { recursive: true })
      await expect(page.locator('[data-frame-id="project-checks"] [data-slot="list-row"]')).toHaveCount(4)
      await page.evaluate(() => {
        const preview = (window as unknown as { __hdPreview: { store: { patch(value: unknown): void } } }).__hdPreview
        preview.store.patch({ home: '/home/dev' })
      })
      for (const id of ['project-checks', 'project-checks-long-command']) {
        await page.locator(`[data-frame-id="${id}"]`).screenshot({ path: `${captureDirectory}/${capturePhase}-${id}-${theme}.png` })
      }
    }
    const reading = await command.evaluate(node => {
      const subtitle = node.parentElement!
      const box = subtitle.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = [...range.getClientRects()]
      return {
        whiteSpace: getComputedStyle(subtitle).whiteSpace,
        size: getComputedStyle(node).fontSize,
        lines: new Set(rects.map(rect => rect.top)).size,
        contained: rects.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1),
      }
    })
    expect(reading.whiteSpace).toBe('normal')
    expect(reading.size).toBe('12px')
    expect(reading.lines).toBeGreaterThan(1)
    expect(reading.contained).toBe(true)
    await expect(frame.locator('[data-slot="list-row-trail"]')).toHaveText(['Approved', 'Changed', 'Not approved', 'Not offered'])
  })

  test(`unbroken attachment refusal tokens wrap inside their row in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 412, height: 1000 })
    await page.goto('/preview.html?compact-panels')
    await page.evaluate(() => document.fonts.ready)
    const frame = page.locator('[data-frame-id="panel-seat-attachments"]')
    const reason = frame.locator('[data-role="meta"]').filter({ hasText: 'Refused attachment:' })
    await expect(reason).toContainText('narrow_inspector.')
    if (capturePhase) {
      await mkdir(captureDirectory, { recursive: true })
      await frame.screenshot({ path: `${captureDirectory}/${capturePhase}-panel-seat-attachments-${theme}.png` })
    }
    const reading = await reason.evaluate(node => {
      const row = node.closest('[data-slot="inspector-row"]')!
      const box = node.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(node)
      const rects = [...range.getClientRects()]
      return {
        overflowWrap: getComputedStyle(node).overflowWrap,
        contained: rects.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1),
        rowFits: row.scrollWidth <= row.clientWidth,
      }
    })
    expect(reading.overflowWrap).toBe('anywhere')
    expect(reading.contained).toBe(true)
    expect(reading.rowFits).toBe(true)
  })

  test(`compact inspectors keep their faces and readings centred in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 412, height: 1000 })
    await page.goto('/preview.html?compact-panels')
    await page.evaluate(() => document.fonts.ready)
    const agents = page.locator('[data-frame-id="panel-agents"]')
    await expect(agents.locator('[data-slot="inspector-row"]')).toHaveCount(2)
    const panels = ['panel-activity', 'panel-agents', 'panel-trajectory', 'panel-changes', 'panel-background-tasks', 'panel-seat-attachments']
    for (const id of panels) {
      const frame = page.locator(`[data-frame-id="${id}"]`)
      const readings = await frame.locator('[data-slot="inspector-row"]').evaluateAll(rows => rows.map(row => {
        const box = row.getBoundingClientRect()
        const style = getComputedStyle(row)
        const mark = row.querySelector('[data-slot="inspector-row-mark"]')
        const title = row.querySelector('[data-role="row"]')
        const trailing = row.lastElementChild
        const middle = (node: Element) => { const rect = node.getBoundingClientRect(); return rect.y + rect.height / 2 }
        return {
          align: style.alignItems, inset: parseFloat(style.paddingLeft), height: box.height,
          minimum: title?.parentElement?.querySelector('[data-role=meta]') ? 40 : 32,
          markSize: mark?.getBoundingClientRect().width,
          markRadius: mark ? getComputedStyle(mark).borderRadius : undefined,
          nameSize: title ? getComputedStyle(title).fontSize : null,
          nameWeight: title ? getComputedStyle(title).fontWeight : null,
          markOffset: mark ? Math.abs(middle(mark) - middle(row)) : 0,
          trailingOffset: trailing && trailing !== title?.parentElement ? Math.abs(middle(trailing) - middle(row)) : 0,
        }
      }))
      expect(readings.length, id).toBeGreaterThan(0)
      for (const row of readings) {
        expect(row.align, id).toBe('center')
        expect(row.inset, id).toBe(12)
        expect(row.height, id).toBeGreaterThanOrEqual(row.minimum)
        if (row.markSize !== undefined) {
          expect(row.markSize, id).toBe(24)
          expect(row.markRadius, id).toBe('6px')
        }
        expect(row.nameSize, id).toBe('13px')
        expect(row.nameWeight, id).toBe('500')
        expect(row.markOffset, id).toBeLessThanOrEqual(1)
        expect(row.trailingOffset, id).toBeLessThanOrEqual(1)
      }
    }
    const bare = page.locator('[data-frame-id=panel-seat-attachments] [data-slot=inspector-row]').first()
    expect(await bare.evaluate(row => row.getBoundingClientRect().height)).toBe(32)
    const checks = page.locator('[data-frame-id="project-checks"] [data-slot="list-row"]')
    await expect(checks).toHaveCount(4)
    expect(await checks.locator('[data-slot="list-row-trail"]').allTextContents()).toEqual(['Approved', 'Changed', 'Not approved', 'Not offered'])
    const triggers = page.locator('[data-frame-id="project-triggers"]')
    await expect(triggers.locator('[role="switch"]')).toHaveCount(3)
    await expect(triggers.locator('[data-slot="chip"]')).toHaveCount(0)
    await expect(triggers.getByRole('button', { name: 'History', exact: true })).toHaveCount(3)
    const emptyCells = page.locator('[data-frame-id="plugin-panel-table"] tbody td').filter({ hasText: '—' })
    await expect(emptyCells).toHaveCount(2)
  })
}
