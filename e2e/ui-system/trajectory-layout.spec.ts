import { expect, test } from '@playwright/test'

type Harness = typeof import('../../packages/ui/src/preview/harness')

/**
 * What `packages/ui/src/preview/main.tsx` hands a spec: the store the page
 * mounted, and the session its frames read.
 *
 * A spec reaches the store through this and never by importing the harness
 * itself. Once Vite has hot-reloaded `harness.tsx` (or a module it imports) the
 * page runs `harness.tsx?t=…`, and the bare URL is a second module instance
 * with a second store: the spec would stage state in a store no frame
 * mounted, and read the page's own, unchanged (#1313).
 */
type PreviewBridge = {
  store: Harness['store'] & { patch(partial: object): void }
  sessionKey: Harness['PREVIEW_SESSION_KEY']
}

/** The real TrajectoryView on the preview desk, with a staged two-turn ledger. */
test('trajectory rows wrap, fold reasoning, avoid text collisions, and reconcile time', async ({ page }) => {
  const longThinking = 'The reasoning thought is a full sentence that should wrap across the trajectory row while keeping its complete wording available on hover at narrow widths.'
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForFunction(() => '__hdPreview' in window)
  await page.evaluate((longThinking) => {
    const { store, sessionKey: PREVIEW_SESSION_KEY } = (window as unknown as { __hdPreview: PreviewBridge }).__hdPreview
    const snapshot = store.getSnapshot()
    const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)!
    const longSentence = 'The worktree list has several branches that were deleted upstream, and this full explanation should wrap across the trajectory row so a person can read what happened without opening another surface. '.repeat(2)
    const base = session.turns[0]!
    const baseItems = base.items.map((item) => {
      if (item.type === 'command') return { ...item, durationMs: 18 * 60_000 }
      if (item.type === 'assistantMessage') return { ...item, text: longSentence }
      if (item.type === 'reasoning' && item.summary.length === 0 && item.content.length > 0) {
        return { ...item, content: [longThinking] }
      }
      return item
    })
    const emptyReasoning = baseItems.find((item) => item.type === 'reasoning' && item.summary.length === 0)!
    const emptyRun = Array.from({ length: 3 }, (_, index) => ({
      ...emptyReasoning,
      id: `empty-reasoning-${index}`,
      summary: [],
      content: [],
    }))
    const foldedItems = baseItems.flatMap((item) => item.type === 'command' ? [...emptyRun, item] : [item])
    const staged = {
      ...base,
      durationMs: 30 * 60_000,
      items: foldedItems,
    }
    const turns = [staged, {
      ...staged,
      id: 'trajectory-e2e-2',
      items: staged.items.map((item) => ({ ...item, id: `${item.id}-2` })),
    }]
    const sessions = new Map(snapshot.sessions)
    sessions.set(PREVIEW_SESSION_KEY, { ...session, turns } as never)
    store.patch({ sessions })
  }, longThinking)

  const panel = page.locator('[data-frame-id="panel-trajectory"]')
  await expect(panel.locator('[data-slot="inspector-group"]').filter({ hasText: 'Where the time went' })).toContainText('60m · 36m in commands')
  const rows = panel.locator('[data-slot="inspector-row"]')
  const folded = rows.filter({ hasText: '3 steps, no summary given' })
  await expect(folded).toHaveCount(2)
  await expect(rows.filter({ hasText: 'ThinkingThinking' })).toHaveCount(0)
  const thinking = rows.filter({ hasText: 'The reasoning thought is a full sentence' }).first()
  await expect(thinking).toBeVisible()
  await expect(thinking).toHaveAttribute('title', longThinking)

  const assistant = panel.locator('[class*="messageLabel"]').filter({ hasText: 'several branches that were deleted upstream' }).first()
  await expect(assistant).toBeVisible()
  const wrap = await assistant.evaluate((element) => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(element)
    const lineTops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)))
    return {
      whiteSpace: style.whiteSpace,
      display: style.display,
      flex: style.flex,
      clamp: style.webkitLineClamp,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      height: box.height,
      lineHeight: Number.parseFloat(style.lineHeight),
      lines: lineTops.size,
      parent: (element.parentElement as HTMLElement).getAttribute('class'),
      parentWidth: element.parentElement?.getBoundingClientRect().width,
    }
  })
  expect(wrap.whiteSpace).toBe('normal')
  expect(wrap.clamp).toBe('3')
  expect(wrap.scrollWidth).toBeLessThanOrEqual(wrap.clientWidth)
  expect(wrap.lines).toBeGreaterThan(1)
  expect(wrap.height).toBeLessThanOrEqual(wrap.lineHeight * 3 + 1)

  const geometry = await panel.evaluate((root) => {
    const boxes = [...root.querySelectorAll<HTMLElement>(
      '[data-slot="inspector-group"] [data-role], [data-slot="inspector-row"] [class*="role"], [data-slot="inspector-row"] [class*="label"], [data-slot="inspector-row"] [data-slot="row-time"], [data-slot="chart-key"], [data-slot="progress-stack-row"]',
    )].filter((element) => element.getClientRects().length > 0).map((element) => {
      const rect = element.getBoundingClientRect()
      return { text: element.textContent?.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    const intersections: string[] = []
    for (let a = 0; a < boxes.length; a += 1) for (let b = a + 1; b < boxes.length; b += 1) {
      const one = boxes[a]!
      const two = boxes[b]!
      if (one.left < two.right && one.right > two.left && one.top < two.bottom && one.bottom > two.top) {
        intersections.push(`${one.text} / ${two.text}`)
      }
    }
    const parts = [...root.querySelectorAll<HTMLElement>('[aria-label="Time by kind of step"] [data-slot="progress-stack-part"]')]
    return { intersections, widths: parts.map((part) => Number.parseFloat(part.style.width)) }
  })
  expect(geometry.intersections).toEqual([])
  expect(geometry.widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 5)

  await page.setViewportSize({ width: 900, height: 1100 })
  // The static preview frame has no Workbench resize/zoom controls, so check
  // the same row at a docked width and at the full viewport content width.
  for (const state of [
    { name: 'expanded', width: 538 },
    { name: 'zoomed', width: 868 },
  ]) {
    await panel.evaluate((root, width) => {
      ;(root as HTMLElement).style.width = `${width}px`
      ;(root as HTMLElement).style.maxWidth = 'none'
    }, state.width)
    const reasoning = rows.filter({ hasText: 'The reasoning thought is a full sentence' }).first()
    await expect(reasoning, `${state.name} Thinking row`).toBeVisible()
    const layout = await reasoning.locator('[class*="messageLabel"]').evaluate((element) => {
      const style = getComputedStyle(element)
      const range = document.createRange()
      range.selectNodeContents(element)
      return {
        whiteSpace: style.whiteSpace,
        clamp: style.webkitLineClamp,
        textOverflow: style.textOverflow,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
        fullText: (element.closest('[data-slot="inspector-row"]') as HTMLElement).title,
      }
    })
    expect(layout.whiteSpace, state.name).toBe('normal')
    expect(layout.clamp, state.name).toBe('3')
    expect(layout.textOverflow, state.name).toBe('clip')
    expect(layout.scrollWidth, state.name).toBeLessThanOrEqual(layout.clientWidth)
    expect(layout.lines, state.name).toBeGreaterThan(1)
    expect(layout.lines, state.name).toBeLessThanOrEqual(3)
    expect(layout.fullText, state.name).toBe(longThinking)
  }
})
