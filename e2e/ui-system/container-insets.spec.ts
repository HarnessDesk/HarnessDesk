import { expect, test } from '@playwright/test'

/** Surface edges, rather than a snapshot of one utility spelling. Full-bleed
 * viewports and small controls have their own geometry; these are content
 * containers with an inset tier (docs/design.md). */
const contracts = [
  { selector: '[data-slot="composer-tail"] > *', tier: 'row' },
  { selector: '[data-slot="board-column"]', tier: 'dense' },
  { selector: '[data-slot="board-card"]', tier: 'card' },
  { selector: '[data-slot="bubble"][data-variant="secondary"]', tier: 'card' },
  { selector: '[data-slot="agent-card-band"]', tier: 'row' },
  { selector: '[data-slot="inspector-group"]', tier: 'dense', inlineTier: 'row' },
  { selector: '[data-slot="section"][data-variant="panel"]', tier: 'row' },
  { selector: '[data-slot="approval-code"]', tier: 'row' },
  { selector: '[data-slot="list-row"][data-size="default"]:not([data-hd-table="compact"])', tier: 'row' },
  { selector: '[data-slot="list-row"][data-size="default"][data-hd-table="compact"]:not(:has([data-wrap-title], [data-wrap-subtitle]))', tier: 'row', blockInset: 1 },
  { selector: '[data-slot="list-row"][data-size="default"][data-hd-table="compact"]:has([data-wrap-title], [data-wrap-subtitle])', tier: 'dense', inlineTier: 'row' },
  { selector: '[data-slot="chart-card"]', tier: 'card' },
  { selector: '[data-slot="row"]:has([data-slot="row-desc"], [data-slot="row-mark"], [data-slot="row-face"])', tier: 'row' },
  { selector: '[data-slot="row"]:not(:has([data-slot="row-desc"], [data-slot="row-mark"], [data-slot="row-face"]))', tier: 'row', blockInset: 8 },
  { selector: '[data-slot="summary-item"]', tier: 'row' },
] as const

const readInsets = (contracts: readonly { selector: string; tier: string; inlineTier?: string; blockInset?: number }[]) => {
  const visible = (element: Element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    && !element.closest('.sr-only, [hidden]')
  const contents = (element: Element): DOMRect[] => {
    const rects: DOMRect[] = []
    const walk = (node: Node): void => {
      if (node instanceof Element) {
        if (!visible(node)) return
        // A floating overlay is not content inside its DOM host's edge.
        if (node !== element && ['absolute', 'fixed'].includes(getComputedStyle(node).position)) return
        // A transparent hit target is deliberately larger than its ink.
        // Painted buttons contribute their whole visible box instead.
        const style = getComputedStyle(node)
        const painted = (color: string) => color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)'
        const paintedButton = node.matches('button') && (painted(style.backgroundColor)
          || ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
            && painted(style.getPropertyValue(`border-${side.toLowerCase()}-color`))))
        if (node !== element && (paintedButton || node.matches('svg, img, input, textarea, canvas, [data-slot="row-mark"], [data-slot="icon-tile"], [data-shape="face"], [data-slot="avatar"], [data-slot="dot"]'))) {
          rects.push(node.getBoundingClientRect()); return
        }
      }
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
        const parent = node.parentElement!
        const css = getComputedStyle(parent)
        const range = document.createRange(); range.selectNodeContents(node)
        // A figure set on line-height: 1 owns a line box smaller than
        // the font's em rectangle (Range includes the unused em area).
        const boxes = parseFloat(css.lineHeight) <= parseFloat(css.fontSize) && css.display !== 'inline'
          ? [parent.getBoundingClientRect()] : [...range.getClientRects()]
        for (const box of boxes) {
          let { left, right, top, bottom } = box
          for (let ancestor: Element | null = parent; ancestor && ancestor !== element; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect()
            if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)) {
              left = Math.max(left, clip.left); right = Math.min(right, clip.right)
            }
            if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)) {
              top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom)
            }
          }
          if (right > left && bottom > top) rects.push(new DOMRect(left, top, right - left, bottom - top))
        }
      } else for (const child of node.childNodes) walk(child)
    }
    walk(element)
    const css = getComputedStyle(element), viewport = element.getBoundingClientRect()
    return rects.map(rect => {
      const clipped = (overflow: string) => ['hidden', 'clip', 'auto', 'scroll'].includes(overflow)
      const left = clipped(css.overflowX) ? Math.max(rect.left, viewport.left) : rect.left
      const right = clipped(css.overflowX) ? Math.min(rect.right, viewport.right) : rect.right
      const top = clipped(css.overflowY) ? Math.max(rect.top, viewport.top) : rect.top
      const bottom = clipped(css.overflowY) ? Math.min(rect.bottom, viewport.bottom) : rect.bottom
      return new DOMRect(left, top, right - left, bottom - top)
    }).filter(rect => rect.width > 0 && rect.height > 0)
  }
  return contracts.map(({ selector, tier, inlineTier, blockInset }) => {
    const probe = document.createElement('div')
    probe.style.padding = `var(--hd-inset-${tier})`
    document.body.append(probe)
    const minimum = parseFloat(getComputedStyle(probe).paddingLeft)
    probe.style.padding = `var(--hd-inset-${inlineTier ?? tier})`
    const inlineMinimum = parseFloat(getComputedStyle(probe).paddingLeft)
    probe.remove()
    const expectedPadding = [blockInset ?? minimum, inlineMinimum, blockInset ?? minimum, inlineMinimum]
    return { selector, minimum, expectedPadding, boxes: [...document.querySelectorAll(selector)].filter(visible).map(element => {
      const css = getComputedStyle(element), box = element.getBoundingClientRect(), content = contents(element)
      return {
        label: element.textContent?.slice(0, 100),
        height: box.height,
        rowFloor: element.matches('[data-slot="list-row"][data-hd-table="compact"]')
          ? parseFloat(css.getPropertyValue(element.querySelector('[data-slot="list-row-subtitle"], [data-slot="list-row-lead"]') ? '--hd-table-row-min' : '--hd-table-row-min-bare'))
          : null,
        padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(parseFloat),
        insets: content.length ? [
          Math.min(...content.map(rect => rect.top)) - box.top,
          box.right - Math.max(...content.map(rect => rect.right)),
          box.bottom - Math.max(...content.map(rect => rect.bottom)),
          Math.min(...content.map(rect => rect.left)) - box.left,
        ] : null,
      }
    }) }
  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 720]) {
  test(`known content containers keep their tier in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.route('**/src/preview/main.tsx*', async route => {
      const response = await route.fetch(), source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('preview React import missing')
      await route.fulfill({ response, body: `${source}
        import insetReact from ${JSON.stringify(reactUrl)};
        import { SummaryList as InsetSummary, SummaryItem as InsetFact, AgentCard as InsetAgentCard, ApprovalDialog as InsetApproval, ApprovalReason as InsetReason, ApprovalCode as InsetCode } from '/src/design/index.ts';
        import { ListRow as InsetListRow, Row as InsetRow, Rows as InsetRows, IconTile as InsetTile, Button as InsetButton } from '/src/design/index.ts';
        import { AlertIcon as InsetWarning } from '/src/components/Icons.tsx';
        const rowHost = document.createElement('section');
        rowHost.style.width = '360px'; document.body.append(rowHost);
        createRoot(rowHost).render(insetReact.createElement(InsetRows, null,
          insetReact.createElement(InsetRow, { title: 'Jane Doe', face: insetReact.createElement(InsetTile, { shape: 'face' }, 'J') }),
          insetReact.createElement(InsetRow, { title: 'Choose a folder', control: insetReact.createElement(InsetButton, { size: 'sm' }, 'Choose…') })));
        const singleHost = document.createElement('section');
        singleHost.style.width = '240px'; document.body.append(singleHost);
        createRoot(singleHost).render(insetReact.createElement(InsetListRow, {
          density: 'compact', title: 'Review', 'data-inset-probe': 'single',
        }));
        const wrappedHost = document.createElement('section');
        wrappedHost.style.width = '240px'; document.body.append(wrappedHost);
        createRoot(wrappedHost).render(insetReact.createElement(InsetListRow, {
          density: 'compact', wrapSubtitle: true, title: 'Review',
          subtitle: 'Review the whole declaration before arming this trigger again.',
          'data-inset-probe': 'wrapped',
        }));
        const insetHost = document.createElement('section');
        insetHost.style.width = '360px'; document.body.append(insetHost);
        createRoot(insetHost).render(insetReact.createElement(InsetSummary, null,
          insetReact.createElement(InsetFact, { label: 'Plan' }, 'Monthly')));
        const cautionHost = document.createElement('section');
        cautionHost.style.width = '360px'; document.body.append(cautionHost);
        createRoot(cautionHost).render(insetReact.createElement(InsetAgentCard, { subject: {
          kind: 'member', name: 'Alpha', tint: 'blue', mark: insetReact.createElement(InsetWarning),
          cautions: [
            { tone: 'danger', text: 'Cannot take jobs until the board tools are available.' },
            { tone: 'warning', text: 'The context budget is nearly full.' },
            { tone: 'quiet', text: 'Has not taken a job in this Run.' },
          ],
        } }));
        for (const placement of ['overlay', 'docked']) {
          const approvalHost = document.createElement('section');
          approvalHost.style.cssText = 'position:relative;width:580px;max-width:100%;height:400px';
          document.body.append(approvalHost);
          createRoot(approvalHost).render(insetReact.createElement(InsetApproval, {
            placement, title: 'Run this command?', icon: insetReact.createElement(InsetWarning), focused: false, focusKey: placement,
            actions: [{ id: 'allow', label: 'Allow', shortcut: 1, placement: 'proceed', onSelect: () => {} }],
          }, insetReact.createElement(InsetReason, null, 'Check the checkout before continuing.'),
            insetReact.createElement(InsetCode, null, 'pnpm verify')));
        }
      ` })
    })
    await page.goto(`/preview.html?team-overview&theme=${theme}`)
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('[data-frame-id="goal-roster"] [data-slot="composer-tail"]')).toBeAttached()
    await expect(page.locator('[data-slot=approval-dialog-scope] [role=dialog]')).toBeVisible()
    await expect(page.locator('[data-slot="agent-card-band"]').filter({ hasText: 'The context budget is nearly full.' })).toBeVisible()
    const bareControl = page.locator('[data-slot="row"]').filter({ hasText: 'Choose a folder' })
    const bareGeometry = await bareControl.evaluate(element => ({
      row: element.getBoundingClientRect().height,
      control: element.querySelector('button')!.getBoundingClientRect().height,
    }))
    expect(bareGeometry).toEqual({ row: 44, control: 28 })
    const wrapped = page.locator('[data-inset-probe="wrapped"]')
    await expect(wrapped).toBeVisible()
    const wrappedGeometry = await wrapped.evaluate(element => {
      const subtitle = element.querySelector('[data-slot="list-row-subtitle"]')!
      const css = getComputedStyle(subtitle)
      return subtitle.getBoundingClientRect().height / parseFloat(css.lineHeight)
    })
    expect(wrappedGeometry).toBeGreaterThan(1)
    const wrappedReading = (await page.evaluate(readInsets, [{ selector: '[data-inset-probe="wrapped"]', tier: 'dense', inlineTier: 'row' }]))[0]!
    expect(wrappedReading.boxes[0]!.padding).toEqual(wrappedReading.expectedPadding)
    expect(wrappedReading.boxes[0]!.insets!.every((value, side) => value >= wrappedReading.expectedPadding[side]! - 2)).toBe(true)
    const readings = await page.evaluate(readInsets, contracts)
    const faults: string[] = []
    for (const { selector, expectedPadding, boxes } of readings) {
      expect(boxes.length, `${selector} must have shipped coverage`).toBeGreaterThan(0)
      for (const box of boxes) {
        if (box.padding.some((value, side) => Math.abs(value - expectedPadding[side]!) > (box.rowFloor != null ? 0.5 : 1))) faults.push(`${selector}: padding ${box.padding} differs from ${expectedPadding}`)
        if (Math.abs(box.padding[0]! - box.padding[2]!) > 1) faults.push(`${selector}: asymmetric vertical inset ${box.padding}`)
        if (box.rowFloor != null && box.height < box.rowFloor) faults.push(`${selector}: height ${box.height} < ${box.rowFloor}`)
        // Ranges include font ascenders outside a line's nominal box. Two
        // pixels allow that ink overhang, while zero padding still fails.
        if (box.insets?.some((value, side) => value < expectedPadding[side]! - 2)) faults.push(`${selector}: content insets ${box.insets} < ${expectedPadding}: ${box.label}`)
      }
    }
    expect(faults).toEqual([])
    // The approval's hanging mark shares a text column with the body;
    // its outer edge is modal in an overlay and card-sized when docked.
    for (const surface of await page.evaluate(readInsets, [
      { selector: '[data-slot="approval-dialog-scope"] [role="dialog"]', tier: 'dialog' },
      { selector: '[data-slot="approval-card"]', tier: 'card' },
    ])) {
      expect(surface.boxes.length, surface.selector).toBeGreaterThan(0)
      for (const box of surface.boxes) expect(box.insets?.every(value => value >= surface.minimum - 2), `${surface.selector}: ${box.insets}`).toBe(true)
    }
  })
}

for (const theme of ['light', 'dark'] as const) for (const width of [1440, 720]) {
  test(`dialog parts share the modal inset in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript(() => {
      Object.assign(window, { __hdCliInstallDialog: {
        menuLabel: 'Install command-line tool…',
        request: { message: 'Install the command-line tool?', detail: 'The launcher goes in a folder you own.', buttons: ['Install', 'Cancel'] },
      } })
    })
    for (const [query, selectors] of [
      ['cli-install', ['[data-slot="dialog-content"]']],
      ['run-again=default', ['[data-slot="dialog-head"]', '[data-slot="modal-dialog-body"]', '[data-slot="dialog-footer"]']],
      ['stop-run-dialog=default', ['[data-slot="alert-dialog-header"]', '[data-slot="confirm-body"]', '[data-slot="alert-dialog-footer"]']],
    ] as const) {
      await page.goto(`/preview.html?${query}&theme=${theme}`)
      for (const selector of selectors) {
        const part = page.locator(selector).last()
        await expect(part).toBeVisible()
        const reading = await part.evaluate(element => {
          const css = getComputedStyle(element)
          const probe = document.createElement('div'); probe.style.padding = 'var(--hd-inset-dialog)'; element.append(probe)
          const tier = parseFloat(getComputedStyle(probe).paddingLeft); probe.remove()
          return { tier, scrolling: element.scrollHeight > element.clientHeight, sides: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft].map(parseFloat) }
        })
        expect(reading.sides, `${query}: ${selector}`).toEqual(Array(4).fill(reading.tier))
        const visibleContent = (await page.evaluate(readInsets, [{ selector, tier: 'dialog' }]))[0]!.boxes.at(-1)!
        expect(visibleContent.insets?.every((value, side) => reading.scrolling && (side === 0 || side === 2) || value >= reading.tier - 2), `${query}: ${selector} content ${visibleContent.insets}`).toBe(true)
      }
    }
  })
}

test('the inset guard detects zero padding and content escaping otherwise correct padding', async ({ page }) => {
  await page.setContent(`<style>
    :root { --hd-inset-row: 12px; font: 14px/20px sans-serif; }
    #surface { width: 200px; padding: var(--hd-inset-row); border: 1px solid; }
  </style><div id="surface"><div>Content</div></div>`)
  const policy = [{ selector: '#surface', tier: 'row' }]
  const correct = (await page.evaluate(readInsets, policy))[0]!
  expect(correct.boxes[0]!.padding).toEqual([12, 12, 12, 12])
  expect(correct.boxes[0]!.insets!.every(value => value >= correct.minimum - 2)).toBe(true)
  await page.locator('#surface').evaluate(element => { (element as HTMLElement).style.padding = '0' })
  const zero = (await page.evaluate(readInsets, policy))[0]!
  expect(zero.boxes[0]!.padding).toEqual([0, 0, 0, 0])
  expect(zero.boxes[0]!.insets![3]).toBeLessThan(zero.minimum - 2)
  await page.locator('#surface').evaluate(element => {
    (element as HTMLElement).style.padding = 'var(--hd-inset-row)'
    ;(element.firstElementChild as HTMLElement).style.marginLeft = 'calc(-1 * var(--hd-inset-row))'
  })
  const escaped = (await page.evaluate(readInsets, policy))[0]!
  expect(escaped.boxes[0]!.padding).toEqual([12, 12, 12, 12])
  expect(escaped.boxes[0]!.insets![3]).toBeLessThan(escaped.minimum - 2)
})


for (const theme of ['light', 'dark'] as const) for (const width of [1440, 720]) {
  test(`Run inspector and Team Overview share their content edges in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/preview.html?run-inspector&team-overview&theme=${theme}`)
    const frame = page.locator('#run-inspector-run')
    if (width === 720) await frame.getByRole('button', { name: 'Run details', exact: true }).click()
    const inspector = frame.locator('[data-slot="run-inspector"]')
    await expect(inspector).toBeVisible()
    const edges = await inspector.evaluate(element => {
      const title = element.querySelector('[data-slot="inspector-tools"] [data-slot="text"]')!
      const label = element.querySelector('[data-slot="inspector-body"] [data-slot="group-label"]')!
      const prose = element.querySelector('[data-slot="inspector-body"] [data-slot="text"]')!
      return [title, label, prose].map(node => node.getBoundingClientRect().left - element.getBoundingClientRect().left)
    })
    expect(edges).toEqual([24, 24, 24])
    if (width === 720) await frame.getByRole('button', { name: 'Run timeline', exact: true }).click()
    await expect(frame.locator('[data-slot="run-header"]').getByRole('button', { name: 'Run details', exact: true })).toBeVisible()
    const overview = page.locator('#team-overview-answer-approval [data-slot="team-overview"]')
    await expect(overview).toBeVisible()
    const layout = await overview.evaluate(element => {
      const run = element.querySelector('section[aria-label="Run"]')!
      const needs = element.querySelector('section[aria-label="Needs you"]')!
      const seats = element.querySelector('section[aria-label="Seats"]')!
      const start = (node: Element) => {
        const range = document.createRange(); range.selectNodeContents(node)
        return Math.round((node.matches('[data-slot=table-head]') ? range.getBoundingClientRect().left : node.getBoundingClientRect().left) - element.getBoundingClientRect().left)
      }
      return { run: start(run), labels: [needs, seats].map(section => start(section.querySelector('[data-slot="group-label"]')!)),
        bodies: [needs, seats].map(section => start(section.querySelector('[data-slot="list-row-lead"], [data-slot="list-row-title"], [data-slot="table-head"]')!)) }
    })
    for (const edge of [...layout.labels, ...layout.bodies]) expect(Math.abs(edge - layout.run)).toBeLessThanOrEqual(1)
    const emptyOverview = page.locator('#team-overview-no-seats [data-slot="team-overview"]')
    await expect(emptyOverview).toBeVisible()
    const emptyEdges = await emptyOverview.evaluate(element => {
      const section = element.querySelector('section[aria-label="Seats"]')!
      const head = section.querySelector('[data-slot="section-head"]')!
      const label = head.querySelector('[data-slot="group-label"]')!
      const empty = section.querySelector('[data-slot="empty-state"]')!
      const range = document.createRange(); range.selectNodeContents(empty)
      const text = range.getBoundingClientRect(), bounds = empty.getBoundingClientRect()
      const style = getComputedStyle(head), headBounds = head.getBoundingClientRect()
      return { label: label.getBoundingClientRect().left, text: text.left,
        right: headBounds.right - parseFloat(style.paddingRight), bodyRight: bounds.right,
        gutter: section.getBoundingClientRect().left - element.getBoundingClientRect().left }
    })
    expect(emptyEdges.gutter).toBe(24)
    expect(Math.abs(emptyEdges.text - emptyEdges.label)).toBeLessThanOrEqual(1)
    expect(Math.abs(emptyEdges.bodyRight - emptyEdges.right)).toBeLessThanOrEqual(1)
  })
}


test('the guard includes the whole face tile when measuring visible content', async ({ page }) => {
  await page.setContent(`<style>
    :root { --hd-inset-row: 12px; }
    #surface { width: 200px; padding: var(--hd-inset-row); border: 1px solid; }
    #face { display: flex; box-sizing: border-box; width: 32px; height: 32px; padding: 8px;
      background: gray; margin-left: calc(var(--hd-inset-row) / -3); }
  </style><div id="surface"><div id="face" data-shape="face">
    <svg width="16" height="16"><rect width="16" height="16" /></svg>
  </div></div>`)
  const reading = (await page.evaluate(readInsets, [{ selector: '#surface', tier: 'row' }]))[0]!
  expect(reading.boxes[0]!.padding).toEqual([12, 12, 12, 12])
  expect(reading.boxes[0]!.insets![3]).toBeLessThan(reading.minimum - 2)
})

test('the guard includes the whole nested button when measuring visible content', async ({ page }) => {
  await page.setContent(`<style>
    :root { --hd-inset-row: 12px; }
    #surface { width: 200px; padding: var(--hd-inset-row); border: 1px solid; }
    button { display: flex; box-sizing: border-box; width: 32px; height: 32px;
      border: 0; padding: 8px; background: gray; margin-left: calc(var(--hd-inset-row) / -3); }
  </style><div id="surface"><button aria-label="Action">
    <svg width="16" height="16"><rect width="16" height="16" /></svg>
  </button></div>`)
  const reading = (await page.evaluate(readInsets, [{ selector: '#surface', tier: 'row' }]))[0]!
  expect(reading.boxes[0]!.padding).toEqual([12, 12, 12, 12])
  expect(reading.boxes[0]!.insets![3]).toBeLessThan(reading.minimum - 2)
})

test('an invisible button hit target does not replace its visible glyph in the union', async ({ page }) => {
  await page.setContent(`<style>
    :root { --hd-inset-row: 12px; }
    #surface { width: 200px; padding: var(--hd-inset-row); border: 1px solid; }
    button { display: flex; box-sizing: border-box; width: 32px; height: 32px;
      border: 0; padding: 8px; background: transparent; margin-left: calc(var(--hd-inset-row) / -2); }
  </style><div id="surface"><button aria-label="Action">
    <svg width="16" height="16"><rect width="16" height="16" /></svg>
  </button></div>`)
  const reading = (await page.evaluate(readInsets, [{ selector: '#surface', tier: 'row' }]))[0]!
  expect(reading.boxes[0]!.insets![3]).toBeGreaterThanOrEqual(reading.minimum - 2)
})
